// Discord interaction request verification: Ed25519 over the timestamp plus the exact body.

// Names follow Oceanic's Constants (MIT, OceanicJS/Oceanic).
export const InteractionTypes = { PING: 1, APPLICATION_COMMAND: 2 } as const;
export const InteractionResponseTypes = { PONG: 1, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 } as const;

/**
 * Read a signed interaction request. Returns 401 for a bad or stale signature (checked before
 * anything is parsed), 400 for an unparseable body, or the parsed interaction.
 */
export async function readInteraction(request: Request, publicKey: string): Promise<any> {
  const body = await request.arrayBuffer();
  if (!(await verified(request.headers, body, publicKey))) return 401;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return 400;
  }
}

async function verified(headers: Headers, body: ArrayBuffer, publicKey: string) {
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (!publicKey || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(publicKey), "Ed25519", false, ["verify"]);
    const message = await new Blob([timestamp, body]).arrayBuffer();
    return await crypto.subtle.verify("Ed25519", key, hex(signature), message);
  } catch {
    return false;
  }
}

function hex(value: string) {
  if (!/^(?:[\da-f]{2})+$/i.test(value)) throw new Error("invalid hex");
  return Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
}
