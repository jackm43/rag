import type { ClientKind, Principal } from "@rag/edge-kit";

// The data-driven authorization table that replaces the Cedar engine. An
// authorization decision is a lookup: (app, action) -> rule, evaluated against
// the authenticated principal. Every constraint present on a rule must pass
// (AND); admins may be granted a bypass per-rule. Absent rule = deny by default.
// This is plain data — no wasm engine, no .cedar files — so a new app's routes
// are authorized by adding a table entry (the scaffolder seeds one).

// The admin-id var is fixed; any other key is an app-defined subject allowlist
// (comma-separated ids) a rule can reference via `subjectsFrom`.
export type PolicyEnv = {
  RAG_ADMIN_USER_IDS?: string;
  [allowlistVar: string]: string | undefined;
};

export type PolicyRule = {
  // Client kinds allowed to perform this action.
  kinds?: ClientKind[];
  // Principal roles, any of which satisfies the rule.
  roles?: string[];
  // Env var (comma-separated ids) whose set the subject must be in.
  subjectsFrom?: string;
  // Admins (RAG_ADMIN_USER_IDS) are allowed regardless of the above.
  allowAdmin?: boolean;
  // Any authenticated principal is allowed (still authenticated + verified).
  public?: boolean;
};

export type PolicyTable = Record<string, Record<string, PolicyRule>>;

const idSet = (value: string | undefined): Set<string> =>
  new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));

export const isAdmin = (env: PolicyEnv, subject: string): boolean =>
  idSet(env.RAG_ADMIN_USER_IDS).has(subject);

// The seed policy for the known applications. New entries are appended (the
// scaffolder adds a `<app>` block for its sample route). Keep this the single
// source of authorization truth for public routes.
export const POLICY: PolicyTable = {
  gateway: {
    // Operator control plane (start/stop/health) via the native bearer token.
    "gateway.control": { kinds: ["native"], roles: ["operator"] },
  },
  "connectors-api": {
    // Machine-facing connector listing behind CF Access.
    "connector.list": { kinds: ["web", "native"], allowAdmin: true },
  },
  webhooks: {
    // Provider webhooks + Discord interactions authenticate by signature at the
    // edge; any signature-verified webhook principal may enqueue.
    "webhook.ingest": { kinds: ["webhook"], public: true },
    "interaction.ingest": { kinds: ["webhook"], public: true },
  },
};

export type Evaluation = { ok: true } | { ok: false; status: number; reason: string };

export const evaluate = (
  table: PolicyTable,
  env: PolicyEnv,
  input: { principal: Principal; app: string; action: string },
): Evaluation => {
  const rule = table[input.app]?.[input.action];
  if (!rule) {
    return { ok: false, status: 403, reason: "no_policy" };
  }
  const admin = rule.allowAdmin === true && isAdmin(env, input.principal.subject);
  if (admin) {
    return { ok: true };
  }
  if (rule.kinds && !rule.kinds.includes(input.principal.kind)) {
    return { ok: false, status: 403, reason: "kind_denied" };
  }
  if (rule.roles && !(input.principal.roles ?? []).some((role) => rule.roles?.includes(role))) {
    return { ok: false, status: 403, reason: "role_denied" };
  }
  if (rule.subjectsFrom && !idSet(env[rule.subjectsFrom]).has(input.principal.subject)) {
    return { ok: false, status: 403, reason: "subject_denied" };
  }
  // `public` (or a rule that only constrained kind/role/subject and passed) allows.
  return { ok: true };
};
