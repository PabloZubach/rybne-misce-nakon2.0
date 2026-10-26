// «Рибне місце» — сервер сайту: меню, бронювання, замовлення з собою, адмін-панель
// Дані (меню, броні, налаштування, фото) зберігаються в базі Turso (libSQL).
// Без TURSO_DATABASE_URL сервер працює з локальним файлом data/site.db — зручно для перевірки на своєму комп'ютері.
const express = require('express');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------- Налаштування ----------
loadEnv(path.join(__dirname, '.env'));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOCAL_DB = path.join(DATA_DIR, 'site.db');
const REMOTE = !!process.env.TURSO_DATABASE_URL;
if (!REMOTE) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = createClient(REMOTE
  ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
  : { url: 'file:' + LOCAL_DB });

// Невеликі обгортки, щоб писати запити коротко
const toObj = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const all = async (sql, ...args) => toObj(await db.execute({ sql, args }));
const get = async (sql, ...args) => (await all(sql, ...args))[0];
const run = async (sql, ...args) => { const r = await db.execute({ sql, args }); return { id: Number(r.lastInsertRowid), changes: r.rowsAffected }; };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS dishes (id INTEGER PRIMARY KEY, category_id INTEGER, name TEXT NOT NULL, description TEXT DEFAULT '',
     weight TEXT DEFAULT '', price INTEGER NOT NULL, photo TEXT DEFAULT '', available INTEGER DEFAULT 1, sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS tables_ (id INTEGER PRIMARY KEY, name TEXT NOT NULL, seats INTEGER NOT NULL, active INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY, table_id INTEGER, date TEXT, time TEXT, guests INTEGER, name TEXT, phone TEXT,
     comment TEXT DEFAULT '', status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now','localtime')))`,
  `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, items TEXT, total INTEGER, pickup_time TEXT, name TEXT, phone TEXT,
     comment TEXT DEFAULT '', status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now','localtime')))`,
  `CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY, photo TEXT NOT NULL, sort INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS photos (name TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created INTEGER)`,
  `CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date)`,
];

// Налаштування тримаємо в пам'яті: база віддалена, а вони потрібні майже в кожному запиті
const settings = new Map();
const getSetting = (k) => settings.get(k) || '';
async function setSetting(k, v) {
  v = String(v ?? '');
  await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
  settings.set(k, v);
}

// ---------- Застосунок ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // сайт працює за проксі Render: брати справжню IP-адресу відвідувача
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
// Помилки в async-обробниках передаємо в загальний обробник замість падіння сервера
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- SEO: сторінка з даними для Google, robots.txt, sitemap.xml ----------
const GEO = { lat: 49.9344979, lng: 23.352096 };
const INDEX_TPL = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const baseUrl = (req) => (process.env.SITE_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const attr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PUBLIC_SETTINGS = ['name', 'tagline', 'address', 'phone', 'hours', 'open_time', 'close_time', 'hero_photo', 'instagram', 'tiktok', 'maps_url', 'booking_enabled', 'takeaway_enabled'];

app.get(['/', '/index.html'], h(async (req, res) => {
  const base = baseUrl(req), s = {};
  for (const k of [...PUBLIC_SETTINGS, 'google_verification']) s[k] = getSetting(k);
  const phones = s.phone.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const title = `${s.name} — свіжа та копчена риба в Наконечному біля Яворова | меню${s.booking_enabled !== '0' ? ', бронювання' : ''}, замовлення з собою`;
  const desc = `${s.tagline} Наконечне Перше, Яворівський район, поруч із Яворовом. ${s.hours ? 'Працюємо ' + s.hours + '.' : ''} ${phones[0] ? 'Тел. ' + phones[0] : ''}`.replace(/\s+/g, ' ').trim().slice(0, 300);
  const image = base + (s.hero_photo || '/hero-front.jpg');
  const cats = await all('SELECT id,name FROM categories ORDER BY sort,id');
  const dishes = await all('SELECT category_id,name,description,price FROM dishes WHERE available=1 ORDER BY sort,id');
  const ld = {
    '@context': 'https://schema.org', '@type': 'Restaurant', '@id': base + '/#restaurant',
    name: s.name, description: s.tagline, url: base + '/', telephone: phones[0] || undefined,
    image, logo: base + '/logo-512.png',
    address: { '@type': 'PostalAddress', streetAddress: s.address, addressLocality: 'Наконечне Перше', addressRegion: 'Львівська область', postalCode: '81032', addressCountry: 'UA' },
    geo: { '@type': 'GeoCoordinates', latitude: GEO.lat, longitude: GEO.lng },
    hasMap: s.maps_url || undefined,
    openingHoursSpecification: (s.open_time && s.close_time) ? [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: s.open_time, closes: s.close_time }] : undefined,
    servesCuisine: ['Риба', 'Копчена риба', 'Гриль', 'Українська'],
    acceptsReservations: s.booking_enabled !== '0',
    priceRange: '₴₴',
    areaServed: ['Наконечне Перше', 'Яворів', 'Яворівський район'],
    sameAs: [s.tiktok, s.instagram, s.maps_url].filter((u) => /^https?:\/\//.test(u || '')),
    hasMenu: { '@type': 'Menu', name: 'Меню', hasMenuSection: cats.map((c) => ({ '@type': 'MenuSection', name: c.name,
      hasMenuItem: dishes.filter((d) => d.category_id === c.id).map((d) => ({ '@type': 'MenuItem', name: d.name, description: d.description || undefined,
        offers: { '@type': 'Offer', price: d.price, priceCurrency: 'UAH' } })) })).filter((x) => x.hasMenuItem.length) },
  };
  const verify = (s.google_verification.match(/content=["']([^"']+)["']/) || [null, s.google_verification])[1].trim();
  const head = [
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(desc)}">`,
    `<link rel="canonical" href="${attr(base + '/')}">`,
    `<meta property="og:type" content="restaurant">`,
    `<meta property="og:site_name" content="${attr(s.name)}">`,
    `<meta property="og:title" content="${attr(s.name + ' — свіжа та копчена риба щодня')}">`,
    `<meta property="og:description" content="${attr(desc)}">`,
    `<meta property="og:url" content="${attr(base + '/')}">`,
    `<meta property="og:locale" content="uk_UA">`,
    image ? `<meta property="og:image" content="${attr(image)}">` : '',
    `<meta name="geo.region" content="UA-46"><meta name="geo.placename" content="Наконечне Перше"><meta name="geo.position" content="${GEO.lat};${GEO.lng}">`,
    verify ? `<meta name="google-site-verification" content="${attr(verify)}">` : '',
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean).join('\n');
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_TPL.replace(/<!--SEO-->[\s\S]*?<!--\/SEO-->/, head));
}));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nAllow: /api/site\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const last = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${baseUrl(req)}/</loc><lastmod>${last}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n</urlset>\n`);
});
app.get(['/admin', '/admin.html'], (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

// Легка адреса, яку «будильник» (UptimeRobot / cron-job.org) відкриває, щоб безкоштовний сервер не засинав
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

// Фото зберігаються в базі; назва файлу випадкова, тож браузер може кешувати їх надовго
const photoCache = new Map(); // невеликий кеш у пам'яті, щоб не тягнути з бази щоразу
app.get('/uploads/:name', h(async (req, res) => {
  const name = path.basename(req.params.name);
  let p = photoCache.get(name);
  if (!p) {
    const row = await get('SELECT mime,data FROM photos WHERE name=?', name);
    const disk = path.join(DATA_DIR, 'uploads', name); // старі фото, які ще лежать на диску
    if (row) p = { mime: row.mime, data: Buffer.from(row.data) };
    else if (fs.existsSync(disk)) p = { mime: name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg', data: fs.readFileSync(disk) };
    else return res.status(404).end();
    if (photoCache.size > 200) photoCache.delete(photoCache.keys().next().value);
    photoCache.set(name, p);
  }
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(p.mime).send(p.data);
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
const EXT = { 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg' };
async function savePhoto(file) {
  const name = crypto.randomBytes(12).toString('hex') + (EXT[file.mimetype] || '.jpg');
  await run('INSERT INTO photos(name,mime,data,created) VALUES(?,?,?,?)', name, file.mimetype, file.buffer, Date.now());
  return '/uploads/' + name;
}
async function removePhoto(p) {
  if (!p || !p.startsWith('/uploads/')) return;
  const used = await get('SELECT (SELECT COUNT(*) FROM dishes WHERE photo=?) + (SELECT COUNT(*) FROM gallery WHERE photo=?) n', p, p);
  if (used && used.n > 1) return; // фото ще використовує інша страва
  const name = path.basename(p);
  photoCache.delete(name);
  await run('DELETE FROM photos WHERE name=?', name);
}

// ---------- Публічне API (для гостей) ----------
app.get('/api/site', h(async (req, res) => {
  const s = {};
  for (const k of PUBLIC_SETTINGS) s[k] = getSetting(k);
  const [categories, dishes, gallery] = await Promise.all([
    all('SELECT id,name FROM categories ORDER BY sort,id'),
    all('SELECT id,category_id,name,description,weight,price,photo FROM dishes WHERE available=1 ORDER BY sort,id'),
    all('SELECT photo FROM gallery ORDER BY sort,id'),
  ]);
  res.json({ settings: s, categories, dishes, gallery: gallery.map((g) => g.photo) });
}));

app.get('/api/availability', h(async (req, res) => {
  const { date, time } = req.query;
  if (!isDate(date) || !isTime(time)) return res.status(400).json({ error: 'Невірна дата або час' });
  const busy = await busyTables(date, time);
  res.json((await all('SELECT id,name,seats FROM tables_ WHERE active=1 ORDER BY id')).map((t) => ({ ...t, busy: busy.has(t.id) })));
}));

const limiter = rateLimit(20, 10 * 60 * 1000);

// Один стіл не можна забронювати двічі: перевірка й запис ідуть по черзі
let bookingQueue = Promise.resolve();
const serial = (fn) => { const p = bookingQueue.then(fn, fn); bookingQueue = p.catch(() => {}); return p; };

app.post('/api/bookings', limiter, h(async (req, res) => {
  if (getSetting('booking_enabled') === '0') return res.status(403).json({ error: 'Бронювання тимчасово недоступне' });
  const { table_id, date, time, guests, name, phone, comment } = req.body || {};
  if (!isDate(date) || !isTime(time)) return res.status(400).json({ error: 'Вкажіть дату й час' });
  if (date < today()) return res.status(400).json({ error: 'Ця дата вже минула' });
  if (!inHours(time)) return res.status(400).json({ error: 'Заклад у цей час не працює' });
  const g = parseInt(guests, 10);
  if (!(g >= 1 && g <= 30)) return res.status(400).json({ error: 'Вкажіть кількість гостей' });
  if (!clean(name, 60) || !isPhone(phone)) return res.status(400).json({ error: "Вкажіть ім'я та телефон" });
  const t = await get('SELECT * FROM tables_ WHERE id=? AND active=1', table_id);
  if (!t) return res.status(400).json({ error: 'Оберіть стіл' });
  if (t.seats < g) return res.status(400).json({ error: 'Цей стіл замалий для вашої компанії' });
  const id = await serial(async () => {
    if ((await busyTables(date, time)).has(t.id)) return null;
    return (await run('INSERT INTO bookings(table_id,date,time,guests,name,phone,comment) VALUES(?,?,?,?,?,?,?)',
      t.id, date, time, g, clean(name, 60), clean(phone, 20), clean(comment, 300))).id;
  });
  if (!id) return res.status(409).json({ error: 'Цей стіл щойно забронювали. Оберіть інший' });
  notify(`🍽 Нова броня #${id}\n${t.name} (${t.seats} місць)\n📅 ${date} о ${time}\n👥 ${g} гостей\n👤 ${clean(name, 60)}, ${clean(phone, 20)}${comment ? '\n💬 ' + clean(comment, 300) : ''}`);
  res.json({ ok: true, id });
}));

app.post('/api/orders', limiter, h(async (req, res) => {
  if (getSetting('takeaway_enabled') === '0') return res.status(403).json({ error: 'Замовлення з собою тимчасово недоступні' });
  const { items, pickup_time, name, phone, comment } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: 'Кошик порожній' });
  if (!isTime(pickup_time) || !inHours(pickup_time)) return res.status(400).json({ error: 'Вкажіть час, коли заберете' });
  if (!clean(name, 60) || !isPhone(phone)) return res.status(400).json({ error: "Вкажіть ім'я та телефон" });
  const lines = []; let total = 0;
  for (const it of items) {
    const d = await get('SELECT id,name,price,weight FROM dishes WHERE id=? AND available=1', it.id);
    const q = parseInt(it.qty, 10);
    if (!d || !(q >= 1 && q <= 50)) return res.status(400).json({ error: 'Деяких страв уже немає. Оновіть сторінку' });
    lines.push({ id: d.id, name: d.name, price: d.price, qty: q, per100: /^за 100/.test(d.weight || '') }); total += d.price * q;
  }
  const { id } = await run('INSERT INTO orders(items,total,pickup_time,name,phone,comment) VALUES(?,?,?,?,?,?)',
    JSON.stringify(lines), total, pickup_time, clean(name, 60), clean(phone, 20), clean(comment, 300));
  notify(`🥡 Замовлення з собою #${id}\n${lines.map((l) => `• ${l.name} × ${l.per100 ? l.qty * 100 + ' г' : l.qty} = ${l.price * l.qty} грн`).join('\n')}\n💰 Разом: ${total} грн\n⏰ Заберуть о ${pickup_time}\n👤 ${clean(name, 60)}, ${clean(phone, 20)}${comment ? '\n💬 ' + clean(comment, 300) : ''}`);
  res.json({ ok: true, id, total });
}));

// ---------- Вхід для власника ----------
const loginLimiter = rateLimit(8, 15 * 60 * 1000);
app.post('/api/admin/login', loginLimiter, h(async (req, res) => {
  const { password } = req.body || {};
  if (!password || !checkPassword(String(password))) return res.status(401).json({ error: 'Невірний пароль' });
  const token = crypto.randomBytes(32).toString('hex');
  await run('DELETE FROM sessions WHERE expires<?', Date.now());
  await run('INSERT INTO sessions(token,expires) VALUES(?,?)', token, Date.now() + 30 * 864e5);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 30 * 864e5, path: '/' });
  res.json({ ok: true });
}));
app.post('/api/admin/logout', h(async (req, res) => {
  const t = cookie(req, 'sid'); if (t) await run('DELETE FROM sessions WHERE token=?', t);
  res.clearCookie('sid', { path: '/' }); res.json({ ok: true });
}));

const auth = h(async (req, res, next) => {
  const t = cookie(req, 'sid');
  const s = t && await get('SELECT * FROM sessions WHERE token=?', t);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Потрібно увійти' });
  next();
});
const A = express.Router();
A.use(auth);
app.use('/api/admin', A);

A.get('/me', (req, res) => res.json({ ok: true }));

// Огляд: броні й замовлення
A.get('/bookings', h(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  res.json(await all(`SELECT b.*, t.name AS table_name FROM bookings b LEFT JOIN tables_ t ON t.id=b.table_id WHERE b.date=? ORDER BY b.time`, date));
}));
A.patch('/bookings/:id', h(async (req, res) => {
  const st = req.body.status; if (!['new', 'confirmed', 'seated', 'cancelled', 'noshow'].includes(st)) return res.status(400).json({ error: 'Статус' });
  await run('UPDATE bookings SET status=? WHERE id=?', st, req.params.id); res.json({ ok: true });
}));
A.get('/orders', h(async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  res.json((await all(`SELECT * FROM orders WHERE date(created_at)=? ORDER BY id DESC`, date)).map((o) => ({ ...o, items: JSON.parse(o.items) })));
}));
A.patch('/orders/:id', h(async (req, res) => {
  const st = req.body.status; if (!['new', 'cooking', 'ready', 'done', 'cancelled'].includes(st)) return res.status(400).json({ error: 'Статус' });
  await run('UPDATE orders SET status=? WHERE id=?', st, req.params.id); res.json({ ok: true });
}));
A.get('/stats', h(async (req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const pop = {};
  for (const o of await all(`SELECT items FROM orders WHERE status!='cancelled' AND date(created_at)>=?`, since))
    for (const l of JSON.parse(o.items)) pop[l.name] = (pop[l.name] || 0) + l.qty;
  res.json({
    bookings30: (await get(`SELECT COUNT(*) c FROM bookings WHERE status!='cancelled' AND date>=?`, since)).c,
    orders30: await get(`SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM orders WHERE status!='cancelled' AND date(created_at)>=?`, since),
    popular: Object.entries(pop).sort((a, b) => b[1] - a[1]).slice(0, 8),
    guests: await all(`SELECT name, phone, COUNT(*) visits, MAX(date) last FROM bookings WHERE status NOT IN ('cancelled','noshow') GROUP BY phone ORDER BY visits DESC, last DESC LIMIT 50`),
  });
}));

// Меню
A.get('/menu', h(async (req, res) => res.json({
  categories: await all('SELECT * FROM categories ORDER BY sort,id'),
  dishes: await all('SELECT * FROM dishes ORDER BY sort,id'),
})));
A.post('/categories', h(async (req, res) => {
  const n = clean(req.body.name, 40); if (!n) return res.status(400).json({ error: 'Назва' });
  res.json({ id: (await run('INSERT INTO categories(name,sort) VALUES(?,?)', n, Date.now() % 1e9)).id });
}));
A.patch('/categories/:id', h(async (req, res) => {
  const n = clean(req.body.name, 40); if (!n) return res.status(400).json({ error: 'Назва' });
  await run('UPDATE categories SET name=? WHERE id=?', n, req.params.id); res.json({ ok: true });
}));
A.delete('/categories/:id', h(async (req, res) => {
  if ((await get('SELECT COUNT(*) c FROM dishes WHERE category_id=?', req.params.id)).c) return res.status(400).json({ error: 'Спершу перенесіть або видаліть страви цієї категорії' });
  await run('DELETE FROM categories WHERE id=?', req.params.id); res.json({ ok: true });
}));

A.post('/dishes', upload.single('photo'), h(async (req, res) => {
  const d = await dishFields(req.body); if (d.error) return res.status(400).json(d);
  const photo = req.file ? await savePhoto(req.file) : '';
  const { id } = await run('INSERT INTO dishes(category_id,name,description,weight,price,available,photo,sort) VALUES(?,?,?,?,?,?,?,?)',
    d.category_id, d.name, d.description, d.weight, d.price, d.available, photo, Date.now() % 1e9);
  res.json({ id });
}));
A.patch('/dishes/:id', upload.single('photo'), h(async (req, res) => {
  const old = await get('SELECT * FROM dishes WHERE id=?', req.params.id); if (!old) return res.status(404).json({ error: 'Немає' });
  const d = await dishFields({ ...old, ...req.body }); if (d.error) return res.status(400).json(d);
  let photo = old.photo;
  if (req.file) { photo = await savePhoto(req.file); await removePhoto(old.photo); }
  else if (req.body.remove_photo === '1') { await removePhoto(old.photo); photo = ''; }
  await run('UPDATE dishes SET category_id=?,name=?,description=?,weight=?,price=?,available=?,photo=? WHERE id=?',
    d.category_id, d.name, d.description, d.weight, d.price, d.available, photo, old.id);
  res.json({ ok: true });
}));
A.delete('/dishes/:id', h(async (req, res) => {
  const old = await get('SELECT photo FROM dishes WHERE id=?', req.params.id);
  if (old) { await removePhoto(old.photo); await run('DELETE FROM dishes WHERE id=?', req.params.id); }
  res.json({ ok: true });
}));

// Столи
A.get('/tables', h(async (req, res) => res.json(await all('SELECT * FROM tables_ ORDER BY id'))));
A.post('/tables', h(async (req, res) => {
  const n = clean(req.body.name, 30), s = parseInt(req.body.seats, 10);
  if (!n || !(s >= 1 && s <= 30)) return res.status(400).json({ error: 'Назва і кількість місць' });
  res.json({ id: (await run('INSERT INTO tables_(name,seats) VALUES(?,?)', n, s)).id });
}));
A.patch('/tables/:id', h(async (req, res) => {
  const t = await get('SELECT * FROM tables_ WHERE id=?', req.params.id); if (!t) return res.status(404).json({ error: 'Немає' });
  const n = clean(req.body.name ?? t.name, 30), s = parseInt(req.body.seats ?? t.seats, 10), a = req.body.active === undefined ? t.active : (req.body.active ? 1 : 0);
  if (!n || !(s >= 1 && s <= 30)) return res.status(400).json({ error: 'Назва і кількість місць' });
  await run('UPDATE tables_ SET name=?,seats=?,active=? WHERE id=?', n, s, a, t.id); res.json({ ok: true });
}));
A.delete('/tables/:id', h(async (req, res) => { await run('UPDATE tables_ SET active=0 WHERE id=?', req.params.id); res.json({ ok: true }); }));

// Галерея та головне фото
A.post('/gallery', upload.single('photo'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Оберіть фото (JPG, PNG або WebP)' });
  const photo = await savePhoto(req.file);
  res.json({ id: (await run('INSERT INTO gallery(photo,sort) VALUES(?,?)', photo, Date.now() % 1e9)).id });
}));
A.get('/gallery', h(async (req, res) => res.json(await all('SELECT * FROM gallery ORDER BY sort,id'))));
A.delete('/gallery/:id', h(async (req, res) => {
  const g = await get('SELECT photo FROM gallery WHERE id=?', req.params.id);
  if (g) { await removePhoto(g.photo); await run('DELETE FROM gallery WHERE id=?', req.params.id); }
  res.json({ ok: true });
}));
A.post('/hero', upload.single('photo'), h(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Оберіть фото (JPG, PNG або WebP)' });
  const old = getSetting('hero_photo');
  await setSetting('hero_photo', await savePhoto(req.file)); await removePhoto(old); res.json({ ok: true });
}));

// Налаштування
const EDITABLE = ['name', 'tagline', 'address', 'phone', 'hours', 'open_time', 'close_time', 'instagram', 'tiktok', 'maps_url', 'booking_enabled', 'takeaway_enabled', 'telegram_token', 'telegram_chat_id', 'google_verification'];
A.get('/settings', (req, res) => {
  const o = {}; for (const k of EDITABLE) o[k] = getSetting(k);
  o.telegram_token = o.telegram_token ? '••••' + o.telegram_token.slice(-4) : '';
  res.json(o);
});
A.put('/settings', h(async (req, res) => {
  for (const k of EDITABLE) {
    if (req.body[k] === undefined) continue;
    if (k === 'telegram_token' && String(req.body[k]).startsWith('••••')) continue;
    if ((k === 'open_time' || k === 'close_time') && !isTime(req.body[k])) return res.status(400).json({ error: 'Час у форматі 10:00' });
  }
  for (const k of EDITABLE) {
    if (req.body[k] === undefined) continue;
    if (k === 'telegram_token' && String(req.body[k]).startsWith('••••')) continue;
    await setSetting(k, clean(req.body[k], 300));
  }
  res.json({ ok: true });
}));
A.post('/telegram-test', h(async (req, res) => {
  const ok = await notify('✅ Тестове повідомлення з сайту «' + getSetting('name') + '». Сповіщення працюють.');
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'Не вдалося надіслати. Перевірте токен бота і chat ID, і що ви написали боту /start' });
}));
A.put('/password', h(async (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(String(current || ''))) return res.status(400).json({ error: 'Поточний пароль невірний' });
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'Новий пароль має бути від 8 символів' });
  await setSetting('admin_hash', hashPassword(String(next)));
  await run('DELETE FROM sessions');
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Фото завелике, максимум 4 МБ' });
  console.error(err); res.status(500).json({ error: 'Помилка сервера. Спробуйте ще раз' });
});

// ---------- Запуск ----------
(async () => {
  for (const sql of SCHEMA) await db.execute(sql);
  await migrateFromDisk();
  for (const r of await all('SELECT key,value FROM settings')) settings.set(r.key, r.value ?? '');
  await seed();
  app.listen(PORT, () => console.log(`«${getSetting('name')}» працює: http://localhost:${PORT}  ·  адмінка: http://localhost:${PORT}/admin  ·  база: ${REMOTE ? 'Turso' : LOCAL_DB}`));
})().catch((e) => { console.error('Не вдалося запустити сервер:', e); process.exit(1); });

// ---------- Допоміжне ----------

// Одноразове перенесення: якщо база Turso порожня, а на диску Render лежить стара база з фото — копіюємо все в Turso
async function migrateFromDisk() {
  if (!REMOTE || !fs.existsSync(LOCAL_DB)) return;
  if ((await get('SELECT COUNT(*) c FROM settings')).c) return;
  console.log('Переношу дані зі старої бази на диску в Turso…');
  const old = createClient({ url: 'file:' + LOCAL_DB });
  const tables = ['settings', 'categories', 'dishes', 'tables_', 'bookings', 'orders', 'gallery'];
  for (const t of tables) {
    let rs; try { rs = await old.execute(`SELECT * FROM ${t}`); } catch { continue; }
    if (!rs.rows.length) continue;
    const cols = rs.columns, q = `INSERT OR REPLACE INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`;
    await db.batch(rs.rows.map((r) => ({ sql: q, args: cols.map((_, i) => r[i]) })), 'write');
  }
  const dir = path.join(DATA_DIR, 'uploads');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    const mime = f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    await run('INSERT OR IGNORE INTO photos(name,mime,data,created) VALUES(?,?,?,?)', f, mime, fs.readFileSync(path.join(dir, f)), Date.now());
  }
  old.close();
  console.log('Перенесення завершено.');
}

async function seed() {
  if (settings.size) {
    // база вже є, але з тестовими контактами: підставити справжні
    if (!getSetting('phone') && getSetting('address') === 'Яворів') {
      await setSetting('phone', '+380974576671, +380962415378, +380975198047');
      await setSetting('address', 'Наконечне Перше, Яворівський р-н, Львівська обл.');
      await setSetting('hours', 'щодня 10:00–23:00'); await setSetting('close_time', '23:00');
      await setSetting('tagline', 'Готуємо на грилі та в коптильні просто при вас. Сідайте за стіл або заберіть з собою.');
      await setSetting('maps_url', 'https://www.google.com/maps/place/?q=place_id:ChIJL7wDVQAVO0cR0EGKJVJyMCQ');
    }
    if (getSetting('tagline') === 'Свіжа та копчена риба щодня. Сідайте за стіл або заберіть з собою.') await setSetting('tagline', 'Готуємо на грилі та в коптильні просто при вас. Сідайте за стіл або заберіть з собою.');
    // Одноразово: замінити тестове меню справжнім, але лише якщо власник ще не змінював меню сам
    // Одноразово (за проханням закладу): вимкнути бронювання столів, лишити замовлення з собою.
    // Повернути можна в адмінці → Налаштування → «Приймати бронювання столів».
    if (getSetting('booking_off_v1') !== '1') { await setSetting('booking_enabled', '0'); await setSetting('booking_off_v1', '1'); }
    if (getSetting('menu_v2') !== '1') {
      const names = (await all('SELECT name FROM dishes')).map((d) => d.name);
      if (names.every((n) => DEMO_DISHES.includes(n))) { await importRealMenu(); console.log('Тестове меню замінено справжнім.'); }
      await setSetting('menu_v2', '1');
    }
    return;
  }
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const defaults = {
    name: 'Рибне місце', tagline: 'Готуємо на грилі та в коптильні просто при вас. Сідайте за стіл або заберіть з собою.',
    address: 'Наконечне Перше, Яворівський р-н, Львівська обл.', phone: '+380974576671, +380962415378, +380975198047',
    hours: 'щодня 10:00–23:00', open_time: '10:00', close_time: '23:00',
    instagram: '', tiktok: 'https://www.tiktok.com/@ribnemisce', maps_url: 'https://www.google.com/maps/place/?q=place_id:ChIJL7wDVQAVO0cR0EGKJVJyMCQ',
    hero_photo: '', booking_enabled: '0', booking_off_v1: '1', takeaway_enabled: '1', telegram_token: process.env.TELEGRAM_TOKEN || '', telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
    google_verification: '', admin_hash: hashPassword(pw),
  };
  for (const [k, v] of Object.entries(defaults)) await setSetting(k, v);
  await importRealMenu();
  await setSetting('menu_v2', '1');
  await db.batch([['Стіл 1', 2], ['Стіл 2', 2], ['Стіл 3', 4], ['Стіл 4', 4], ['Стіл 5', 4], ['Стіл 6', 6], ['Стіл 7', 8]]
    .map(([n, s]) => ({ sql: 'INSERT INTO tables_(name,seats) VALUES(?,?)', args: [n, s] })), 'write');
  if (!process.env.ADMIN_PASSWORD) console.log('\n  Пароль до адмінки: ' + pw + '\n  (змініть його в адмінці → Налаштування)\n');
}
// Назви страв тестового меню, яке було на сайті спочатку
const DEMO_DISHES = ['Дорадо на грилі', 'Стейк з лосося', 'Форель смажена', 'Фіш енд чіпс', 'Рибна юшка', 'Креветки темпура', 'Домашній лимонад'];
async function importRealMenu() {
  const MENU = require('./seed-menu/menu.js');
  for (const d of await all('SELECT photo FROM dishes')) await removePhoto(d.photo);
  await run('DELETE FROM dishes'); await run('DELETE FROM categories');
  const cid = {}, photoPath = {};
  for (const [cat] of MENU) if (!(cat in cid)) cid[cat] = (await run('INSERT INTO categories(name,sort) VALUES(?,?)', cat, Object.keys(cid).length)).id;
  for (const [i, [cat, name, desc, weight, price, file]] of MENU.entries()) {
    if (!photoPath[file]) {
      const pname = 'menu-' + file;
      await run('INSERT OR REPLACE INTO photos(name,mime,data,created) VALUES(?,?,?,?)', pname, 'image/jpeg', fs.readFileSync(path.join(__dirname, 'seed-menu', file)), Date.now());
      photoPath[file] = '/uploads/' + pname;
    }
    await run('INSERT INTO dishes(category_id,name,description,weight,price,photo,sort) VALUES(?,?,?,?,?,?,?)', cid[cat], name, desc, weight, price, photoPath[file], i);
  }
}
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPassword(pw) {
  const [salt, hash] = getSetting('admin_hash').split(':'); if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
async function busyTables(date, time) {
  const m = toMin(time), s = new Set();
  for (const b of await all(`SELECT table_id,time FROM bookings WHERE date=? AND status NOT IN ('cancelled','noshow')`, date))
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
async function dishFields(b) {
  const name = clean(b.name, 80), price = parseInt(b.price, 10), category_id = parseInt(b.category_id, 10);
  if (!name) return { error: 'Вкажіть назву страви' };
  if (!(price >= 0 && price <= 100000)) return { error: 'Вкажіть ціну' };
  if (!await get('SELECT 1 x FROM categories WHERE id=?', category_id)) return { error: 'Оберіть категорію' };
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
    const k = req.ip, now = Date.now(), list = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Забагато спроб. Спробуйте трохи пізніше' });
    list.push(now); hits.set(k, list); next();
  };
}
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
