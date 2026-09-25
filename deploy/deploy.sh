#!/usr/bin/env bash
# deploy/deploy.sh — build Onymgram and publish it at https://foldy.io/onymgram/ on the foldy.io VPS.
#
# Only committed code goes out. The site is static: nginx serves /var/lib/onymgram/site/ through the snippet in
# deploy/onymgram.nginx.conf, included into the foldy.io server block once (the site file is backed up first and
# restored if `nginx -t` fails).
#
# Env overrides:
#   DEPLOY_HOST — ssh target (default: root@69.62.114.87)
#   SITE_CONF   — nginx site that includes the snippet (default: /etc/nginx/sites-enabled/foldy.io)
#   PUBLIC_URL  — where the app is served (default: https://foldy.io/onymgram/)

set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_HOST="${DEPLOY_HOST:-root@69.62.114.87}"
SITE_CONF="${SITE_CONF:-/etc/nginx/sites-enabled/foldy.io}"
PUBLIC_URL="${PUBLIC_URL:-https://foldy.io/onymgram/}"

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy: commit or stash the working tree first" >&2
  exit 1
fi

npx vitest run -c vitest.onym.config.ts
npx tsc --noEmit -p tsconfig.json

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
BASE_URL="$PUBLIC_URL" npx vite build --outDir "$OUT" --emptyOutDir

ssh "$DEPLOY_HOST" 'install -d -m 755 /var/lib/onymgram /var/lib/onymgram/site'
rsync -rlt --delete --chmod=D755,F644 \
  --exclude '*.map' --exclude build-stats.json --exclude statoscope-report.html \
  "$OUT/" "$DEPLOY_HOST:/var/lib/onymgram/site/"
scp deploy/onymgram.nginx.conf "$DEPLOY_HOST:/etc/nginx/snippets/onymgram.conf"

ssh "$DEPLOY_HOST" SITE_CONF="$SITE_CONF" 'bash -s' <<'REMOTE'
set -euo pipefail
if ! grep -q "snippets/onymgram.conf" "$SITE_CONF"; then
    mkdir -p /root/nginx-backups
    BACKUP="/root/nginx-backups/$(basename "$SITE_CONF").$(date +%Y%m%d-%H%M%S)"
    cp "$SITE_CONF" "$BACKUP"
    sed -i 's#^\(\s*\)include /etc/nginx/snippets/onym-audit.conf;#&\n\1include /etc/nginx/snippets/onymgram.conf;#' "$SITE_CONF"
    if ! grep -q "snippets/onymgram.conf" "$SITE_CONF" || ! nginx -t; then
        cp "$BACKUP" "$SITE_CONF"
        echo "nginx change failed, restored $SITE_CONF from $BACKUP" >&2
        exit 1
    fi
    echo "nginx: added onymgram include (backup: $BACKUP)"
fi
nginx -t
systemctl reload nginx
REMOTE

echo "deployed to $PUBLIC_URL"
