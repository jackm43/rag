import nacl from "tweetnacl";

import { guardDenial, type InboundGuard } from "./guard";
import type { DiscordInteraction } from "../../contracts/types";
import { isDiscordInteraction } from "../../contracts/validation";

const encoder = new TextEncoder();
const DISCORD_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;
const DISCORD_SIGNATURE_PATTERN = /^[0-9a-fA-F]{128}$/;
const DISCORD_TIMESTAMP_PATTERN = /^\d+$/;
const REQUIRED_DISCORD_SECURITY_HEADERS = [
  "x-signature-ed25519",
  "x-signature-timestamp",
] as const;

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

const isFreshDiscordTimestamp = (timestamp: string, nowMs = Date.now()) => {
  if (!DISCORD_TIMESTAMP_PATTERN.test(timestamp)) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return false;
  }

  const timestampMs = timestampSeconds * 1000;
  return Math.abs(nowMs - timestampMs) <= DISCORD_SIGNATURE_MAX_SKEW_SECONDS * 1000;
};

const getRequiredDiscordSecurityHeaders = (request: Request) => {
  const values = REQUIRED_DISCORD_SECURITY_HEADERS.map((header) => request.headers.get(header));
  if (values.some((value) => value === null)) {
    return null;
  }

  const [signature, timestamp] = values as [string, string];
  return { signature, timestamp };
};

const hasWellFormedDiscordSecurityHeaders = (headers: {
  signature: string;
  timestamp: string;
}) => {
  return DISCORD_SIGNATURE_PATTERN.test(headers.signature) && DISCORD_TIMESTAMP_PATTERN.test(headers.timestamp);
};

export const verifyDiscordRequest = async (
  request: Request,
  publicKey: string,
): Promise<DiscordInteraction | null> => {
  const headers = getRequiredDiscordSecurityHeaders(request);
  if (!headers || !hasWellFormedDiscordSecurityHeaders(headers)) {
    return null;
  }

  if (!isFreshDiscordTimestamp(headers.timestamp)) {
    return null;
  }

  const signatureBytes = hexToBytes(headers.signature);
  const publicKeyBytes = hexToBytes(publicKey);
  if (!signatureBytes || signatureBytes.length !== 64 || !publicKeyBytes || publicKeyBytes.length !== 32) {
    return null;
  }

  const rawBody = await request.text();
  let isValid = false;
  try {
    isValid = nacl.sign.detached.verify(
      encoder.encode(headers.timestamp + rawBody),
      signatureBytes,
      publicKeyBytes,
    );
  } catch {
    return null;
  }

  if (!isValid) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawBody);
    return isDiscordInteraction(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export type DiscordInteractionPrincipal = {
  principal: "discord";
  interaction: DiscordInteraction;
};

// Ed25519 signature verification + interaction shape validation for
// POST /discord. Discord signs timestamp+body with the app's key, so a valid
// signature authenticates Discord itself as the principal.
export const discordInteractionGuard: InboundGuard<DiscordInteractionPrincipal> = {
  identity: "discord-interactions",
  verify: async (request, env) => {
    const interaction = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!interaction) {
      return guardDenial(
        discordInteractionGuard,
        "invalid_signature",
        new Response("Bad request signature", { status: 401 }),
      );
    }
    return { ok: true, grant: { principal: "discord", interaction } };
  },
};
