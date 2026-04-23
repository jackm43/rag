# RAG Discord Bot Design

## Overview

This project is a Discord interactions bot hosted on Cloudflare Workers and backed by Cloudflare D1.

Slash commands:
- `/rag @user`
- `/ragboard`

The Worker receives Discord interaction webhooks, verifies signatures using `DISCORD_PUBLIC_KEY`, and responds synchronously.

## Command Behavior

### `/rag @user`

- Reads the selected user from slash command options.
- Inserts an immutable event into `rag_events`.
- Upserts and increments aggregate count in `rag_totals`.
- Responds with the tagged user and their new total.

### `/ragboard`

- Queries top 10 users in `rag_totals` ordered by count descending.
- Responds with a ranked leaderboard.

## Data Model

`rag_events`
- `id`: integer primary key
- `ragged_user_id`: Discord user id being tagged
- `ragged_username`: username snapshot at event time
- `reported_by_user_id`: Discord user id who issued `/rag`
- `reported_by_username`: username snapshot of reporter
- `created_at`: event timestamp

`rag_totals`
- `ragged_user_id`: primary key
- `ragged_username`: latest username seen
- `rag_count`: counter
- `updated_at`: last update timestamp

## Runtime and Security

- Runtime: Cloudflare Worker (`src/index.ts`)
- Persistence: D1 (`DB` binding)
- Signature verification: Discord Ed25519 headers + request body
- Any request with invalid signature returns `401`.
- Only interaction POST requests are processed.

## Deployment Shape

- Worker endpoint is configured as Discord interactions endpoint URL.
- Commands are registered globally through Discord REST API using `scripts/register-commands.ts`.
- D1 schema is applied from `schema.sql`.
