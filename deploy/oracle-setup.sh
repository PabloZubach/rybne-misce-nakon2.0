#!/bin/bash
# =====================================================================
#  «Рибне місце»: автоматичне встановлення на безкоштовний сервер Oracle
#  Вставте цей текст у поле «Cloud-init script» під час створення сервера.
# =====================================================================

# >>> ЗМІНІТЬ ПАРОЛЬ ДО АДМІНКИ (від 8 символів, без лапок і пробілів) <<<
ADMIN_PASSWORD="ZMINIT-MENE-123"

# Звідки брати код сайту (репозиторій на GitHub має бути публічним)
REPO_URL="https://github.com/PabloZubach/rybne-misce-nakon2.0.git"

# Власний домен, якщо він уже є (наприклад rybnemisce.com.ua). Порожньо = безкоштовна адреса IP.sslip.io
DOMAIN=""

# ---------------------------------------------------------------------
exec > /var/log/rybne-setup.log 2>&1
set -eux
export DEBIAN_FRONTEND=noninteractive HOME=/root

APP_DIR=/opt/rybne
DATA_DIR=/var/lib/rybne

# 1) Файл підкачки: на сервері 1 ГБ пам'яті, цього мало для встановлення пакетів
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2) Системні пакети, Node.js 22, Caddy (веб-сервер з автоматичним HTTPS)
apt-get update
apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 iptables-persistent
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# 3) Відкрити порти 80 і 443 у фаєрволі Ubuntu (образи Oracle їх блокують)
for PORT in 80 443; do
  if ! iptables -C INPUT -m state --state NEW -p tcp --dport $PORT -j ACCEPT 2>/dev/null; then
    POS="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}')"
    iptables -I INPUT "${POS:-1}" -m state --state NEW -p tcp --dport $PORT -j ACCEPT
  fi
done
netfilter-persistent save

# 4) Адреса сайту
PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
if [ -z "$DOMAIN" ]; then DOMAIN="$(echo "$PUBLIC_IP" | tr . -).sslip.io"; fi
echo "$DOMAIN" > /root/site-address.txt

# 5) Код сайту і окремий користувач для нього
id rybne >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin rybne
if [ ! -d "$APP_DIR/.git" ]; then git clone --depth 1 "$REPO_URL" "$APP_DIR"; fi
cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund
mkdir -p "$DATA_DIR/backups"
chown -R rybne:rybne "$APP_DIR" "$DATA_DIR"
git config --global --add safe.directory "$APP_DIR"

cat > /etc/rybne.env <<EOF
PORT=3000
DATA_DIR=$DATA_DIR
ADMIN_PASSWORD=$ADMIN_PASSWORD
SITE_URL=https://$DOMAIN
EOF
chmod 600 /etc/rybne.env

# 6) Сайт як системна служба: запускається сам після перезавантаження і після збою
cat > /etc/systemd/system/rybne.service <<'EOF'
[Unit]
Description=Rybne misce website
After=network-online.target
Wants=network-online.target

[Service]
User=rybne
WorkingDirectory=/opt/rybne
EnvironmentFile=/etc/rybne.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 7) HTTPS через Caddy
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

# 8) Автооновлення: кожні 5 хвилин забирає зміни з GitHub і перезапускає сайт
cat > /usr/local/bin/rybne-update <<'EOF'
#!/bin/bash
set -e
cd /opt/rybne
git fetch --depth 1 origin main -q
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset --hard origin/main -q
  npm install --omit=dev --no-audit --no-fund
  chown -R rybne:rybne /opt/rybne
  systemctl restart rybne
  echo "$(date) оновлено до $(git rev-parse --short HEAD)"
fi
EOF
chmod +x /usr/local/bin/rybne-update

# 9) Щоденна резервна копія бази (зберігаються останні 14)
cat > /usr/local/bin/rybne-backup <<'EOF'
#!/bin/bash
sqlite3 /var/lib/rybne/site.db ".backup /var/lib/rybne/backups/site-$(date +%F).db"
ls -1t /var/lib/rybne/backups/site-*.db | tail -n +15 | xargs -r rm -f
EOF
chmod +x /usr/local/bin/rybne-backup

cat > /etc/cron.d/rybne <<'EOF'
*/5 * * * * root /usr/local/bin/rybne-update >> /var/log/rybne-update.log 2>&1
30 4 * * * root /usr/local/bin/rybne-backup >> /var/log/rybne-backup.log 2>&1
EOF

systemctl daemon-reload
systemctl enable --now rybne
systemctl restart caddy

echo "ГОТОВО: https://$DOMAIN"
