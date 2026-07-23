import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("fetch handler", () => {
  it("returns 404 for an unknown route", async () => {
    const response = await SELF.fetch("https://ragbot.jsmunro.me/unknown-route");

    expect(response.status).toBe(404);
  });
});
