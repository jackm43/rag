import { describe, expect, it } from "vitest";
import { verifyDiscordSignature } from "../src/lib/verify";
import { signedRequest, signingFixture } from "./helpers";

describe("verifyDiscordSignature", () => {
  it.each([
    ["returns true for a validly signed request", "valid", true],
    ["returns false for a signature from the wrong key", "wrong", false],
    ["returns false for a stale timestamp (>5 min skew)", "stale", false],
    ["returns false (without throwing) for a malformed/non-hex signature header", "malformed", false],
    ["returns false when the signature/timestamp headers are missing", "missing", false],
  ] as const)("%s", (_, scenario, expected) => {
    const { publicKeyHex, secretKey } = signingFixture();
    const timestamp = String(Math.floor(Date.now() / 1000) - (scenario === "stale" ? 360 : 0));
    const { request, rawBody } = signedRequest({ type: 1 }, scenario === "wrong" ? signingFixture().secretKey : secretKey, timestamp);
    if (scenario === "malformed") request.headers.set("x-signature-ed25519", "not-hex-zz");
    if (scenario === "missing") {
      request.headers.delete("x-signature-ed25519");
      request.headers.delete("x-signature-timestamp");
    }
    expect(() => verifyDiscordSignature(publicKeyHex, request, rawBody)).not.toThrow();
    expect(verifyDiscordSignature(publicKeyHex, request, rawBody)).toBe(expected);
  });
});
