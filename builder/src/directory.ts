import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export type Listing = {
  slug: string;
  id: string;
  guild: string;
  title: string;
  summary: string;
  updated: number;
};

// Maps app URL slugs to projects and lists published apps for the hub page.
// Projects remain the source of truth for status and access.
export class Directory extends DurableObject<Env> {
  /** Reserve `slug` for `id`; true if it is free or already theirs. */
  async claim(slug: string, id: string) {
    const owner = await this.ctx.storage.get<string>("slug:" + slug);
    if (owner && owner !== id) return false;
    await this.ctx.storage.put("slug:" + slug, id);
    return true;
  }

  async resolve(slug: string) {
    return (await this.ctx.storage.get<string>("slug:" + slug)) ?? null;
  }

  async publish(listing: Listing) {
    await this.ctx.storage.put("app:" + listing.id, listing);
  }

  async unpublish(id: string) {
    await this.ctx.storage.delete("app:" + id);
  }

  async list(guilds: string[]) {
    const apps = await this.ctx.storage.list<Listing>({ prefix: "app:" });
    return [...apps.values()]
      .filter((app) => guilds.includes(app.guild))
      .sort((a, b) => b.updated - a.updated);
  }
}

export const directory = (env: Env) =>
  env.DIRECTORY.get(env.DIRECTORY.idFromName("apps"));

const STOP = new Set(
  "a an and app application build can could create for from game i it make me my of on our please site some that the this to us we website with you".split(
    " ",
  ),
);

/** A readable, stable URL slug: a few words from the request plus part of the id. */
export function slugFor(prompt: string, id: string, suffix = 4) {
  const words = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !STOP.has(word))
    .slice(0, 3);
  let stem = words.join("-").slice(0, 32).replace(/-+$/, "");
  if (!stem) stem = "app";
  return `${stem}-${id.slice(0, suffix)}`;
}
