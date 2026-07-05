import { DurableObject } from "cloudflare:workers";

import type { Env } from "../contracts";
import {
  isEgressProfileName,
  isEgressProfileConfig,
  type EgressProfileConfig,
} from "@rag/egress/config";
import { logger } from "@rag/logger";

const PROFILE_PREFIX = "profile:";

type ControlMeta = {
  version: number;
  updatedAt: string;
};
const META_KEY = "meta";

export class EgressControl extends DurableObject<Env> {
  async getProfile(profile: string): Promise<EgressProfileConfig | null> {
    if (!isEgressProfileName(profile)) {
      return null;
    }
    const value = await this.ctx.storage.get<unknown>(`${PROFILE_PREFIX}${profile}`);
    return isEgressProfileConfig(value) ? value : null;
  }

  async putProfile(profile: string, config: EgressProfileConfig): Promise<void> {
    if (!isEgressProfileName(profile)) {
      throw new Error("Invalid egress profile name");
    }
    if (!isEgressProfileConfig(config)) {
      throw new Error("Invalid egress profile config");
    }
    await this.ctx.storage.put(`${PROFILE_PREFIX}${profile}`, config);
    await this.ctx.storage.put(META_KEY, {
      version: Date.now(),
      updatedAt: new Date().toISOString(),
    } satisfies ControlMeta);
    logger.info("egress_profile_updated", { profile });
  }

  async snapshot(): Promise<Record<string, EgressProfileConfig>> {
    const stored = await this.ctx.storage.list<EgressProfileConfig>({ prefix: PROFILE_PREFIX });
    const profiles: Record<string, EgressProfileConfig> = {};
    for (const [key, config] of stored) {
      const profile = key.slice(PROFILE_PREFIX.length);
      if (isEgressProfileConfig(config)) {
        profiles[profile] = config;
      }
    }
    return profiles;
  }
}
