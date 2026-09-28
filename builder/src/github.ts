import { type Env, type Artifact, type Job, boundedJSON } from "./types";
function repo(env: Env) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY))
    throw new Error("repository_not_configured");
  return env.GITHUB_REPOSITORY;
}
async function api(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const r = await fetch(`https://api.github.com/repos/${repo(env)}/${path}`, {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "user-agent": "ragbot-builder",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error("github_request_failed");
  return boundedJSON(r, 12 * 1024 * 1024);
}
export async function snapshot(env: Env) {
  const ref = await api(
    env,
    `git/ref/heads/${encodeURIComponent(env.GITHUB_BASE_BRANCH)}`,
  );
  const commit = await api(env, `git/commits/${ref.object.sha}`);
  const tree = await api(env, `git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error("repository_too_large");
  const files: Record<string, string> = {};
  let size = 0;
  for (const item of tree.tree) {
    if (
      item.type !== "blob" ||
      item.mode === "120000" ||
      item.path
        .split("/")
        .some((p: string) => p.startsWith(".env") || p === ".git")
    )
      continue;
    if (item.size > 1024 * 1024) throw new Error("repository_file_too_large");
    const blob = await api(env, `git/blobs/${item.sha}`);
    const bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, "")), (v) =>
      v.charCodeAt(0),
    );
    size += bytes.length;
    if (size > 4 * 1024 * 1024 || Object.keys(files).length >= 500)
      throw new Error("repository_too_large");
    files[item.path] = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  }
  return { source: files, sha: ref.object.sha };
}
export function validateChanges(changes: Artifact["changes"]) {
  if (
    !changes ||
    !Object.keys(changes).length ||
    Object.keys(changes).length > 100
  )
    throw new Error("invalid_changes");
  for (const [p, v] of Object.entries(changes)) {
    if (
      !/^[\w./@+ -]+$/.test(p) ||
      p.startsWith("/") ||
      p.split("/").some((v) => !v || v === ".." || v.startsWith(".env")) ||
      p.startsWith(".github/") ||
      p.startsWith(".git/") ||
      p === "AGENTS.md" ||
      p.startsWith("builder/") ||
      p.startsWith("src/ragbot/security") ||
      p.startsWith("src/entry") ||
      p.startsWith("wrangler") ||
      p.startsWith("migrations/") ||
      (v !== null && typeof v !== "string")
    )
      throw new Error("protected_change");
  }
}
export async function publishPR(env: Env, job: Job, artifact: Artifact) {
  validateChanges(artifact.changes);
  const branch = `ragbot-build/${job.id}-${job.revision}`;
  const existing = await api(
    env,
    `pulls?state=all&head=${encodeURIComponent(repo(env).split("/")[0] + ":" + branch)}`,
  );
  if (existing.length)
    return { url: existing[0].html_url, number: existing[0].number };
  const parent = await api(env, `git/commits/${job.base_sha}`);
  const tree = await api(env, "git/trees", "POST", {
    base_tree: parent.tree.sha,
    tree: Object.entries(artifact.changes!).map(([path, content]) =>
      content === null
        ? { path, mode: "100644", type: "blob", sha: null }
        : { path, mode: "100644", type: "blob", content },
    ),
  });
  const commit = await api(env, "git/commits", "POST", {
    message: `Ragbot feature request ${job.id}`,
    tree: tree.sha,
    parents: [job.base_sha],
  });
  // Branch creation can be reconciled by its deterministic name after an uncertain POST.
  const refResponse = await fetch(
    `https://api.github.com/repos/${repo(env)}/git/ref/heads/${branch}`,
    {
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "user-agent": "ragbot-builder",
      },
      redirect: "error",
    },
  );
  if (refResponse.status === 404)
    await api(env, "git/refs", "POST", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  else if (!refResponse.ok) throw new Error("github_request_failed");
  await api(env, "pulls", "POST", {
    title: `Ragbot feature ${job.id.slice(0, 8)}`,
    head: branch,
    base: env.GITHUB_BASE_BRANCH,
    draft: true,
    body: `Implements a Discord feature request.\n\nRequest:\n${job.prompt.replaceAll("@", "＠")}\n\nValidation completed in an isolated container:\n${artifact.tests.map((t) => "- " + t).join("\n")}\n\nReview generated code before merging. No production deployment was performed.`,
  });
  const result = await api(
    env,
    `pulls?state=all&head=${encodeURIComponent(repo(env).split("/")[0] + ":" + branch)}`,
  );
  if (!result.length) throw new Error("pr_reconciliation_required");
  return { url: result[0].html_url, number: result[0].number };
}
