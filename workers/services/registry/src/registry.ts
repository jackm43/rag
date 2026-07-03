import { DurableObject } from "cloudflare:workers";

import {
  decodeServiceManifest,
  encodeManifestSnapshot,
  type WireServiceManifest,
} from "../../../../packages/contracts";
import { isServiceManifest } from "../../../../packages/auth/manifest";
import { logger } from "../../../../packages/logger";
import type { Env } from "../../../../packages/contracts/types";

// Service registry: workers register their manifest (zone, targets,
// operations) over the SERVICE_REGISTRY binding, and the Cedar authorizer
// consumes the registry snapshot. Both RPC payloads are capnp bytes
// (service.capnp): ServiceManifest in, ManifestSnapshot out — the same
// generated contract layer as the queue envelopes. The registry lives in the
// trusted zone in its own worker so no routed, internet-facing worker owns it;
// only workers configured with the binding can reach it.
//
// Position calculation happens on the consumer (packages/auth/manifest.ts,
// manifestsToEntities): a service's CLIENTS are derived from the OTHER
// manifests' declared targets — a service cannot grant callers access to
// itself, and a caller only gains access when policy (services.cedar) accepts
// the resulting entity attributes.

const MANIFEST_PREFIX = "manifest:";

export class ServiceRegistry extends DurableObject<Env> {
  async register(manifest: unknown): Promise<void> {
    const decoded = decodeServiceManifest(manifest);
    if (!decoded || !isServiceManifest(decoded)) {
      throw new Error("Invalid service manifest");
    }
    await this.ctx.storage.put(`${MANIFEST_PREFIX}${decoded.service}`, decoded);
    logger.info("service_registered", {
      service: decoded.service,
      zone: decoded.zone,
      targets: decoded.targets,
    });
  }

  async snapshot(): Promise<Uint8Array> {
    const stored = await this.ctx.storage.list<WireServiceManifest>({ prefix: MANIFEST_PREFIX });
    return encodeManifestSnapshot([...stored.values()]);
  }
}
