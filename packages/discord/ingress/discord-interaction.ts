import { guardDenial, type InboundGuard } from "@rag/auth-kit/guard";
import { verifyDiscordSignature } from "@rag/auth-kit/discord";
import type { DiscordInteraction } from "../contracts";
import { isDiscordInteraction } from "../contracts";

// Verifies Discord's Ed25519 signature (neutral, in @rag/auth-kit) and then
// applies the bot's interaction-shape validation, so callers get a fully-typed
// DiscordInteraction or null.
export const verifyDiscordRequest = async (
  request: Request,
  publicKey: string,
): Promise<DiscordInteraction | null> => {
  const parsed = await verifyDiscordSignature(request, publicKey);
  return parsed !== null && isDiscordInteraction(parsed) ? parsed : null;
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
