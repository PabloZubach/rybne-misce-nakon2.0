// «Рибне місце» — сервер сайту: меню, бронювання, замовлення з собою, адмін-панель
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------- Налаштування ----------
loadEnv(path.join(__dirname, '.env'));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'site.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY, category_id INTEGER, name TEXT NOT NULL, description TEXT DEFAULT '',
  weight TEXT DEFAULT '', price INTEGER NOT NULL, photo TEXT DEFAULT '', available INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tables_ (id INTEGER PRIMARY KEY, name TEXT NOT NULL, seats INTEGER NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, table_id INTEGER, date TEXT, time TEXT, guests INTEGER, name TEXT, phone TEXT,
  comment TEXT DEFAULT '', status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, items TEXT, total INTEGER, pickup_time TEXT, name TEXT, phone TEXT,
  comment TEXT DEFAULT '', status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY, photo TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER);
`);
function getSetting(k) { return (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || ''; }
function setSetting(k, v) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? '')); }
seed();

// ---------- Застосунок ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + extOf(file.mimetype)),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
function extOf(m) { return m === 'image/png' ? '.png' : m === 'image/webp' ? '.webp' : '.jpg'; }

// ---------- Публічне API (для гостей) ----------
const PUBLIC_SETTINGS = ['name', 'tagline', 'address', 'phone', 'hours', 'open_time', 'close_time', 'hero_photo', 'instagram', 'tiktok', 'maps_url', 'booking_enabled', 'takeaway_enabled'];

app.get('/api/site', (req, res) => {
  const settings = {};
  for (const k of PUBLIC_SETTINGS) settings[k] = getSetting(k);
  res.json({
    settings,
    categories: db.prepare('SELECT id,name FROM categories ORDER BY sort,id').all(),
    dishes: db.prepare('SELECT id,category_id,name,description,weight,price,photo FROM dishes WHERE available=1 ORDER BY sort,id').all(),
    gallery: db.prepare('SELECT photo FROM gallery ORDER BY sort,id').all().map((g) => g.photo),
  });
});

app.get('/api/availability', (req, res) => {
  const { date, time } = req.query;
  if (!isDate(date) || !isTime(time)) return res.status(400).json({ error: 'Невірна дата або час' });
  const busy = busyTables(date, time);
  res.json(db.prepare('SELECT id,name,seats FROM tables_ WHERE active=1 ORDER BY id').all().map((t) => ({ ...t, busy: busy.has(t.id) })));
});

const limiter = rateLimit(20, 10 * 60 * 1000);

app.post('/api/bookings', limiter, (req, res) => {
  if (getSetting('booking_enabled') === '0') return res.status(403).json({ error: 'Бронювання тимчасово недоступне' });
  const { table_id, date, time, guests, name, phone, comment } = req.body || {};
  if (!isDate(date) || !isTime(time)) return res.status(400).json({ error: 'Вкажіть дату й час' });
  if (date < today()) return res.status(400).json({ error: 'Ця дата вже минула' });
  if (!inHours(time)) return res.status(400).json({ error: 'Заклад у цей час не працює' });
  const g = parseInt(guests, 10);
  if (!(g >= 1 && g <= 30)) return res.status(400).json({ error: 'Вкажіть кількість гостей' });
  if (!clean(name, 60) || !isPhone(phone)) return res.status(400).json({ error: "Вкажіть ім'я та телефон" });
  const t = db.prepare('SELECT * FROM tables_ WHERE id=? AND active=1').get(table_id);
  if (!t) return res.status(400).json({ error: 'Оберіть стіл' });
  if (t.seats < g) return res.status(400).json({ error: 'Цей стіл замалий для вашої компанії' });
  const tx = db.transaction(() => {
    if (busyTables(date, time).has(t.id)) return null;
    return db.prepare('INSERT INTO bookings(table_id,date,time,guests,name,phone,comment) VALUES(?,?,?,?,?,?,?)')
      .run(t.id, date, time, g, clean(name, 60), clean(phone, 20), clean(comment, 300)).lastInsertRowid;
  });
  const id = tx();
  if (!id) return res.status(409).json({ error: 'Цей стіл щойно забронювали. Оберіть інший' });
  notify(`🍽 Нова броня #${id}\n${t.name} (${t.seats} місць)\n📅 ${date} о ${time}\n👥 ${g} гостей\n👤 ${clean(name, 60)}, ${clean(phone, 20)}${comment ? '\n💬 ' + clean(comment, 300) : ''}`);
  res.json({ ok: true, id });
});

app.post('/api/orders', limiter, (req, res) => {
  if (getSetting('takeaway_enabled') === '0') return res.status(403).json({ error: 'Замовлення з собою тимчасово недоступні' });
  const { items, pickup_time, name, phone, comment } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: 'Кошик порожній' });
  if (!isTime(pickup_time) || !inHours(pickup_time)) return res.status(400).json({ error: 'Вкажіть час, коли заберете' });
  if (!clean(name, 60) || !isPhone(phone)) return res.status(400).json({ error: "Вкажіть ім'я та телефон" });
  const lines = []; let total = 0;
  for (const it of items) {
    const d = db.prepare('SELECT id,name,price FROM dishes WHERE id=? AND available=1').get(it.id);
    const q = parseInt(it.qty, 10);
    if (!d || !(q >= 1 && q <= 50)) return res.status(400).json({ error: 'Деяких страв уже немає. Оновіть сторінку' });
    lines.push({ id: d.id, name: d.name, price: d.price, qty: q }); total += d.price * q;
  }
  const id = db.prepare('INSERT INTO orders(items,total,pickup_time,name,phone,comment) VALUES(?,?,?,?,?,?)')
    .run(JSON.stringify(lines), total, pickup_time, clean(name, 60), clean(phone, 20), clean(comment, 300)).lastInsertRowid;
  notify(`🥡 Замовлення з собою #${id}\n${lines.map((l) => `• ${l.name} × ${l.qty} = ${l.price * l.qty} грн`).join('\n')}\n💰 Разом: ${total} грн\n⏰ Заберуть о ${pickup_time}\n👤 ${clean(name, 60)}, ${clean(phone, 20)}${comment ? '\n💬 ' + clean(comment, 300) : ''}`);
  res.json({ ok: true, id, total });
});

// ---------- Вхід для власника ----------
const loginLimiter = rateLimit(8, 15 * 60 * 1000);
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password || !checkPassword(String(password))) return res.status(401).json({ error: 'Невірний пароль' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').run(token, Date.now() + 30 * 864e5);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: 30 * 864e5, path: '/' });
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const t = cookie(req, 'sid'); if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.clearCookie('sid', { path: '/' }); res.json({ ok: true });
});

function auth(req, res, next) {
  const t = cookie(req, 'sid');
  const s = t && db.prepare('SELECT * FROM sessions WHERE token=?').get(t);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Потрібно увійти' });
  next();
}
const A = express.Router();
A.use(auth);
app.use('/api/admin', A);

A.get('/me', (req, res) => res.json({ ok: true }));

// Огляд: броні й замовлення
A.get('/bookings', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  res.json(db.prepare(`SELECT b.*, t.name AS table_name FROM bookings b LEFT JOIN tables_ t ON t.id=b.table_id WHERE b.date=? ORDER BY b.time`).all(date));
});
A.patch('/bookings/:id', (req, res) => {
  const st = req.body.status; if (!['new', 'confirmed', 'seated', 'cancelled', 'noshow'].includes(st)) return res.status(400).json({ error: 'Статус' });
  db.prepare('UPDATE bookings SET status=? WHERE id=?').run(st, req.params.id); res.json({ ok: true });
});
A.get('/orders', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  res.json(db.prepare(`SELECT * FROM orders WHERE date(created_at)=? ORDER BY id DESC`).all(date).map((o) => ({ ...o, items: JSON.parse(o.items) })));
});
A.patch('/orders/:id', (req, res) => {
  const st = req.body.status; if (!['new', 'cooking', 'ready', 'done', 'cancelled'].includes(st)) return res.status(400).json({ error: 'Статус' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, req.params.id); res.json({ ok: true });
});
A.get('/stats', (req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const pop = {};
  for (const o of db.prepare(`SELECT items FROM orders WHERE status!='cancelled' AND date(created_at)>=?`).all(since))
    for (const l of JSON.parse(o.items)) pop[l.name] = (pop[l.name] || 0) + l.qty;
  res.json({
    bookings30: db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status!='cancelled' AND date>=?`).get(since).c,
    orders30: db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE status!='cancelled' AND date(created_at)>=?`).get(since),
    popular: Object.entries(pop).sort((a, b) => b[1] - a[1]).slice(0, 8),
    guests: db.prepare(`SELECT name, phone, COUNT(*) visits, MAX(date) last FROM bookings WHERE status NOT IN ('cancelled','noshow') GROUP BY phone ORDER BY visits DESC, last DESC LIMIT 50`).all(),
  });
});

// Меню
A.get('/menu', (req, res) => res.json({
  categories: db.prepare('SELECT * FROM categories ORDER BY sort,id').all(),
  dishes: db.prepare('SELECT * FROM dishes ORDER BY sort,id').all(),
}));
A.post('/categories', (req, res) => {
  const n = clean(req.body.name, 40); if (!n) return res.status(400).json({ error: 'Назва' });
  res.json({ id: db.prepare('INSERT INTO categories(name,sort) VALUES(?,?)').run(n, Date.now() % 1e9).lastInsertRowid });
});
A.patch('/categories/:id', (req, res) => {
  const n = clean(req.body.name, 40); if (!n) return res.status(400).json({ error: 'Назва' });
  db.prepare('UPDATE categories SET name=? WHERE id=?').run(n, req.params.id); res.json({ ok: true });
});
A.delete('/categories/:id', (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM dishes WHERE category_id=?').get(req.params.id).c) return res.status(400).json({ error: 'Спершу перенесіть або видаліть страви цієї категорії' });
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id); res.json({ ok: true });
});

A.post('/dishes', upload.single('photo'), (req, res) => {
  const d = dishFields(req.body); if (d.error) return res.status(400).json(d);
  const id = db.prepare('INSERT INTO dishes(category_id,name,description,weight,price,available,photo,sort) VALUES(?,?,?,?,?,?,?,?)')
    .run(d.category_id, d.name, d.description, d.weight, d.price, d.available, req.file ? '/uploads/' + req.file.filename : '', Date.now() % 1e9).lastInsertRowid;
  res.json({ id });
});
A.patch('/dishes/:id', upload.single('photo'), (req, res) => {
  const old = db.prepare('SELECT * FROM dishes WHERE id=?').get(req.params.id); if (!old) return res.status(404).json({ error: 'Немає' });
  const d = dishFields({ ...old, ...req.body }); if (d.error) return res.status(400).json(d);
  let photo = old.photo;
  if (req.file) { removeUpload(old.photo); photo = '/uploads/' + req.file.filename; }
  else if (req.body.remove_photo === '1') { removeUpload(old.photo); photo = ''; }
  db.prepare('UPDATE dishes SET category_id=?,name=?,description=?,weight=?,price=?,available=?,photo=? WHERE id=?')
    .run(d.category_id, d.name, d.description, d.weight, d.price, d.available, photo, old.id);
  res.json({ ok: true });
});
A.delete('/dishes/:id', (req, res) => {
  const old = db.prepare('SELECT photo FROM dishes WHERE id=?').get(req.params.id);
  if (old) { removeUpload(old.photo); db.prepare('DELETE FROM dishes WHERE id=?').run(req.params.id); }
  res.json({ ok: true });
});

// Столи
A.get('/tables', (req, res) => res.json(db.prepare('SELECT * FROM tables_ ORDER BY id').all()));
A.post('/tables', (req, res) => {
  const n = clean(req.body.name, 30), s = parseInt(req.body.seats, 10);
  if (!n || !(s >= 1 && s <= 30)) return res.status(400).json({ error: 'Назва і кількість місць' });
  res.json({ id: db.prepare('INSERT INTO tables_(name,seats) VALUES(?,?)').run(n, s).lastInsertRowid });
});
A.patch('/tables/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tables_ WHERE id=?').get(req.params.id); if (!t) return res.status(404).json({ error: 'Немає' });
  const n = clean(req.body.name ?? t.name, 30), s = parseInt(req.body.seats ?? t.seats, 10), a = req.body.active === undefined ? t.active : (req.body.active ? 1 : 0);
  if (!n || !(s >= 1 && s <= 30)) return res.status(400).json({ error: 'Назва і кількість місць' });
  db.prepare('UPDATE tables_ SET name=?,seats=?,active=? WHERE id=?').run(n, s, a, t.id); res.json({ ok: true });
});
A.delete('/tables/:id', (req, res) => { db.prepare('UPDATE tables_ SET active=0 WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// Галерея та головне фото
A.post('/gallery', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Оберіть фото (JPG, PNG або WebP до 8 МБ)' });
  res.json({ id: db.prepare('INSERT INTO gallery(photo,sort) VALUES(?,?)').run('/uploads/' + req.file.filename, Date.now() % 1e9).lastInsertRowid });
});
A.get('/gallery', (req, res) => res.json(db.prepare('SELECT * FROM gallery ORDER BY sort,id').all()));
A.delete('/gallery/:id', (req, res) => {
  const g = db.prepare('SELECT photo FROM gallery WHERE id=?').get(req.params.id);
  if (g) { removeUpload(g.photo); db.prepare('DELETE FROM gallery WHERE id=?').run(req.params.id); }
  res.json({ ok: true });
});
A.post('/hero', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Оберіть фото (JPG, PNG або WebP до 8 МБ)' });
  removeUpload(getSetting('hero_photo')); setSetting('hero_photo', '/uploads/' + req.file.filename); res.json({ ok: true });
});

// Налаштування
const EDITABLE = ['name', 'tagline', 'address', 'phone', 'hours', 'open_time', 'close_time', 'instagram', 'tiktok', 'maps_url', 'booking_enabled', 'takeaway_enabled', 'telegram_token', 'telegram_chat_id'];
A.get('/settings', (req, res) => {
  const o = {}; for (const k of EDITABLE) o[k] = getSetting(k);
  o.telegram_token = o.telegram_token ? '••••' + o.telegram_token.slice(-4) : '';
  res.json(o);
});
A.put('/settings', (req, res) => {
  for (const k of EDITABLE) {
    if (req.body[k] === undefined) continue;
    if (k === 'telegram_token' && String(req.body[k]).startsWith('••••')) continue;
    if ((k === 'open_time' || k === 'close_time') && !isTime(req.body[k])) return res.status(400).json({ error: 'Час у форматі 10:00' });
    setSetting(k, clean(req.body[k], 300));
  }
  res.json({ ok: true });
});
A.post('/telegram-test', async (req, res) => {
  const ok = await notify('✅ Тестове повідомлення з сайту «' + getSetting('name') + '». Сповіщення працюють.');
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'Не вдалося надіслати. Перевірте токен бота і chat ID, і що ви написали боту /start' });
});
A.put('/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(String(current || ''))) return res.status(400).json({ error: 'Поточний пароль невірний' });
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'Новий пароль має бути від 8 символів' });
  setSetting('admin_hash', hashPassword(String(next)));
  db.prepare('DELETE FROM sessions').run();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Фото завелике, максимум 8 МБ' });
  console.error(err); res.status(500).json({ error: 'Помилка сервера' });
});

app.listen(PORT, () => console.log(`«${getSetting('name')}» працює: http://localhost:${PORT}  ·  адмінка: http://localhost:${PORT}/admin`));

// ---------- Допоміжне ----------
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM settings').get().c) {
    // база вже є, але з тестовими контактами: підставити справжні
    if (!getSetting('phone') && getSetting('address') === 'Яворів') {
      setSetting('phone', '+380974576671, +380962415378, +380975198047');
      setSetting('address', 'Наконечне Перше, Яворівський р-н, Львівська обл.');
      setSetting('hours', 'щодня 10:00–23:00'); setSetting('close_time', '23:00');
      setSetting('tagline', 'Готуємо на грилі та в коптильні просто при вас. Сідайте за стіл або заберіть з собою.');
      setSetting('maps_url', 'https://www.google.com/maps/place/?q=place_id:ChIJL7wDVQAVO0cR0EGKJVJyMCQ');
    }
    if (getSetting('tagline') === 'Свіжа та копчена риба щодня. Сідайте за стіл або заберіть з собою.') setSetting('tagline', 'Готуємо на грилі та в коптильні просто при вас. Сідайте за стіл або заберіть з собою.');
    return;
  }
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const defaults = {
    name: 'Рибне місце', tagline: 'Готуємо на грилі та в коптильні просто при вас. Сідайте за стіл або заберіть з собою.',
    address: 'Наконечне Перше, Яворівський р-н, Львівська обл.', phone: '+380974576671, +380962415378, +380975198047',
    hours: 'щодня 10:00–23:00', open_time: '10:00', close_time: '23:00',
    instagram: '', tiktok: 'https://www.tiktok.com/@ribnemisce', maps_url: 'https://www.google.com/maps/place/?q=place_id:ChIJL7wDVQAVO0cR0EGKJVJyMCQ',
    hero_photo: '', booking_enabled: '1', takeaway_enabled: '1', telegram_token: process.env.TELEGRAM_TOKEN || '', telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
    admin_hash: hashPassword(pw),
  };
  for (const [k, v] of Object.entries(defaults)) setSetting(k, v);
  const cats = ['Гриль', 'Гарячі страви', 'Супи', 'Закуски', 'Напої'];
  const cid = {}; cats.forEach((c, i) => (cid[c] = db.prepare('INSERT INTO categories(name,sort) VALUES(?,?)').run(c, i).lastInsertRowid));
  const dishes = [
    ['Гриль', 'Дорадо на грилі', 'Ціла рибина, лимон, оливкова олія', '350 г', 320],
    ['Гриль', 'Стейк з лосося', 'Соус теріякі', '200 г', 390],
    ['Гарячі страви', 'Форель смажена', 'Хрустка скоринка, картопля', '300 г', 280],
    ['Гарячі страви', 'Фіш енд чіпс', 'Тріска в клярі, фрі, соус тартар', '350 г', 250],
    ['Супи', 'Рибна юшка', 'Три види риби, зелень', '350 мл', 150],
    ['Закуски', 'Креветки темпура', 'Солодкий чилі', '8 шт', 270],
    ['Напої', 'Домашній лимонад', 'Лимон і м’ята', '500 мл', 80],
  ];
  dishes.forEach((d, i) => db.prepare('INSERT INTO dishes(category_id,name,description,weight,price,sort) VALUES(?,?,?,?,?,?)').run(cid[d[0]], d[1], d[2], d[3], d[4], i));
  [['Стіл 1', 2], ['Стіл 2', 2], ['Стіл 3', 4], ['Стіл 4', 4], ['Стіл 5', 4], ['Стіл 6', 6], ['Стіл 7', 8]].forEach(([n, s]) => db.prepare('INSERT INTO tables_(name,seats) VALUES(?,?)').run(n, s));
  if (!process.env.ADMIN_PASSWORD) console.log('\n  Пароль до адмінки: ' + pw + '\n  (змініть його в адмінці → Налаштування)\n');
}
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPassword(pw) {
  const [salt, hash] = getSetting('admin_hash').split(':'); if (!salt) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
function busyTables(date, time) {
  const m = toMin(time), s = new Set();
  for (const b of db.prepare(`SELECT table_id,time FROM bookings WHERE date=? AND status NOT IN ('cancelled','noshow')`).all(date))
    if (Math.abs(toMin(b.time) - m) < 120) s.add(b.table_id);
  return s;
}
async function notify(text) {
  const token = getSetting('telegram_token'), chat = getSetting('telegram_chat_id');
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) });
    return r.ok;
  } catch (e) { console.error('Telegram:', e.message); return false; }
}
function removeUpload(p) { if (p && p.startsWith('/uploads/')) fs.rm(path.join(UPLOAD_DIR, path.basename(p)), () => {}); }
function dishFields(b) {
  const name = clean(b.name, 80), price = parseInt(b.price, 10), category_id = parseInt(b.category_id, 10);
  if (!name) return { error: 'Вкажіть назву страви' };
  if (!(price >= 0 && price <= 100000)) return { error: 'Вкажіть ціну' };
  if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(category_id)) return { error: 'Оберіть категорію' };
  return { name, price, category_id, description: clean(b.description, 300), weight: clean(b.weight, 30), available: String(b.available) === '0' ? 0 : 1 };
}
function clean(v, max) { return String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || ''); }
function isTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v || ''); }
function isPhone(v) { return /^[+\d][\d\s()-]{8,18}$/.test(String(v || '').trim()); }
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function inHours(t) { const o = getSetting('open_time') || '00:00', c = getSetting('close_time') || '23:59'; return toMin(t) >= toMin(o) && toMin(t) <= toMin(c); }
function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); }
function cookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m && m[1]; }
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const k = req.ip, now = Date.now(), h = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) return res.status(429).json({ error: 'Забагато спроб. Спробуйте трохи пізніше' });
    h.push(now); hits.set(k, h); next();
  };
}
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
