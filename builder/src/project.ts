import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { directory, slugFor } from "./directory";
import { egress, gatewayBase } from "./egress";
import {
  type Env,
  type Job,
  type Scope,
  type Status,
  TERMINAL,
  appUrl,
  idPattern,
  readJSON,
} from "./types";

export class BuildContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
  interceptHttps = true;
}
// Must be an assignment: a `static outbound = ...` class field would bypass the
// library's setter and silently leave egress unintercepted.
BuildContainer.outbound = egress;

export const LIMITS = {
  files: 400,
  file: 10 * 1024 * 1024,
  total: 25 * 1024 * 1024,
  source: 20 * 1024 * 1024,
};
const DEADLINE_MS = 45 * 60_000;
const POLL_MS = 5_000;
const MAX_RESTARTS = 2;
const segment = /^[A-Za-z0-9_@+~-][A-Za-z0-9._@+~-]*$/;

export type Manifest = { path: string; size: number }[];

/** Paths are relative, dot-free per segment, and never shadow the host API. */
export function validManifest(files: unknown): files is Manifest {
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.files)
    return false;
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const path = file?.path;
    if (typeof path !== "string" || path.length > 200 || seen.has(path))
      return false;
    const parts = path.split("/");
    if (
      parts[0] === "_api" ||
      !parts.every((part) => segment.test(part) && part !== "..")
    )
      return false;
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > LIMITS.file
    )
      return false;
    total += file.size;
    seen.add(path);
  }
  return seen.has("index.html") && total <= LIMITS.total;
}

export type View = {
  id: string;
  slug: string;
  status: Status;
  revision: number;
  active?: number;
  releases: number[];
  url?: string;
  title?: string;
  summary?: string;
  error?: string;
};

export class Project extends DurableObject<Env> {
  private job() {
    return this.ctx.storage.get<Job>("job");
  }

  private async save(job: Job, alarmIn?: number) {
    await this.ctx.storage.put("job", job);
    if (alarmIn !== undefined)
      await this.ctx.storage.setAlarm(Date.now() + alarmIn);
  }

  private view(job: Job): View {
    return {
      id: job.id,
      slug: job.slug,
      status: job.status,
      revision: job.revision,
      active: job.active,
      releases: job.releases,
      url: job.active ? appUrl(this.env, job.slug) : undefined,
      title: job.title,
      summary: job.summary,
      error: job.error,
    };
  }

  private runner(job: Job) {
    return this.env.RUNNERS.get(
      this.env.RUNNERS.idFromName(`${job.id}:${job.revision}`),
    );
  }

  // --- control (called by BuilderControl, which validated the scope) --------

  async submit(scope: Scope, id: string, prompt: string): Promise<View> {
    const existing = await this.job();
    if (existing) {
      if (
        existing.guild_id !== scope.guild_id ||
        existing.user_id !== scope.user_id
      )
        throw new Error("conflict");
      return this.view(existing);
    }
    if (!idPattern.test(id)) throw new Error("invalid_id");
    let slug = slugFor(prompt, id);
    for (const length of [8, 32]) {
      if (await directory(this.env).claim(slug, id)) break;
      slug = slugFor(prompt, id, length);
    }
    const job: Job = {
      id,
      slug,
      guild_id: scope.guild_id,
      channel_id: scope.channel_id,
      user_id: scope.user_id,
      requests: [prompt],
      revision: 1,
      status: "queued",
      started: Date.now(),
      releases: [],
      restarts: 0,
      operations: [],
    };
    await this.save(job, 0);
    return this.view(job);
  }

  async status(scope: Scope) {
    return this.view(await this.visible(scope));
  }

  async edit(scope: Scope, prompt: string, operation: string) {
    const job = await this.managed(scope);
    if (job.operations.includes(operation)) return this.view(job);
    if (!TERMINAL.includes(job.status) || job.status === "deleted")
      throw new Error("busy");
    job.operations = [...job.operations, operation].slice(-50);
    job.requests.push(prompt);
    job.revision++;
    job.base = job.active;
    job.status = "queued";
    job.started = Date.now();
    job.restarts = 0;
    delete job.finished;
    delete job.error;
    await this.save(job, 0);
    return this.view(job);
  }

  async cancel(scope: Scope) {
    const job = await this.managed(scope);
    if (TERMINAL.includes(job.status)) return this.view(job);
    // Publishing writes to deterministic keys; let it finish, then roll back.
    if (job.status === "publishing") throw new Error("publishing");
    return this.finish(job, "cancelled");
  }

  async rollback(scope: Scope, revision: number) {
    const job = await this.managed(scope);
    if (!job.releases.includes(revision) || job.status === "deleted")
      throw new Error("unknown_release");
    if (!TERMINAL.includes(job.status)) throw new Error("busy");
    job.active = revision;
    await this.save(job);
    return this.view(job);
  }

  async delete(scope: Scope) {
    const job = await this.managed(scope);
    if (job.status === "publishing") throw new Error("publishing");
    job.status = "deleted";
    job.requests = [];
    delete job.active;
    delete job.summary;
    delete job.title;
    job.finished = Date.now();
    await this.save(job, 0);
    return this.view(job);
  }

  /** Routing data for the public Worker. */
  async meta() {
    const job = await this.job();
    return (
      job && { guild_id: job.guild_id, status: job.status, active: job.active }
    );
  }

  private async visible(scope: Scope) {
    const job = await this.job();
    if (!job || job.guild_id !== scope.guild_id) throw new Error("not_found");
    return job;
  }

  private async managed(scope: Scope) {
    const job = await this.visible(scope);
    if (job.user_id !== scope.user_id && !scope.moderator)
      throw new Error("forbidden");
    return job;
  }

  private async finish(job: Job, status: Status, error?: string) {
    job.status = status;
    job.finished = Date.now();
    if (error) job.error = error;
    await this.save(job, 0);
    return this.view(job);
  }

  // --- the build loop --------------------------------------------------------

  /** True if nothing replaced or cancelled `job` while we awaited I/O. */
  private async current(job: Job) {
    const latest = await this.job();
    return latest?.revision === job.revision && latest.status === job.status;
  }

  async alarm() {
    const job = await this.job();
    if (!job) return;
    if (job.status === "deleted") return this.cleanup(job);
    if (TERMINAL.includes(job.status)) {
      // Stop the finished revision's container; the next revision uses a new one.
      await stop(this.runner(job));
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    if (Date.now() - job.started > DEADLINE_MS) {
      await this.finish(job, "failed", "timeout");
      return;
    }
    try {
      if (job.status === "queued") await this.start(job);
      else if (job.status === "building") await this.poll(job);
      else if (job.status === "publishing") await this.publish(job);
    } catch {
      // Transient failures (container starting, network) retry on the next alarm
      // until the deadline; publishing only writes deterministic keys.
    }
  }

  private async start(job: Job) {
    const runner = this.runner(job);
    if (job.base) {
      const source = await this.env.ARTIFACTS.get(
        `${job.id}/${job.base}/source.tar.gz`,
      );
      if (!source) return this.finish(job, "failed", "source_missing");
      const put = await runner.fetch("http://runner/source", {
        method: "PUT",
        body: await source.arrayBuffer(),
      });
      if (!put.ok) throw new Error("runner_unavailable");
    }
    const response = await runner.fetch("http://runner/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `${job.id}:${job.revision}`,
        // Without a release to change, build afresh from everything asked so far.
        request: job.base ? job.requests[0] : job.requests.join("\n\n"),
        change: job.base ? job.requests.at(-1) : undefined,
        seeded: Boolean(job.base),
        gateway: gatewayBase(this.env),
        model: this.env.CODING_MODEL,
        effort: this.env.CODING_REASONING_EFFORT,
      }),
    });
    if (!response.ok) throw new Error("runner_unavailable");
    if (!(await this.current(job))) return;
    job.status = "building";
    await this.save(job);
  }

  private async poll(job: Job) {
    const response = await this.runner(job).fetch("http://runner/status");
    if (!response.ok) throw new Error("runner_unavailable");
    const state = await readJSON(response, 1024 * 1024);
    if (!(await this.current(job))) return;
    if (state.phase === "idle") {
      // The container restarted and lost the build; start it again, a few times.
      if (++job.restarts > MAX_RESTARTS)
        return this.finish(job, "failed", "runner_lost");
      job.status = "queued";
      return this.save(job);
    }
    if (state.phase === "failed")
      return this.finish(
        job,
        "failed",
        String(state.error || "build_failed").slice(0, 40),
      );
    if (state.phase !== "done") return;
    if (!validManifest(state.files))
      return this.finish(job, "failed", "invalid_output");
    job.status = "publishing";
    job.summary =
      typeof state.summary === "string"
        ? state.summary.slice(0, 1500)
        : undefined;
    job.title =
      typeof state.title === "string" && state.title.trim()
        ? state.title.trim().slice(0, 80)
        : undefined;
    await this.ctx.storage.put("manifest", state.files);
    await this.save(job);
  }

  private async publish(job: Job) {
    const files = (await this.ctx.storage.get<Manifest>("manifest")) ?? [];
    const runner = this.runner(job);
    const prefix = `${job.id}/${job.revision}`;
    for (const file of files) {
      const key = `${prefix}/site/${file.path}`;
      if ((await this.env.ARTIFACTS.head(key))?.size === file.size) continue;
      const response = await runner.fetch(
        "http://runner/file/" + encodeURI(file.path),
      );
      const body = response.ok ? await response.arrayBuffer() : null;
      if (!body || body.byteLength !== file.size)
        return this.finish(job, "failed", "invalid_output");
      await this.env.ARTIFACTS.put(key, body);
    }
    const source = await runner.fetch("http://runner/source");
    const archive = source.ok ? await source.arrayBuffer() : null;
    if (!archive || archive.byteLength > LIMITS.source)
      return this.finish(job, "failed", "invalid_output");
    await this.env.ARTIFACTS.put(`${prefix}/source.tar.gz`, archive);
    if (!(await this.current(job))) return;
    job.status = "ready";
    job.active = job.revision;
    job.releases.push(job.revision);
    job.finished = Date.now();
    await directory(this.env).publish({
      slug: job.slug,
      id: job.id,
      guild: job.guild_id,
      title: job.title ?? job.slug,
      summary: job.summary ?? "",
      updated: job.finished,
    });
    await this.ctx.storage.delete("manifest");
    await this.save(job, 0);
  }

  private async cleanup(job: Job) {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await directory(this.env).unpublish(job.id);
    for (;;) {
      const listed = await this.env.ARTIFACTS.list({ prefix: job.id + "/" });
      if (listed.objects.length)
        await this.env.ARTIFACTS.delete(listed.objects.map((o) => o.key));
      if (!listed.truncated) break;
    }
    await this.env.ROOMS.get(this.env.ROOMS.idFromName(job.id)).destroy();
    for (let revision = 1; revision <= job.revision; revision++)
      await stop(
        this.env.RUNNERS.get(
          this.env.RUNNERS.idFromName(`${job.id}:${revision}`),
        ),
      );
    await this.ctx.storage.deleteAlarm();
  }
}

async function stop(runner: DurableObjectStub<BuildContainer>) {
  try {
    await runner.destroy();
  } catch {
    // Not running.
  }
}
