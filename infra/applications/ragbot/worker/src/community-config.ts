import { ConnectError, Code } from "@connectrpc/connect";

import type { Identity } from "@platy/sdk";

const COMMUNITY_CONFIG_KEYS = new Set([
  "ai_response_model",
  "ai_mention_model",
  "ai_roast_model",
  "ai_system_prompt",
  "ai_roast_system_prompt",
]);

export const isPortalActor = (identity: Identity): boolean =>
  identity.actorChain.some((clientId) => clientId.startsWith("svc_portal_"));

export const requireCommunityConfigKey = (identity: Identity, key: string): void => {
  if (!isPortalActor(identity)) {
    return;
  }
  if (!COMMUNITY_CONFIG_KEYS.has(key)) {
    throw new ConnectError(`config key ${key} is not community-editable`, Code.PermissionDenied);
  }
};
