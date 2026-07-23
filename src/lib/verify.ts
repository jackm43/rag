import nacl from "tweetnacl";

// Ed25519 verification of a Discord interaction request: Discord signs
// `timestamp + rawBody` with the application's public key, so a valid
// signature authenticates Discord itself. Ported from packages/auth-kit/discord.ts,
// adapted to take the already-buffered rawBody (the caller reads the body
// exactly once) and to return a plain boolean instead of the parsed payload.
const encoder = new TextEncoder();
const DISCORD_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;
const DISCORD_SIGNATURE_PATTERN = /^[0-9a-fA-F]{128}$/;
const DISCORD_TIMESTAMP_PATTERN = /^\d+$/;

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

export const verifyDiscordSignature = (publicKeyHex: string, req: Request, rawBody: string): boolean => {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  if (signature === null || timestamp === null) {
    return false;
  }

  if (!DISCORD_SIGNATURE_PATTERN.test(signature) || !DISCORD_TIMESTAMP_PATTERN.test(timestamp)) {
    return false;
  }

  if (!isFreshDiscordTimestamp(timestamp)) {
    return false;
  }

  const signatureBytes = hexToBytes(signature);
  const publicKeyBytes = hexToBytes(publicKeyHex);
  if (!signatureBytes || signatureBytes.length !== 64 || !publicKeyBytes || publicKeyBytes.length !== 32) {
    return false;
  }

  try {
    return nacl.sign.detached.verify(
      encoder.encode(timestamp + rawBody),
      signatureBytes,
      publicKeyBytes,
    );
  } catch {
    return false;
  }
};
