import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
import { buildEgress } from "./egress";
import {
  type Env,
  type Job,
  type Scope,
  type Submission,
  type Artifact,
  json,
  boundedJSON,
  allowed,
  canManage,
  validScope,
  idPattern,
} from "./types";
import { snapshot, publishPR } from "./github";

export class BuildContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "35m";
  enableInternet = false;
  interceptHttps = true;
  envVars = {
    CODEX_BASE_URL: "http://model.internal/v1",
  };
}
BuildContainer.outbound = buildEgress;

export function validateArtifact(a: Artifact, kind: string) {
  if (!a || !a.source || !a.files || !Array.isArray(a.tests) || !a.tests.length)
    throw new Error("invalid_artifact");
  if (JSON.stringify(a).length > 6 * 1024 * 1024)
    throw new Error("artifact_too_large");
  for (const map of [a.source, a.files])
    for (const [p, v] of Object.entries(map)) {
      if (
        typeof v !== "string" ||
        !p ||
        p.startsWith("/") ||
        p.split("/").some((s) => !s || s === ".." || s.startsWith(".env")) ||
        p.includes("\\")
      )
        throw new Error("unsafe_artifact");
    }
  if (
    kind === "site" &&
    (!a.files["index.html"] ||
      Object.keys(a.files).some(
        (p) => !/\.(html|css|js|json|svg|txt|webmanifest)$/.test(p),
      ))
  )
    throw new Error("invalid_site");
}
function validConfig(input: any) {
  return (
    typeof input.model === "string" &&
    /^[a-zA-Z0-9._-]{1,100}$/.test(input.model) &&
    typeof input.instructions === "string" &&
    input.instructions.length > 0 &&
    input.instructions.length <= 12000 &&
    typeof input.config_revision === "string" &&
    input.config_revision.length <= 200
  );
}
export class Project extends DurableObject<Env> {
  async job() {
    return this.ctx.storage.get<Job>("job");
  }
  runner(j: Job) {
    return this.env.RUNNERS.get(
      this.env.RUNNERS.idFromName(`${j.id}-${j.revision}`),
    );
  }
  async runnerFetch(j: Job, path: string, body?: unknown) {
    return this.runner(j).fetch(
      new Request(`http://container${path}`, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/meta") {
      const j = await this.job();
      return j
        ? json({
            id: j.id,
            kind: j.kind,
            owner: j.user_id,
            guild_id: j.guild_id,
            active: j.active,
            status: j.status,
          })
        : json({}, 404);
    }
    const input = await boundedJSON(request, 32000);
    if (path === "/room-index") {
      const j = await this.job();
      if (
        !j ||
        j.status === "deleted" ||
        !/^(room|wordle):[a-zA-Z0-9_-]{1,64}$/.test(input.room)
      )
        return json({}, 403);
      await this.ctx.storage.put("room:" + input.room, true);
      return json({});
    }
    if (!validScope(input, this.env)) return json({}, 403);
    const job = await this.job();
    if (path === "/submit") {
      if (
        !idPattern.test(input.id) ||
        !["site", "feature"].includes(input.kind) ||
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        input.prompt.length > 6000 ||
        !validConfig(input)
      )
        return json({}, 400);
      if (job)
        return allowed(job, input) && job.user_id === input.user_id
          ? json(this.status(job))
          : json({}, 409);
      const j: Job = {
        ...input,
        revision: 1,
        status: "submitted",
        started: Date.now(),
        releases: [],
      };
      await this.ctx.storage.put("job", j);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json(this.status(j));
    }
    if (!job || !allowed(job, input)) return json({}, 404);
    if (path === "/status") return json(this.status(job));
    if (!canManage(job, input)) return json({}, 403);
    if (path === "/delete") {
      if (
        !["ready", "pr_ready", "failed", "cancelled", "deleted"].includes(
          job.status,
        )
      )
        return json({}, 409);
      job.status = "deleted";
      job.prompt = "[deleted]";
      delete job.active;
      delete job.url;
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json(this.status(job));
    }
    if (path === "/cancel") {
      if (
        ["ready", "pr_ready", "failed", "cancelled", "deleted"].includes(
          job.status,
        )
      )
        return json(this.status(job));
      if (job.status === "publishing")
        return json({ error: "publication_in_progress" }, 409);
      job.status = "cancelled";
      job.terminal_at = Date.now();
      await this.ctx.storage.put("job", job);
      // Persist cancellation before touching the runner. Alarm retries cleanup after eviction.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json(this.status(job));
    }
    if (path === "/edit") {
      const priorOperation =
        typeof input.source_id === "string" &&
        (await this.ctx.storage.get("operation:" + input.source_id));
      if (priorOperation) return json(this.status(job));
      if (
        !["ready", "pr_ready", "failed", "cancelled"].includes(job.status) ||
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        input.prompt.length > 6000
      )
        return json({}, 409);
      const op = input.source_id;
      if (typeof op !== "string" || !/^\d{17,20}$/.test(op))
        return json({}, 400);
      if (await this.ctx.storage.get("operation:" + op))
        return json(this.status(job));
      // Reserve the revision using only durable storage; source preparation happens in the alarm.
      job.seed_revision = job.active ?? job.revision;
      job.revision++;
      delete job.terminal_at;
      delete job.runner_cleaned;
      job.status = "submitted";
      if (!validConfig(input)) return json({}, 400);
      job.model = input.model;
      job.instructions = input.instructions;
      job.config_revision = input.config_revision;
      job.prompt = input.prompt;
      job.started = Date.now();
      delete job.error;
      delete job.url;
      await this.ctx.storage.put({ job: job, ["operation:" + op]: true });
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json(this.status(job));
    }
    if (path === "/rollback") {
      if (
        !["ready", "failed", "cancelled"].includes(job.status) ||
        job.kind !== "site" ||
        !job.releases.includes(input.revision)
      )
        return json({}, 409);
      job.active = input.revision;
      await this.ctx.storage.put("job", job);
      return json(this.status(job));
    }
    if (path === "/export") {
      const a = await this.env.ARTIFACTS.get(
        `${job.id}/${job.active ?? job.revision}/artifact.json`,
      );
      return a
        ? new Response(a.body, {
            headers: { "content-type": "application/json" },
          })
        : json({}, 404);
    }
    return json({}, 404);
  }
  status(j: Job) {
    return {
      id: j.id,
      status: j.status,
      revision: j.revision,
      active: j.active,
      releases: j.releases,
      error: j.error,
      url:
        j.kind === "site" && j.active
          ? `https://${j.id}.${this.env.APP_DOMAIN}`
          : j.url,
    };
  }
  async alarm() {
    const j = await this.job();
    if (!j) return;
    if (j.status === "deleted") {
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      const objects = await this.env.ARTIFACTS.list({ prefix: j.id + "/" });
      if (objects.objects.length)
        await this.env.ARTIFACTS.delete(objects.objects.map((o) => o.key));
      if (objects.truncated) return;
      const rooms = await this.ctx.storage.list({ prefix: "room:" });
      for (const [key] of rooms) {
        const stub = this.env.ROOMS.get(
          this.env.ROOMS.idFromName(j.id + ":" + key.slice(5)),
        );
        await stub.fetch(
          new Request("https://room/destroy", { method: "DELETE" }),
        );
        await this.ctx.storage.delete(key);
      }
      await this.runner(j).destroy();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (["ready", "pr_ready", "failed", "cancelled"].includes(j.status)) {
      const finished = j.terminal_at ?? j.started;
      try {
        if (!j.runner_cleaned) {
          await this.runner(j).destroy();
          const current = await this.job();
          if (current?.revision !== j.revision || current.status !== j.status)
            return;
          current.runner_cleaned = true;
          await this.ctx.storage.put("job", current);
        }
        if (Date.now() - finished >= 86400000) {
          await this.env.ARTIFACTS.delete(`${j.id}/inputs/${j.revision}.json`);
          if (j.status === "failed" || j.status === "cancelled") {
            const failed = await this.env.ARTIFACTS.list({
              prefix: `${j.id}/${j.revision}/`,
            });
            if (failed.objects.length)
              await this.env.ARTIFACTS.delete(failed.objects.map((o) => o.key));
          }
        }
        if (Date.now() - finished >= 30 * 86400000) {
          const current = await this.job();
          if (current?.revision !== j.revision || current.status !== j.status)
            return;
          current.prompt = "[expired]";
          await this.ctx.storage.put("job", current);
          return;
        }
        const latest = await this.job();
        if (latest?.revision !== j.revision || latest.status !== j.status)
          return;
        await this.ctx.storage.setAlarm(
          Math.min(finished + 30 * 86400000, Date.now() + 86400000),
        );
      } catch {
        const latest = await this.job();
        if (latest?.revision === j.revision && latest.status === j.status)
          await this.ctx.storage.setAlarm(Date.now() + 60000);
      }
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    try {
      if (Date.now() - j.started > 40 * 60000) throw new Error("build_timeout");
      if (j.status === "submitted") {
        let seed: Artifact | null = null;
        if (j.seed_revision) {
          const previous = await this.env.ARTIFACTS.get(
            `${j.id}/${j.seed_revision}/artifact.json`,
          );
          if (previous) seed = await previous.json<Artifact>();
        }
        if (seed)
          await this.env.ARTIFACTS.put(
            `${j.id}/inputs/${j.revision}.json`,
            JSON.stringify(seed.source),
          );
        else if (j.kind === "feature") {
          const s = await snapshot(this.env);
          await this.env.ARTIFACTS.put(
            `${j.id}/inputs/${j.revision}.json`,
            JSON.stringify(s.source),
          );
          j.base_sha = s.sha;
        }
        const current = await this.job();
        if (current?.revision !== j.revision || current.status !== "submitted")
          return;
        j.status = "building";
        await this.ctx.storage.put("job", j);
      }
      if (j.status === "building" || j.status === "testing") {
        let response = await this.runnerFetch(j, "/status");
        if (!response.ok) throw new Error("runner_unavailable");
        let state = await boundedJSON(response);
        if (state.status === "idle") {
          const instructions = j.instructions;
          const sourceObject = await this.env.ARTIFACTS.get(
            `${j.id}/inputs/${j.revision}.json`,
          );
          const source = sourceObject ? await sourceObject.json() : undefined;
          const active = await this.job();
          if (
            active?.revision !== j.revision ||
            !["building", "testing"].includes(active.status)
          )
            return;
          const r = await this.runnerFetch(j, "/start", {
            id: `${j.id}-${j.revision}`,
            kind: j.kind,
            model: j.model,
            prompt: j.prompt,
            instructions,
            source,
          });
          if (!r.ok) throw new Error("runner_start_failed");
          return;
        }
        if (state.status === "failed" || state.status === "cancelled")
          throw new Error("build_or_tests_failed");
        const current = await this.job();
        if (
          current?.revision !== j.revision ||
          !["building", "testing"].includes(current.status)
        )
          return;
        if (state.status === "testing") {
          j.status = "testing";
          await this.ctx.storage.put("job", j);
          return;
        }
        if (state.status !== "complete") return;
        validateArtifact(state.artifact, j.kind);
        // Feature revisions remain based on the original repository commit.
        // Carry forward earlier changes as well as this attempt's source diff.
        if (j.kind === "feature" && j.seed_revision) {
          const seed = await this.env.ARTIFACTS.get(
            `${j.id}/${j.seed_revision}/artifact.json`,
          );
          if (seed) {
            const previous = await seed.json<Artifact>();
            state.artifact.changes = {
              ...previous.changes,
              ...state.artifact.changes,
            };
          }
        }
        await this.env.ARTIFACTS.put(
          `${j.id}/${j.revision}/artifact.json`,
          JSON.stringify(state.artifact),
        );
        const after = await this.job();
        if (
          after?.revision !== j.revision ||
          !["building", "testing"].includes(after.status)
        )
          return;
        j.status = "publishing";
        await this.ctx.storage.put("job", j);
      }
      if (j.status === "publishing") {
        const artifact = await this.env.ARTIFACTS.get(
          `${j.id}/${j.revision}/artifact.json`,
        );
        if (!artifact) throw new Error("artifact_missing");
        const a = await artifact.json<Artifact>();
        validateArtifact(a, j.kind);
        if (j.kind === "site") {
          for (const [p, content] of Object.entries(a.files))
            await this.env.ARTIFACTS.put(
              `${j.id}/${j.revision}/public/${p}`,
              content,
            );
        } else {
          const pr = await publishPR(this.env, j, a);
          j.url = pr.url;
          j.pr_number = pr.number;
        }
        // Requests can interleave at awaits: cancelled/replaced jobs never become live.
        const current = await this.job();
        if (current?.revision !== j.revision || current.status !== "publishing")
          return;
        j.status = j.kind === "site" ? "ready" : "pr_ready";
        j.terminal_at = Date.now();
        j.active = j.revision;
        j.releases.push(j.revision);
        await this.ctx.storage.put("job", j);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    } catch {
      const current = await this.job();
      if (
        current?.revision !== j.revision ||
        current.status === "cancelled" ||
        current.status === "deleted"
      )
        return;
      // Publishing has deterministic destinations. Keep it recoverable after ambiguous external responses.
      if (j.status === "publishing" && Date.now() - j.started < 40 * 60000)
        return;
      j.status = "failed";
      j.terminal_at = Date.now();
      j.error = "build_or_publish_failed";
      await this.ctx.storage.put("job", j);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }
}
