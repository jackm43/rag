import { createClient } from "@rag/service-kit";
import { connectorsClient } from "@rag/connectors-core/lib";
import type { ConnectorResult } from "@rag/connectors-core/contracts";
import type { Env } from "../../../../contracts";
import { buildApplicationScaffold } from "../../../../lib/registry-kit/scaffold";
import type { RegistryEvent, RegistryScaffold } from "../../../../lib/registry-kit/types";
import { errorMessage, logger } from "@rag/logger";

type GithubClient = ReturnType<typeof connectorsClient>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const base64Utf8 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const githubPath = (owner: string, repo: string, path: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;

const encodePath = (path: string): string =>
  path.split("/").map((part) => encodeURIComponent(part)).join("/");

const brokerStatus = (result: ConnectorResult): boolean => result.status >= 200 && result.status < 300;

const githubJson = async (
  client: GithubClient,
  handle: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown | null> => {
  const result = await client.authorizedFetch(handle, {
    method,
    path,
    headers: { accept: "application/vnd.github+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!brokerStatus(result) || !result.fetch) {
    return null;
  }
  try {
    return JSON.parse(result.fetch.body) as unknown;
  } catch {
    return null;
  }
};

const readSha = (value: unknown): string | null =>
  isRecord(value) && typeof value.sha === "string" ? value.sha : null;

const submitGithubPr = async (
  env: Env,
  event: RegistryEvent,
  scaffold: RegistryScaffold,
): Promise<string | null> => {
  const installationId = env.REGISTRY_GITHUB_INSTALLATION_ID;
  const owner = env.REGISTRY_GITHUB_OWNER;
  const repo = env.REGISTRY_GITHUB_REPO;
  const base = env.REGISTRY_GITHUB_BASE_BRANCH ?? "main";
  if (!installationId || !owner || !repo || !env.CONNECTORS) {
    return null;
  }

  const client = connectorsClient(env, createClient({
    env,
    self: "registry",
    context: { subject: event.actorDiscordId },
  }).to("connectors", { transportTrust: "trusted" }));
  const grant = await client.grant("github-app", { params: { installationId } });
  if (grant.status !== 200 || !grant.grant) {
    logger.warn("registry_github_grant_failed", { applicationId: event.applicationId, status: grant.status });
    return null;
  }

  const handle = grant.grant.handle;
  const ref = await githubJson(client, handle, "GET", githubPath(owner, repo, `/git/ref/heads/${base}`));
  const baseSha = isRecord(ref) && isRecord(ref.object) && typeof ref.object.sha === "string"
    ? ref.object.sha
    : null;
  if (!baseSha) {
    return null;
  }

  const branch = `registry/${event.applicationId}-${event.id.slice(0, 8)}`;
  await githubJson(client, handle, "POST", githubPath(owner, repo, "/git/refs"), {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

  for (const artifact of scaffold.artifacts) {
    const existing = await githubJson(
      client,
      handle,
      "GET",
      githubPath(owner, repo, `/contents/${encodePath(artifact.path)}?ref=${encodeURIComponent(branch)}`),
    );
    await githubJson(client, handle, "PUT", githubPath(owner, repo, `/contents/${encodePath(artifact.path)}`), {
      message: `registry: add ${event.applicationId} ${artifact.path}`,
      branch,
      content: base64Utf8(artifact.content),
      ...(readSha(existing) ? { sha: readSha(existing) } : {}),
    });
  }

  const pr = await githubJson(client, handle, "POST", githubPath(owner, repo, "/pulls"), {
    title: `Register application ${event.applicationId}`,
    head: branch,
    base,
    body: [
      `Registry request: ${event.id}`,
      `Application: ${event.applicationId}`,
      `Metadata SHA-256: ${scaffold.metadataSha256}`,
      "",
      "Artifacts:",
      ...scaffold.artifacts.map((artifact) => `- \`${artifact.path}\` ${artifact.sha256}`),
      "",
      "Attestation required before production runtime config may trust these artifacts.",
    ].join("\n"),
  });
  return isRecord(pr) && typeof pr.html_url === "string" ? pr.html_url : null;
};

const applicationRegistry = (env: Env) => {
  if (!env.REGISTRY_APPLICATIONS) {
    return null;
  }
  return env.REGISTRY_APPLICATIONS.get(env.REGISTRY_APPLICATIONS.idFromName("applications"));
};

export const processRegistryRequest = async (
  env: Env,
  event: RegistryEvent,
): Promise<RegistryScaffold & { pullRequestUrl?: string }> => {
  try {
    const scaffold = await buildApplicationScaffold(event.metadata);
    const prUrl = await submitGithubPr(env, event, scaffold);
    await applicationRegistry(env)?.putScaffoldResult(event.applicationId, {
      ...scaffold,
      ...(prUrl ? { pullRequestUrl: prUrl } : {}),
    });
    logger.info("registry_event_processed", {
      eventId: event.id,
      applicationId: event.applicationId,
      artifactCount: scaffold.artifacts.length,
      githubSubmitted: prUrl !== null,
    });
    return {
      ...scaffold,
      ...(prUrl ? { pullRequestUrl: prUrl } : {}),
    };
  } catch (error) {
    logger.error("registry_event_failed", {
      eventId: event.id,
      applicationId: event.applicationId,
      error: errorMessage(error),
    });
    throw error;
  }
};
