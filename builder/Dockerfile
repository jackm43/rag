FROM node:24.12.0-bookworm-slim

# The coding agent and everything it starts run as `agent` (uid 1000); the
# supervisor (server.mjs) runs as root and only publishes what it verified.
RUN groupmod -n agent node && usermod -l agent -d /home/agent -m node \
 && mkdir /workspace && chown agent:agent /workspace

# Optional build secret `ca`: a CA bundle for builders behind TLS-intercepting
# proxies. Absent in normal builds, where Node just ignores the missing file.
ENV BUILD_CA=/run/secrets/ca
WORKDIR /opt/runner
COPY runner/package.json runner/package-lock.json ./
RUN --mount=type=secret,id=ca NODE_EXTRA_CA_CERTS=$BUILD_CA npm ci --no-audit --no-fund

WORKDIR /opt/template
COPY template/package.json template/package-lock.json ./
RUN --mount=type=secret,id=ca NODE_EXTRA_CA_CERTS=$BUILD_CA npm ci --no-audit --no-fund \
 && NODE_EXTRA_CA_CERTS=$BUILD_CA npm cache add three@0.186.1 --cache /home/agent/.npm \
 && chown -R agent:agent /home/agent/.npm
COPY template/ ./

WORKDIR /opt/runner
COPY runner/server.mjs runner/agent.mjs runner/entrypoint.sh ./
EXPOSE 8080
CMD ["sh", "/opt/runner/entrypoint.sh"]
