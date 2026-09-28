import type { OutboundHandlerContext } from "@cloudflare/containers";
import { type Env, readJSON } from "./types";

// Every HTTP(S) request a build container makes arrives here. The coding agent
// is configured to call AI Gateway directly with a placeholder key; this
// handler, running in the Worker, swaps in the gateway token so no credential
// ever exists inside the container. The only other reachable host is npm.

const GATEWAY = "gateway.ai.cloudflare.com";
const NPM = "registry.npmjs.org";
const MODEL_ENDPOINTS = ["responses", "responses/compact"];
const FORWARDED = [
  "content-type",
  "accept",
  "openai-beta",
  "session_id",
  "conversation_id",
  "originator",
  "user-agent",
];

export function gatewayBase(env: Env) {
  return `https://${GATEWAY}/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/openai`;
}

export async function egress(
  request: Request,
  env: Env,
  ctx: OutboundHandlerContext,
) {
  const url = new URL(request.url);
  const https = url.protocol === "https:" && !url.port;
  if (https && url.hostname === GATEWAY) return model(request, env, ctx);
  if (
    https &&
    url.hostname === NPM &&
    (request.method === "GET" || request.method === "HEAD")
  )
    // Redirects go back to the container, so their targets pass through this policy too.
    return fetch(url.href, {
      method: request.method,
      headers: { accept: request.headers.get("accept") ?? "*/*" },
      redirect: "manual",
    });
  return new Response("Builds can only reach the npm registry.\n", {
    status: 403,
  });
}

async function model(request: Request, env: Env, ctx: OutboundHandlerContext) {
  const url = new URL(request.url);
  const base = new URL(gatewayBase(env)).pathname + "/";
  const endpoint = url.pathname.startsWith(base)
    ? url.pathname.slice(base.length)
    : "";
  if (
    request.method !== "POST" ||
    url.search ||
    !MODEL_ENDPOINTS.includes(endpoint)
  )
    return new Response(null, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = await readJSON(request, 32 * 1024 * 1024);
  } catch {
    return new Response(null, { status: 400 });
  }
  // Builds use the configured model only, whatever the agent asks for.
  body.model = env.CODING_MODEL;
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  headers.set(
    "cf-aig-metadata",
    JSON.stringify({
      ragbot_kind: "build",
      ragbot_container: ctx.containerId.slice(0, 32),
    }),
  );
  return fetch(gatewayBase(env) + "/" + endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}
