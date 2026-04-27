import nacl from "tweetnacl";

import type { DiscordInteraction } from "./types";

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

export const verifyDiscordRequest = async (request: Request, publicKey: string) => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return null;
  }

  const rawBody = await request.text();
  const isValid = nacl.sign.detached.verify(
    new TextEncoder().encode(timestamp + rawBody),
    hexToBytes(signature),
    hexToBytes(publicKey),
  );

  if (!isValid) {
    return null;
  }

  return JSON.parse(rawBody) as DiscordInteraction;
};
