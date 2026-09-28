#!/bin/sh
# Cloudflare injects /etc/cloudflare/certs/cloudflare-containers-ca.crt when it
# intercepts outbound HTTPS; server.mjs points the agent's tools at it.
exec node /opt/runner/server.mjs
