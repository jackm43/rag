import { createClient } from "../../../../../packages/auth";
import { connectorsClient } from "../../../../../packages/connectors";
import type { Env } from "../../../../../packages/contracts/types";
import type {
  AttestedArtifact,
  GitHubAttestation,
  GitHubAttestationScope,
} from "../../../../../packages/attest/types";
import { sha256Hex } from "../../../../../packages/registry/scaffold";
import { errorMessage, logger } from "../../../../../packages/logger";

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const ATTESTED_PREFIXES = ["registry/applications/", "workers/applications/"] as const;
const GITHUB_CONNECTOR_ID = "github-app";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const utf8FromBase64 = (value: string): string => {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

const githubPath = (owner: string, repo: string, path: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;

type GitHubFetchClient = ReturnType<typeof connectorsClient>;

const githubJson = async (
  client: GitHubFetchClient,
  handle: string,
  owner: string,
  repo: string,
  path: string,
): Promise<unknown | null> => {
  const result = await client.authorizedFetch(handle, {
    method: "GET",
    path: githubPath(owner, repo, path),
    headers: { accept: "application/vnd.github+json" },
  });
  if (result.status !== 200 || !result.fetch) {
    return null;
  }
  try {
    return JSON.parse(result.fetch.body) as unknown;
  } catch {
    return null;
  }
};

const attestations = (env: Env) => {
  if (!env.ATTESTATIONS) {
    return null;
  }
  return env.ATTESTATIONS.get(env.ATTESTATIONS.idFromName("github"));
};

const installationIdFrom = (payload: Record<string, unknown>): string | null => {
  const installation = payload.installation;
  return isRecord(installation) && typeof installation.id === "number"
    ? String(installation.id)
    : null;
};

const repositoryFrom = (payload: Record<string, unknown>) => {
  const repository = payload.repository;
  if (!isRecord(repository) || typeof repository.full_name !== "string") {
    return null;
  }
  const owner = isRecord(repository.owner) && typeof repository.owner.login === "string"
    ? repository.owner.login
    : repository.full_name.split("/")[0];
  const name = typeof repository.name === "string"
    ? repository.name
    : repository.full_name.split("/")[1];
  return owner && name ? { fullName: repository.full_name, owner, repo: name } : null;
};

const eventContext = (
  eventType: string | null,
  payload: Record<string, unknown>,
): { ref: string; commitSha: string; scope: GitHubAttestationScope; prNumber?: number; branchName?: string } | null => {
  if (eventType === "push") {
    const ref = typeof payload.ref === "string" ? payload.ref : "";
    const commitSha = typeof payload.after === "string" ? payload.after : "";
    if (!/^refs\/heads\/.+/.test(ref) || !/^[a-f0-9]{40}$/.test(commitSha)) {
      return null;
    }
    const branchName = ref.replace(/^refs\/heads\//, "");
    return {
      ref,
      commitSha,
      scope: branchName === "main" ? "production" : "branch",
      branchName,
    };
  }

  if (eventType === "pull_request") {
    const pullRequest = payload.pull_request;
    if (!isRecord(pullRequest) || !isRecord(pullRequest.head)) {
      return null;
    }
    const commitSha = typeof pullRequest.head.sha === "string" ? pullRequest.head.sha : "";
    const branchName = typeof pullRequest.head.ref === "string" ? pullRequest.head.ref : undefined;
    const prNumber = typeof pullRequest.number === "number"
      ? pullRequest.number
      : typeof payload.number === "number"
        ? payload.number
        : undefined;
    if (!/^[a-f0-9]{40}$/.test(commitSha) || prNumber === undefined) {
      return null;
    }
    return {
      ref: `refs/pull/${prNumber}/head`,
      commitSha,
      scope: "pull_request",
      prNumber,
      ...(branchName ? { branchName } : {}),
    };
  }

  return null;
};

const actorFrom = (payload: Record<string, unknown>): { actorLogin?: string; actorId?: number } => {
  const sender = payload.sender;
  if (!isRecord(sender)) {
    return {};
  }
  return {
    ...(typeof sender.login === "string" ? { actorLogin: sender.login } : {}),
    ...(typeof sender.id === "number" ? { actorId: sender.id } : {}),
  };
};

const treeArtifacts = async (
  client: GitHubFetchClient,
  handle: string,
  owner: string,
  repo: string,
  commitSha: string,
): Promise<AttestedArtifact[]> => {
  const tree = await githubJson(
    client,
    handle,
    owner,
    repo,
    `/git/trees/${commitSha}?recursive=1`,
  );
  if (!isRecord(tree) || !Array.isArray(tree.tree)) {
    return [];
  }

  const artifacts: AttestedArtifact[] = [];
  for (const entry of tree.tree) {
    if (
      !isRecord(entry) ||
      entry.type !== "blob" ||
      typeof entry.path !== "string" ||
      typeof entry.sha !== "string"
    ) {
      continue;
    }
    const path = entry.path;
    if (!ATTESTED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      continue;
    }
    const blob = await githubJson(client, handle, owner, repo, `/git/blobs/${entry.sha}`);
    if (!isRecord(blob) || typeof blob.content !== "string" || blob.encoding !== "base64") {
      continue;
    }
    const content = utf8FromBase64(blob.content);
    artifacts.push({
      path,
      githubBlobSha: entry.sha,
      sha256: await sha256Hex(content),
    });
  }
  return artifacts;
};

const verifyWebhook = async (
  env: Env,
  headers: Record<string, string>,
  bodyBase64: string,
): Promise<{ valid: boolean; eventId?: string }> => {
  const result = await connectorsClient(
    env,
    createClient({
      env,
      self: "attest",
      context: { subject: "github:webhook" },
    }).to("connectors", { transportTrust: "application" }),
  ).verifyWebhook(GITHUB_CONNECTOR_ID, {
    provider: "github",
    signatureHeaders: headers,
    bodyBase64,
  });
  return result.status === 200 && result.webhook ? result.webhook : { valid: false };
};

export type GitHubWebhookOutcome = {
  status: number;
  body: unknown;
};

// The full GitHub webhook business logic, moved out of the HTTP middleware
// into the service server: verify the signature via the connectors broker,
// dedupe by delivery id, parse the event, fetch the commit tree via the
// connectors grant/authorizedFetch, and persist the attestation. Mirrors the
// exact response semantics the middleware used to produce directly (401 bad
// signature, 202 ignored/accepted, 200 dedupe-hit, 500 store unbound).
export const handleGitHubWebhookEvent = async (
  env: Env,
  headers: Record<string, string>,
  bodyBase64: string,
): Promise<GitHubWebhookOutcome> => {
  let verification: { valid: boolean; eventId?: string };
  try {
    verification = await verifyWebhook(env, headers, bodyBase64);
  } catch (error) {
    logger.error("attest_webhook_verify_failed", { error: errorMessage(error) });
    return { status: 401, body: "Bad request signature" };
  }
  if (!verification.valid) {
    return { status: 401, body: "Bad request signature" };
  }

  const store = attestations(env);
  if (!store) {
    logger.error("attest_store_unbound", {});
    return { status: 500, body: "Internal error" };
  }
  if (verification.eventId && await store.seenDelivery(verification.eventId, DEDUPE_TTL_MS)) {
    return { status: 200, body: "OK" };
  }

  const eventType = headers["x-github-event"] ?? null;
  const bytes = Uint8Array.from(atob(bodyBase64.replace(/\s/g, "")), (char) => char.charCodeAt(0));
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { status: 400, body: { error: "invalid_payload" } };
  }
  if (!isRecord(payload)) {
    return { status: 400, body: { error: "invalid_payload" } };
  }
  const repo = repositoryFrom(payload);
  const context = eventContext(eventType, payload);
  const installationId = installationIdFrom(payload);
  if (!repo || !context || !installationId) {
    return { status: 202, body: "Ignored" };
  }
  if (
    (env.ATTEST_GITHUB_OWNER && repo.owner !== env.ATTEST_GITHUB_OWNER) ||
    (env.ATTEST_GITHUB_REPO && repo.repo !== env.ATTEST_GITHUB_REPO)
  ) {
    return { status: 202, body: "Ignored" };
  }

  const client = connectorsClient(
    env,
    createClient({
      env,
      self: "attest",
      context: { subject: `github:${repo.fullName}` },
    }).to("connectors", { transportTrust: "application" }),
  );
  const grant = await client.grant(GITHUB_CONNECTOR_ID, { params: { installationId } });
  if (grant.status !== 200 || !grant.grant) {
    logger.warn("attest_github_grant_failed", { repository: repo.fullName, status: grant.status });
    return { status: 202, body: "Accepted" };
  }

  const artifacts = await treeArtifacts(client, grant.grant.handle, repo.owner, repo.repo, context.commitSha);
  const attestation: GitHubAttestation = {
    id: crypto.randomUUID(),
    repository: repo.fullName,
    owner: repo.owner,
    repo: repo.repo,
    ref: context.ref,
    commitSha: context.commitSha,
    scope: context.scope,
    ...(context.prNumber !== undefined ? { pullRequestNumber: context.prNumber } : {}),
    ...(context.branchName !== undefined ? { branchName: context.branchName } : {}),
    ...actorFrom(payload),
    receivedAt: new Date().toISOString(),
    ...(verification.eventId !== undefined ? { eventId: verification.eventId } : {}),
    artifacts,
  };
  await store.record(attestation);
  logger.info("attestation_recorded", {
    repository: attestation.repository,
    ref: attestation.ref,
    commitSha: attestation.commitSha,
    scope: attestation.scope,
    artifacts: artifacts.length,
  });
  return { status: 202, body: { attested: true, artifacts: artifacts.length } };
};
