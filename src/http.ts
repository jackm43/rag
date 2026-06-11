import nacl from "tweetnacl";

import type { DiscordInteraction } from "./types";

const encoder = new TextEncoder();

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

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

export const verifyDiscordRequest = async (
  request: Request,
  publicKey: string,
): Promise<DiscordInteraction | null> => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return null;
  }

  const signatureBytes = hexToBytes(signature);
  const publicKeyBytes = hexToBytes(publicKey);
  if (!signatureBytes || signatureBytes.length !== 64 || !publicKeyBytes || publicKeyBytes.length !== 32) {
    return null;
  }

  const rawBody = await request.text();
  let isValid = false;
  try {
    isValid = nacl.sign.detached.verify(
      encoder.encode(timestamp + rawBody),
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
    return JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return null;
  }
};

// Constant-time string comparison via fixed-length digests, safe for secrets
// of differing lengths.
export const secretsMatch = async (actual: string, expected: string) => {
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", actualBytes),
    crypto.subtle.digest("SHA-256", expectedBytes),
  ]);
  const actualDigest = new Uint8Array(actualHash);
  const expectedDigest = new Uint8Array(expectedHash);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < actualDigest.length; index += 1) {
    difference |= actualDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
};
