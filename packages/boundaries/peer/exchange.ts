import { logPeerDenial, wrapPeerMessage, type PeerTrustZone } from "./peer";
import {
  buildIdentityContext,
  mint,
  type WorkerIdentity,
} from "../../identity";
import type { Env, PeerQueueMessage, ResponderAttachment } from "../../contracts/types";

// Sending side of the peer boundary: on every hop the sending worker mints a
// fresh identity-context token on behalf of the OAuth-client principal (the
// Discord user, or "system"). At ingress the gateway mints the ORIGIN context;
// each subsequent hop re-mints (RFC 8693 token exchange) with iss=itself,
// aud=the next worker, and the actor chain extended — carrying the SAME sub.

// The trust zone each worker occupies. A hop whose source and target zones
// differ is a trust-zone TRANSITION, which is exactly when an on-behalf-of
// token exchange is required (see createPeerQueueSender / createPeerBindingSender
// and the construction-time authorization added on top of them).
export const WORKER_ZONE: Record<WorkerIdentity, string> = {
  gateway: "edge",
  brain: "brain",
  responder: "egress",
  spend: "spend",
};

// The principal a token is minted on behalf of, plus the inbound actor chain so
// re-minting hops can extend it.
export type OnBehalf = {
  sub: string;
  act?: WorkerIdentity[];
};

export type PeerSenderConfig = {
  self: WorkerIdentity;
  target: WorkerIdentity;
  // Lazily-resolved, memoised signing key: null when the worker has no signing
  // secret provisioned (a same-zone/unauthorized construction, or missing
  // material — fail closed).
  signingKey: () => Promise<CryptoKey | null>;
};

export type PeerQueueSendOptions = { delaySeconds?: number };

export type PeerQueueSender = {
  send: (
    queue: Queue<PeerQueueMessage>,
    envelope: Uint8Array,
    onBehalf: OnBehalf,
    options?: PeerQueueSendOptions,
  ) => Promise<void>;
};

export type PeerBindingSender = {
  send: (
    env: Env,
    envelope: Uint8Array,
    attachment: ResponderAttachment,
    onBehalf: OnBehalf,
  ) => Promise<void>;
};

// Mint the on-behalf-of token for a hop, or null when no signing key is
// available (caller fails closed).
const mintExchange = async (
  config: PeerSenderConfig,
  envelope: Uint8Array,
  onBehalf: OnBehalf,
): Promise<string | null> => {
  const key = await config.signingKey();
  if (!key) {
    return null;
  }
  const context = await buildIdentityContext({
    iss: config.self,
    aud: config.target,
    sub: onBehalf.sub,
    act: onBehalf.act,
    trustZone: WORKER_ZONE[config.self],
    envelopeBytes: envelope,
  });
  return mint(key, context);
};

const denySend = (config: PeerSenderConfig, trustZone: PeerTrustZone): Error => {
  logPeerDenial({ identity: config.self, trustZone }, "signing_key_unavailable");
  return new Error(
    `Peer send denied for ${config.self} -> ${config.target}: no signing key available`,
  );
};

export const createPeerQueueSender = (config: PeerSenderConfig): PeerQueueSender => ({
  send: async (queue, envelope, onBehalf, options) => {
    const token = await mintExchange(config, envelope, onBehalf);
    if (token === null) {
      throw denySend(config, "peer-queue");
    }
    await queue.send(
      wrapPeerMessage(envelope, token),
      options?.delaySeconds === undefined ? undefined : { delaySeconds: options.delaySeconds },
    );
  },
});

export const createPeerBindingSender = (config: PeerSenderConfig): PeerBindingSender => ({
  send: async (env, envelope, attachment, onBehalf) => {
    if (!env.RESPONDER) {
      throw new Error("RESPONDER service binding is required to send media replies");
    }
    const token = await mintExchange(config, envelope, onBehalf);
    if (token === null) {
      throw denySend(config, "peer-binding");
    }
    await env.RESPONDER.deliverInteractionEdit(envelope, attachment, token);
  },
});
