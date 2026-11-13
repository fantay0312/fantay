#!/bin/sh
set -eu
archive=$1
release=$2
case "$release" in *[!a-zA-Z0-9_-]*|'') exit 2;; esac
root=/opt/fantay-share
id fantay-share >/dev/null 2>&1 || useradd --system --home /var/lib/fantay-share --shell /usr/sbin/nologin fantay-share
install -d -m 755 "$root/releases/$release"
install -d -o fantay-share -g fantay-share -m 700 /var/lib/fantay-share
tar -xzf "$archive" -C "$root/releases/$release"
chown -R root:root "$root/releases/$release"
chmod -R go-w "$root/releases/$release"
if [ ! -f /etc/fantay-share.env ]; then
  (umask 077; { printf 'SHARE_ORIGIN=https://design.tokentosea.com\nSHARE_DATA_DIR=/var/lib/fantay-share\nPORT=47800\nSHARE_SESSION_SECRET='; openssl rand -hex 32; } > /etc/fantay-share.env)
fi
previous=$(readlink "$root/current" || true)
ln -sfn "$root/releases/$release" "$root/current.new"
mv -Tf "$root/current.new" "$root/current"
cp "$root/current/deploy/fantay-share.service" /etc/systemd/system/fantay-share.service
systemctl daemon-reload
systemctl enable fantay-share
systemctl restart fantay-share
healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:47800/healthz >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" != 1 ]; then
  if [ -n "$previous" ]; then ln -sfn "$previous" "$root/current"; systemctl restart fantay-share; fi
  exit 1
fi
cp /etc/caddy/Caddyfile "$root/Caddyfile.before-$release"
cp "$root/current/deploy/fantay-share.caddy" /etc/caddy/fantay-share.caddy
chmod 644 /etc/caddy/fantay-share.caddy
if ! grep -q '^import /etc/caddy/fantay-share.caddy$' /etc/caddy/Caddyfile; then printf '\nimport /etc/caddy/fantay-share.caddy\n' >> /etc/caddy/Caddyfile; fi
if ! caddy validate --config /etc/caddy/Caddyfile; then cp "$root/Caddyfile.before-$release" /etc/caddy/Caddyfile; exit 1; fi
systemctl reload caddy
printf 'Fantaydesign share release %s ready\n' "$release"
