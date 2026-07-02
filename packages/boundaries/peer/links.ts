import {
  createPeerBindingSender,
  createPeerQueueSender,
  type PeerBindingSender,
  type PeerQueueSender,
} from "./exchange";
import { importSigningKey } from "../../identity";
import { errorMessage, logger } from "../../logger";
import type { Env } from "../../contracts/types";

// Per-worker peer links: the ready-to-use senders for every legitimate hop,
// each pre-bound to the sending worker's signing key. Only the workers that
// send hold a key (gateway mints origin contexts; brain re-mints downstream),
// so a worker that never uses a given link never imports its (absent) key.

export type PeerLinks = {
  gatewayToBrain: PeerQueueSender;
  brainToResponderOutbox: PeerQueueSender;
  brainToResponderMedia: PeerBindingSender;
  brainToSpend: PeerQueueSender;
};

type SigningSecret = "GATEWAY_SIGNING_KEY" | "BRAIN_SIGNING_KEY";

// Import a private signing key from its secret (private JWK JSON). Absent or
// unparseable keys resolve to null so the sender fails closed with a logged
// denial rather than throwing an opaque error.
const loadSigningKey = async (env: Env, secret: SigningSecret): Promise<CryptoKey | null> => {
  const raw = env[secret];
  if (!raw) {
    logger.warn("peer_signing_key_missing", { secret });
    return null;
  }
  try {
    return await importSigningKey(JSON.parse(raw) as JsonWebKey);
  } catch (error) {
    logger.warn("peer_signing_key_invalid", { secret, error: errorMessage(error) });
    return null;
  }
};

// Memoise a lazily-computed promise so the key is imported at most once per env.
const memo = <T>(create: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => (cached ??= create());
};

const buildLinks = (env: Env): PeerLinks => {
  const gatewayKey = memo(() => loadSigningKey(env, "GATEWAY_SIGNING_KEY"));
  const brainKey = memo(() => loadSigningKey(env, "BRAIN_SIGNING_KEY"));

  return {
    gatewayToBrain: createPeerQueueSender({ self: "gateway", target: "brain", signingKey: gatewayKey }),
    brainToResponderOutbox: createPeerQueueSender({ self: "brain", target: "responder", signingKey: brainKey }),
    brainToResponderMedia: createPeerBindingSender({ self: "brain", target: "responder", signingKey: brainKey }),
    brainToSpend: createPeerQueueSender({ self: "brain", target: "spend", signingKey: brainKey }),
  };
};

const linksByEnv = new WeakMap<Env, PeerLinks>();

export const peerLinks = (env: Env): PeerLinks => {
  const cached = linksByEnv.get(env);
  if (cached) {
    return cached;
  }
  const links = buildLinks(env);
  linksByEnv.set(env, links);
  return links;
};
