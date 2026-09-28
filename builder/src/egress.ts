import { type Env, boundedJSON } from "./types";
const downloads = new Set([
  "registry.npmjs.org",
  "registry.npmjs.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
]);
export async function buildEgress(request: Request, env: Env) {
  const u = new URL(request.url);
  if (u.hostname === "model.internal") {
    if (
      request.method !== "POST" ||
      !["/v1/responses", "/v1/responses/compact"].includes(u.pathname) ||
      u.search
    )
      return new Response(null, { status: 403 });
    const body = await boundedJSON(request);
    if (
      typeof body.model !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(body.model)
    )
      return new Response(null, { status: 403 });
    // The real key exists only in this trusted Worker. No redirects or user-selected credential hosts.
    return fetch("https://api.openai.com" + u.pathname, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  }
  if (
    !downloads.has(u.hostname) ||
    !["GET", "HEAD"].includes(request.method) ||
    u.protocol !== "https:" ||
    u.port
  )
    return new Response(null, { status: 403 });
  return fetch(u.href, { method: request.method, redirect: "manual" });
}
