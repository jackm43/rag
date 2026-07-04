// Local scaffolder. Three generators, one per "how do I add a thing":
//
//   pnpm run scaffold app <id> [--display "Name"] [--description "…"]
//        [--route "METHOD /path operationId service.operation"]...
//     A full application under apps/<id>: middleware_client + service_server
//     workers, wrangler configs, workspace package.json, registry metadata.
//     Reuses the registry's buildApplicationScaffold, so the local command and
//     the registry PR flow can never drift.
//
//   pnpm run scaffold worker <id> --app <bot|connectors|platform> [--queue <name>]
//     An internal service worker (no public route) inside an existing app:
//     wrangler.jsonc + src/index.ts (queue consumer when --queue, otherwise a
//     WorkerEntrypoint skeleton).
//
//   pnpm run scaffold connector <id> --kind <api_key|oauth2_client_credentials>
//        --host <api.host> --secret-ref <ENV_NAME> [--caller <principal>]
//     Connectors are config, not code — this prints the exact registry entry,
//     Cedar permits, and secret command to paste (the registry entry deserves
//     human eyes, so nothing is written).
//
// Generated code compiles immediately (app-service principals are pre-declared
// or cast); the remaining manual steps are printed at the end of each run.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApplicationScaffold } from "@rag/platform/lib/registry-kit/scaffold";
import type { RegistryRoute } from "@rag/platform/lib/registry-kit/types";
import { REGISTRY_APPLICATION_ID_PATTERN } from "@rag/platform/lib/registry-kit/types";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const [command, id, ...rest] = process.argv.slice(2);

const flags = new Map<string, string[]>();
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index].startsWith("--")) {
    const key = rest[index].slice(2);
    const value = rest[index + 1] && !rest[index + 1].startsWith("--") ? rest[++index] : "";
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
}
const flag = (name: string): string | undefined => flags.get(name)?.at(-1) || undefined;

const usage = (): never => {
  console.error(
    [
      "usage:",
      '  pnpm run scaffold app <id> [--display "Name"] [--description "…"] [--route "GET /api/x opId svc.op"]...',
      "  pnpm run scaffold worker <id> --app <bot|connectors|platform> [--queue <queue-name>]",
      "  pnpm run scaffold connector <id> --kind <api_key|oauth2_client_credentials> --host <host> --secret-ref <ENV> [--caller workflows]",
    ].join("\n"),
  );
  process.exit(1);
};

const write = (relPath: string, content: string): void => {
  const full = join(root, relPath);
  if (existsSync(full)) {
    throw new Error(`refusing to overwrite ${relPath}`);
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log(`  wrote ${relPath}`);
};

// Insert worker names into scripts/deploy.ts DEPLOY_ORDER so `pnpm run deploy`
// keeps working (it fails loudly on discovered-but-unlisted workers).
const registerInDeployOrder = (workerNames: string[]): void => {
  const deployPath = join(root, "scripts/deploy.ts");
  let source = readFileSync(deployPath, "utf8");
  const anchor = '  "ragbot-spend-worker",\n';
  if (!source.includes(anchor)) {
    console.log(`  ! could not find the DEPLOY_ORDER anchor — add ${workerNames.join(", ")} to scripts/deploy.ts by hand`);
    return;
  }
  const lines = workerNames.map((name) => `  ${JSON.stringify(name)},\n`).join("");
  source = source.replace(anchor, anchor + lines);
  writeFileSync(deployPath, source);
  console.log(`  registered in scripts/deploy.ts DEPLOY_ORDER: ${workerNames.join(", ")}`);
};

const scaffoldApp = async (): Promise<void> => {
  if (!id || !REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
    console.error(`app id must match ${REGISTRY_APPLICATION_ID_PATTERN}`);
    usage();
  }
  if (existsSync(join(root, "apps", id))) {
    throw new Error(`apps/${id} already exists`);
  }
  const routes: RegistryRoute[] = (flags.get("route") ?? []).map((spec) => {
    const [method, path, operationId, serviceOperation] = spec.split(/\s+/);
    if (!method || !path || !operationId || !serviceOperation) {
      throw new Error(`--route wants "METHOD /path operationId service.operation", got "${spec}"`);
    }
    return { method: method.toUpperCase(), path, operationId, serviceOperation };
  });
  if (routes.length === 0) {
    routes.push({
      method: "GET",
      path: `/api/${id}`,
      operationId: `${id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Get`,
      serviceOperation: "application.request",
    });
  }
  const displayName = flag("display") ?? id;
  const scaffold = await buildApplicationScaffold({
    id,
    displayName,
    description: flag("description"),
    ownerDiscordId: "local-scaffold",
    ownerAccessSub: "local-scaffold",
    zone: "application",
    status: "scaffolded",
    requestedAt: new Date().toISOString(),
    targets: [],
    operations: ["application.request"],
    routes,
  });
  console.log(`scaffolding application ${id}:`);
  for (const artifact of scaffold.artifacts) {
    write(artifact.path, artifact.content);
  }
  registerInDeployOrder([`ragbot-${id}-service-worker`, `ragbot-${id}-api-worker`]);
  console.log(`
next steps:
  1. pnpm install                      # link the new workspace package
  2. pnpm run check && pnpm test
  3. implement the 501 handlers in apps/${id}/workers/${id}/service_server/src/handlers.ts
  4. linked-app token pair (see AGENTS.md):
       wrangler secret put LINKED_APP_TOKEN        -c apps/${id}/workers/${id}/api/middleware_client/wrangler.jsonc
       pnpm run linked-app-token:hash -- <token>   # then:
       wrangler secret put LINKED_APP_TOKEN_SHA256 -c apps/${id}/workers/${id}/service_server/wrangler.jsonc
  5. deploy: pnpm run deploy -- --only ${id}-service,${id}-api (gateway must already be deployed)`);
};

const scaffoldWorker = (): void => {
  const app = flag("app");
  if (!id || !/^[a-z][a-z0-9-]{1,30}$/.test(id) || !app || !["bot", "connectors", "platform"].includes(app)) {
    usage();
  }
  const dir = `apps/${app}/workers/${id}`;
  if (existsSync(join(root, dir))) {
    throw new Error(`${dir} already exists`);
  }
  const queue = flag("queue");
  const workerName = `ragbot-${id}-worker`;
  console.log(`scaffolding internal service worker ${workerName} in apps/${app}:`);

  write(`${dir}/wrangler.jsonc`, `${JSON.stringify(
    {
      name: workerName,
      main: "src/index.ts",
      compatibility_date: "2026-04-23",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      rules: [{ type: "Text", globs: ["**/*.cedar"], fallthrough: true }],
      durable_objects: {
        bindings: [
          { name: "SERVICE_REGISTRY", class_name: "ServiceRegistry", script_name: "ragbot-registry-worker" },
        ],
      },
      ...(queue
        ? {
            queues: {
              consumers: [{ queue, max_batch_size: 1, dead_letter_queue: `${queue}-dlq` }],
            },
          }
        : {}),
      observability: { logs: { enabled: true, invocation_logs: true }, traces: { enabled: true } },
    },
    null,
    2,
  )}\n`);

  const consumerBody = queue
    ? `import { createQueueWorker } from "@rag/service-kit/queue-worker";
import type { Env } from "../../../contracts";
import { MANIFEST } from "./manifest";

export default {
  ...createQueueWorker<Env>(MANIFEST, {
    ${JSON.stringify(queue)}: async (message, env) => {
      // Verified receive first — decode with your app-contract decoder via
      // createServiceServer(...).receive(message.body, decode, "queue"),
      // then process. Ack/retry is yours past this point.
      message.ack();
    },
  }),
};
`
    : `import { WorkerEntrypoint } from "cloudflare:workers";
import { ensureRegistered } from "@rag/service-kit";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import type { Env } from "../../../contracts";
import { MANIFEST } from "./manifest";

export class ${id.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase())}Service extends WorkerEntrypoint<Env> {
  async invoke(message: ServiceMessageBytes): Promise<{ status: number; body: unknown }> {
    await ensureRegistered(this.env, MANIFEST);
    // Verified receive first — createServiceServer(...).receive(message,
    // decode, "binding") — then dispatch. Fail closed on null.
    return { status: 501, body: { error: "not_implemented" } };
  }
}

export default {
  async fetch(_request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, MANIFEST));
    return new Response("Not found", { status: 404 });
  },
};
`;

  write(`${dir}/src/manifest.ts`, `import type { MachinePrincipal, TrustZone } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

// TODO: add ${JSON.stringify(id)} to the MachinePrincipal union in
// packages/service-kit/principal.ts and drop these casts.
export const MANIFEST = {
  service: ${JSON.stringify(id)} as MachinePrincipal,
  zone: "application" as TrustZone,
  targets: [] as MachinePrincipal[],
  operations: [],
} satisfies ServiceManifest;
`);
  write(`${dir}/src/index.ts`, consumerBody);
  registerInDeployOrder([workerName]);
  console.log(`
next steps:
  1. add ${JSON.stringify(id)} to MachinePrincipal (packages/service-kit/principal.ts) and remove the casts
  2. register operations in the manifest + Cedar bootstrap permits (packages/authz/policies/services.cedar)
  3. if it initiates hops: tsx scripts/generate-keys.ts ${id}; public JWK -> service-kit/identity/keyring.ts;
     private JWK -> wrangler secret put ${id.toUpperCase().replace(/-/g, "_")}_SIGNING_KEY -c ${dir}/wrangler.jsonc${queue ? `
  4. create the queues: wrangler queues create ${queue} && wrangler queues create ${queue}-dlq` : ""}
  ${queue ? "5" : "4"}. pnpm run check && pnpm test, then deploy`);
};

const scaffoldConnector = (): void => {
  const kind = flag("kind");
  const host = flag("host");
  const secretRef = flag("secret-ref");
  const caller = flag("caller") ?? "workflows";
  if (!id || !kind || !host || !secretRef || !["api_key", "oauth2_client_credentials"].includes(kind)) {
    usage();
  }
  const entry =
    kind === "api_key"
      ? `  {
    id: ${JSON.stringify(id)},
    kind: "api_key",
    host: ${JSON.stringify(host)},            // the ONLY host this connector may reach
    cedarResource: ${JSON.stringify(id)},
    secret: { provider: "wrangler-env", ref: ${JSON.stringify(secretRef)} },
    headerTemplate: { header: "authorization", scheme: "Bearer" },
  },`
      : `  {
    id: ${JSON.stringify(id)},
    kind: "oauth2_client_credentials",
    host: ${JSON.stringify(host)},
    cedarResource: ${JSON.stringify(id)},
    tokenUrl: "https://auth.example.com/oauth/token",   // EDIT ME
    clientId: "example-client-id",                       // EDIT ME
    secret: { provider: "wrangler-env", ref: ${JSON.stringify(secretRef)} },
    defaultScopes: [],
  },`;
  console.log(`connectors are config — paste these three pieces:

1. registry entry -> apps/connectors/lib/registry.ts (CONNECTOR_REGISTRY):

${entry}

2. Cedar permits -> packages/authz/policies/connectors.cedar:

@id("${caller}-${id}-grant")
permit (principal == Machine::"${caller}", action == Action::"connector.grant",
        resource == Connector::${JSON.stringify(id)});
@id("${caller}-${id}-fetch")
permit (principal == Machine::"${caller}", action == Action::"connector.fetch",
        resource == Connector::${JSON.stringify(id)});

3. the secret:

wrangler secret put ${secretRef} -c apps/connectors/workers/broker/wrangler.jsonc

If ${JSON.stringify(caller)} is not already a broker caller: add it to CONNECTOR_CALLERS
(apps/connectors/lib/handler.ts), give it the ${caller} -> connectors hop permits +
manifest target, and bind CONNECTORS on its worker (see AGENTS.md).`);
};

if (command === "app") await scaffoldApp();
else if (command === "worker") scaffoldWorker();
else if (command === "connector") scaffoldConnector();
else usage();
