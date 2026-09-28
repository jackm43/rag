FROM node:24.12.0-bookworm-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl libatomic1 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@8.15.9 \
 && usermod -l agent node && usermod -d /home/agent -m agent \
 && mkdir /workspace && chmod 755 /workspace
WORKDIR /opt/runner
COPY runner/package.json runner/pnpm-lock.yaml ./
RUN npx --yes pnpm@10.33.2 install --frozen-lockfile
COPY runner/server.mjs runner/agent.mjs runner/template.json runner/entrypoint.sh ./
EXPOSE 8080
CMD ["sh", "/opt/runner/entrypoint.sh"]
