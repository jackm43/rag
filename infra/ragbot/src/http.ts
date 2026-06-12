import { secretsMatch, verifySignedWebhook } from "../../sdk/ts/src";

import type { DiscordInteraction } from "./types";

export { secretsMatch };

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const verifyDiscordRequest = async (
  request: Request,
  publicKey: string,
): Promise<DiscordInteraction | null> => {
  const rawBody = await verifySignedWebhook(request, { publicKey });
  if (rawBody === null) {
    return null;
  }
  try {
    return JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return null;
  }
};
