#!/bin/sh
set -eu
if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1
fi
exec node /opt/runner/server.mjs
