# Design: centralise service-to-service tokens through the broker (STS)

## DECISION (resolved): do NOT centralise signing — keep per-worker signing

After weighing it, per-worker Ed25519 signing is kept for service-to-service
AUTHENTICATION; the broker is NOT made the central token issuer. Rationale:
- **Blast radius:** a compromised worker leaks only its own hops; one central STS
  key would let a broker compromise forge every hop. Distributed keys win.
- **Availability:** per-worker signing keeps the broker off the hot path; central
  issuance makes it a hard dependency on every hop.
- **The "single pattern" goal is already met at the AUTHORIZATION layer:** Cedar is
  the one authorizer for every service hop (`service.invoke`) AND every connector op
  (`connector.*`). Every hop is authenticated by a signed identity-context token
  (caller `iss` + subject `sub` + `act` chain) and authorized by that one engine.
- The broker remains the central authority for EXTERNAL provider credentials
  (connectors) — where centralisation genuinely helps (secrets never spread).

Adopted from the review instead: **built-in key rotation for the per-worker keys**
(primary + previous public key per principal, dual-accept window, rotation runbook) —
the "rotation built-in" instinct applied without collapsing to a single key.

The STS design below is retained for the record / future reconsideration; it is NOT
being implemented.

---

**Status: NOT ADOPTED (see decision above).** Retained for the record.

## Today (decentralised)

Each sending worker holds its **own** Ed25519 signing key (`GATEWAY_SIGNING_KEY`,
`BRAIN_SIGNING_KEY`, `DEV_PROXY_SIGNING_KEY`) and mints its own identity-context token per
hop. Receivers verify with the committed/`SERVICE_PUBLIC_KEYS` keyring + Cedar. Strengths:
no broker on the hot path; simple. Weaknesses: signing keys spread across workers; issuance
isn't centrally audited; two different patterns (inter-service tokens vs connector grants).

## Target (broker as STS — Security Token Service)

The credential broker becomes the **single issuer** of inter-service tokens, exactly the
same "you present identity, you get a scoped token" exchange the connectors already do — so
a service calling another service is just another connector flow (`kind: "service"`).

```
SENDER (e.g. gateway → ai)                          RECEIVER (ai)
  1. authorize the call            [Cedar decision, cached]
  2. broker.exchangeServiceToken({aud:"ai", sub, act})   ── binding ──▶  BROKER (STS)
       └─ returns a short-lived token (broker-signed)                     signs with the
  3. call ai with that token       ── binding/queue ──▶                   single STS key
                                                          verify token (cached STS JWKS)
                                                          + Cedar service.invoke
```

Key points, mapped to what you described:
- **"Authorizers have a fast cache to authorize the call, then invoke the token-exchange
  RPC."** The SENDER authorizes locally against a **cached Cedar decision** (per
  `{caller, aud, action}`, short TTL). On allow, it calls `broker.exchangeServiceToken`
  over the binding to get the token. The sender is a *client* of the token-exchange, exactly
  like a connector caller — same `serviceClients`/`connectorsClient` shape.
- **Token reuse amortises the broker hop.** An issued token is valid for its lifetime
  (~60s) and cached by the sender keyed by `{aud, sub}`, so the exchange RPC runs about once
  per minute per destination, not per call — the broker is not on every request's hot path.
- **Receivers don't call the broker.** They verify the broker-signed token with the broker's
  **public** key (a JWKS the receiver caches and refreshes periodically) + Cedar. Same
  `createServiceServer` pipeline; only the key source changes (broker JWKS instead of the
  per-worker keyring).
- **Central audit + one key to rotate.** Every inter-service token issuance is logged at the
  broker with the full actor chain; there is one STS signing key to rotate, not N.

## What changes in code

- **Broker:** add `exchangeServiceToken({audience, subject, act, ttl})` RPC (a `service`
  connector kind). Broker holds the STS signing key (from the secrets-provider module) and
  exposes its public JWKS via an RPC/endpoint receivers can cache.
- **`packages/identity`:** the keyring resolver gains a broker-JWKS source (cached), used
  alongside the committed keyring during migration.
- **`packages/auth` client:** `serviceClients(env).X` senders call the broker exchange
  (cached) instead of local `mint()`; drop per-worker signing keys once migrated.
- **`packages/authz`:** a `service.exchange`/`token.issue` Cedar action gating who may
  request a token for which audience (the issuance decision), plus the existing
  `service.invoke` at the receiver.

## Migration (phased, reversible, no downtime)

1. **Add, don't switch.** Ship the broker `exchangeServiceToken` + STS key + JWKS endpoint.
   Nothing uses it yet.
2. **Dual-verify.** Receivers accept EITHER a per-worker-signed token (today) OR a
   broker-signed token (verify against both keyrings). Deploy receivers first.
3. **Flip senders one at a time** behind a per-sender flag (`USE_STS=true`): gateway→ai,
   then ai→responder, ai→spend, dev-proxy→gateway. Each sender starts exchanging via the
   broker; receivers already accept it. Roll back a sender by clearing its flag.
4. **Retire** per-worker signing keys + the committed keyring once all senders are on STS
   and stable. Receivers verify only the broker JWKS.

Rollback at any phase = clear the sender flag (falls back to local signing, still accepted).
The broker being unavailable degrades to: senders can't get new tokens → calls fail closed
(they do NOT fall back to unsigned). Mitigated by the ~60s token cache + broker being a
low-latency binding (same account, in-region).

## Open questions for you

1. **Broker on the critical path** — acceptable given the caller-side token cache (≈1
   exchange/min/destination)? Or keep a permanent per-worker-signing fallback for
   resilience if the broker is down?
2. **One STS key vs a key per audience** — single key is simpler; per-audience keys limit
   blast radius. Recommend single key + rotation via the secrets provider.
3. **Scope of first cut** — do all four hops, or prove it on gateway→ai first then fan out?

## Recommendation

Proceed with the phased plan, single STS key sourced from the secrets-provider module,
prove it on **gateway→ai** first (behind a flag) before fanning out. This makes the broker
the one credential/token authority for both external providers and internal hops, exactly
the single pattern you want — while never leaving the live mesh unverifiable during cutover.
