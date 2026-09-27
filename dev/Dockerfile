FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv

WORKDIR /app
RUN corepack enable \
    && corepack prepare pnpm@8.15.9 --activate \
    && uv python install 3.14

ENV DEV_UI_IN_CONTAINER=1
EXPOSE 8788
CMD ["sh", "-c", "pnpm install --frozen-lockfile && uv sync --locked && exec uv run python scripts/dev_ui.py --ip 0.0.0.0"]
