# Implementation Plan

## Phase 1: Project Setup

- Create TypeScript Worker project scaffold.
- Configure `wrangler.jsonc` with `DB` D1 binding.
- Add dependency for Discord signature verification.

## Phase 2: Data Layer

- Create `schema.sql` with:
  - append-only `rag_events`
  - aggregate `rag_totals`
- Add local migration command for D1.

## Phase 3: Interaction Handler

- Implement Discord signature verification.
- Implement command dispatcher:
  - `/rag` increments event and totals
  - `/ragboard` returns sorted leaderboard
- Return Discord interaction response payloads.

## Phase 4: Command Provisioning

- Add command registration script for:
  - `/rag user:<mention>`
  - `/ragboard`
- Use bot token + application id from environment.

## Phase 5: Runbook

- Document operator flow with 1Password `op run --env-file=.env`.
- Document required OAuth scopes and bot permissions.
- Deploy Worker and set Discord interactions endpoint.
