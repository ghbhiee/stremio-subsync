#!/bin/bash
# Install or upgrade stremio-subsync on a Linux host that already runs the Stremio streaming server.
# Run as root from a checkout:
#   PUBLIC_BASE=https://media.example.com/subsync ./deploy.sh
# Optional environment:
#   DEEPSEEK_API_KEY  enables AI translation (stored in the env file, never printed)
#   WEB_DIR           self-hosted stremio-web directory: installs the addon preinstall hook into index.html
#   NGINX_SNIPPET     nginx file included inside your HTTPS server block: the proxy location is added to it
#   SERVICE_USER      user the addon runs as (default: stremio)
#   NODE_BIN          node >= 20 (default: node in PATH, else /opt/stremio-node/bin/node)
set -euo pipefail
S=$(cd "$(dirname "$0")" && pwd)
: "${PUBLIC_BASE:?set PUBLIC_BASE, e.g. https://media.example.com/subsync}"
PUBLIC_BASE=${PUBLIC_BASE%/}
SERVICE_USER=${SERVICE_USER:-stremio}
NODE_BIN=${NODE_BIN:-$(command -v node || echo /opt/stremio-node/bin/node)}
APP=/opt/stremio-subsync
ENV_FILE=/etc/stremio/subsync.env
LOCATION="/${PUBLIC_BASE#*://*/}/"

set_env() { # key value: replace or append a line in the env file
  local tmp; tmp=$(mktemp)
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"
}

echo "== checks"
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "node >= 20 required ($NODE_BIN)"; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe (ffmpeg) required"; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "== code"
install -d $APP
install -m644 "$S/server.js" "$S/align.js" "$S/translate.js" $APP/
for f in server.js align.js translate.js; do "$NODE_BIN" --check $APP/$f; done

echo "== env file"
install -d /etc/stremio
[ -f $ENV_FILE ] || printf 'SUBSYNC_TOKEN=%s\n' "$(openssl rand -hex 16)" > $ENV_FILE
set_env PUBLIC_BASE "$PUBLIC_BASE"
[ -n "${DEEPSEEK_API_KEY:-}" ] && set_env DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"
chown root:"$SERVICE_USER" $ENV_FILE && chmod 640 $ENV_FILE
TOKEN=$(sed -n 's/^SUBSYNC_TOKEN=//p' $ENV_FILE)
MANIFEST="$PUBLIC_BASE/$TOKEN/manifest.json"

echo "== service"
sed -e "s#/opt/stremio-node/bin/node#$NODE_BIN#" -e "s#^User=.*#User=$SERVICE_USER#" -e "s#^Group=.*#Group=$SERVICE_USER#" \
  "$S/stremio-subsync.service" > /etc/systemd/system/stremio-subsync.service
systemctl daemon-reload
systemctl enable stremio-subsync.service >/dev/null
systemctl restart stremio-subsync.service
for i in $(seq 30); do curl -fsS http://127.0.0.1:11480/health 2>/dev/null && echo && break; sleep 0.5; done

if [ -n "${WEB_DIR:-}" ] && [ -f "$WEB_DIR/index.html" ]; then
  echo "== stremio-web preinstall hook"
  sed "s#__SUBSYNC_MANIFEST__#$MANIFEST#" "$S/tokencv-preinstall.js" > "$WEB_DIR/tokencv-preinstall.js"
  chmod 644 "$WEB_DIR/tokencv-preinstall.js"
  if ! grep -q 'tokencv-preinstall.js' "$WEB_DIR/index.html"; then
    cp -n "$WEB_DIR/index.html" "$WEB_DIR/index.html.bak-subsync"
    sed -i 's#</body>#<script src="tokencv-preinstall.js"></script></body>#' "$WEB_DIR/index.html"
  fi
fi

if [ -n "${NGINX_SNIPPET:-}" ]; then
  echo "== nginx ($NGINX_SNIPPET, location $LOCATION)"
  if ! grep -q "location $LOCATION " "$NGINX_SNIPPET"; then
    cp -n "$NGINX_SNIPPET" "$NGINX_SNIPPET.bak-subsync"
    sed "s#location /subsync/ #location $LOCATION #" "$S/examples/nginx-subsync.conf" >> "$NGINX_SNIPPET"
    if nginx -t 2>/dev/null; then systemctl reload nginx; else cp "$NGINX_SNIPPET.bak-subsync" "$NGINX_SNIPPET"; nginx -t; echo "nginx rolled back"; exit 1; fi
  fi
fi

echo "== public manifest"
for i in $(seq 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$MANIFEST" || true)
  [ "$code" = 200 ] && break; sleep 1
done
echo "manifest HTTP $code"
echo "Addon URL (add it in Stremio → Addons, keep it private): $PUBLIC_BASE/<token from $ENV_FILE>/manifest.json"
