// Scaffolder: `pnpm scaffold <name>` generates a complete, compiling, test-green
// top-level application under apps/<name>, ready to work on immediately. A new
// app is its wrangler config, a package.json, and an index.ts built on
// createAppWorker (the shared edge middleware) with one sample authenticated
// route + one sample RPC method. Authentication and authorization are handled
// for you by the auth worker (bound as AUTH); the scaffolder seeds a policy
// entry so the sample route is authorized out of the box.
//
// After running: `pnpm install` (link the new workspace package), then
// `pnpm run check && pnpm test`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

const [name] = process.argv.slice(2);
if (!name || !NAME_PATTERN.test(name)) {
  console.error("usage: pnpm scaffold <name>   (name: lowercase, 2-31 chars, [a-z0-9-])");
  process.exit(1);
}

const appDir = join(root, "apps", name);
if (existsSync(appDir)) {
  throw new Error(`apps/${name} already exists`);
}

const workerName = `ragbot-${name}-worker`;
const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const write = (relPath: string, content: string): void => {
  const full = join(appDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log(`  wrote apps/${name}/${relPath}`);
};

// --- package.json --------------------------------------------------------
write(
  "package.json",
  JSON.stringify(
    {
      name: `@rag/${name}`,
      version: "0.0.0",
      private: true,
      type: "module",
      exports: { "./src": "./src/index.ts", "./*": "./*.ts" },
      dependencies: { "@rag/edge-kit": "workspace:*", "@rag/logger": "workspace:*" },
    },
    null,
    2,
  ) + "\n",
);

// --- wrangler.jsonc ------------------------------------------------------
write(
  "wrangler.jsonc",
  `${JSON.stringify(
    {
      name: workerName,
      main: "src/index.ts",
      compatibility_date: "2026-04-23",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      // Give this app a subdomain by adding a route, e.g.:
      // "routes": [{ "pattern": "${name}.jsmunro.me", "custom_domain": true }],
      services: [
        {
          // The auth worker (API Gateway): the shared edge middleware calls it to
          // authenticate, verify, and authorize every request before a handler runs.
          binding: "AUTH",
          service: "ragbot-auth-worker",
          entrypoint: "AuthGateway",
        },
      ],
      observability: { logs: { enabled: true, invocation_logs: true }, traces: { enabled: true } },
    },
    null,
    2,
  )}\n`,
);

// --- src/openapi.ts ------------------------------------------------------
write(
  "src/openapi.ts",
  `// Generated OpenAPI document served at /openapi.json (authenticated-route
// discovery). Regenerate from your route table if you add routes.
export const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "${name} API", version: "0.1.0" },
  paths: {
    "/api/${name}": {
      get: {
        operationId: "${camel}Read",
        responses: {
          "200": { description: "OK" },
          "401": { description: "Authentication required" },
          "403": { description: "Authorization denied" },
        },
      },
    },
  },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
} as const;
`,
);

// --- src/index.ts --------------------------------------------------------
write(
  "src/index.ts",
  `import { createAppWorker, type AuthGatewayBinding } from "@rag/edge-kit";
import { OPENAPI } from "./openapi";

// The ${name} application. It is its route table: the shared edge middleware
// (createAppWorker) serves discovery, authenticates + authorizes each request
// through the AUTH binding, then dispatches. A route handler runs the app's own
// logic and may perform egress (bind EGRESS and call it) as needed.
type Env = { AUTH: AuthGatewayBinding };

export default createAppWorker<Env>({
  service: "${name}",
  openapi: OPENAPI,
  routes: [
    {
      method: "GET",
      path: "/api/${name}",
      operationId: "${camel}Read",
      action: "${name}.read",
      clientKind: "native",
      handler: ({ principal }) => Response.json({ ok: true, service: "${name}", subject: principal.subject }),
    },
  ],
});
`,
);

// --- register in scripts/deploy.ts DEPLOY_ORDER --------------------------
const deployPath = join(root, "scripts/deploy.ts");
let deploy = readFileSync(deployPath, "utf8");
const deployAnchor = '  "ragbot-spend-worker",\n';
if (deploy.includes(deployAnchor)) {
  deploy = deploy.replace(deployAnchor, `${deployAnchor}  ${JSON.stringify(workerName)},\n`);
  writeFileSync(deployPath, deploy);
  console.log(`  registered ${workerName} in scripts/deploy.ts DEPLOY_ORDER`);
} else {
  console.log(`  ! add ${workerName} to scripts/deploy.ts DEPLOY_ORDER by hand`);
}

// --- seed an auth policy entry so the sample route is authorized ---------
const policyPath = join(root, "apps/auth/src/policy.ts");
let policy = readFileSync(policyPath, "utf8");
const policyAnchor = "export const POLICY: PolicyTable = {\n";
if (policy.includes(policyAnchor) && !policy.includes(`"${name}.read"`)) {
  const block = `  ${JSON.stringify(name)}: {\n    "${name}.read": { kinds: ["native"], allowAdmin: true },\n  },\n`;
  policy = policy.replace(policyAnchor, policyAnchor + block);
  writeFileSync(policyPath, policy);
  console.log(`  seeded an auth policy entry for ${name}.read`);
}

console.log(`
scaffolded apps/${name}. Next steps:
  1. pnpm install                 # link the new workspace package
  2. pnpm run check && pnpm test
  3. implement your route handler + RPC in apps/${name}/src/index.ts
  4. give it a subdomain: add a "routes" entry in apps/${name}/wrangler.jsonc
  5. deploy: pnpm run deploy       # auth worker must already be deployed`);
