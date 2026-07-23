import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";

import { verifyDiscordSignature } from "../src/lib/verify";

const encoder = new TextEncoder();

const signedRequest = (
  payload: unknown,
  secretKey: Uint8Array,
  timestamp = String(Math.floor(Date.now() / 1000)),
) => {
  const rawBody = JSON.stringify(payload);
  const message = encoder.encode(timestamp + rawBody);
  const signature = nacl.sign.detached(message, secretKey);
  const signatureHex = Buffer.from(signature).toString("hex");

  const request = new Request("https://example.com/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signatureHex,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });

  return { request, rawBody };
};

describe("verifyDiscordSignature", () => {
  it("returns true for a validly signed request", () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const { request, rawBody } = signedRequest({ type: 1 }, keyPair.secretKey);

    expect(verifyDiscordSignature(publicKeyHex, request, rawBody)).toBe(true);
  });

  it("returns false for a signature from the wrong key", () => {
    const validPair = nacl.sign.keyPair();
    const mismatchedPair = nacl.sign.keyPair();
    const publicKeyHex = Buffer.from(validPair.publicKey).toString("hex");
    const { request, rawBody } = signedRequest({ type: 1 }, mismatchedPair.secretKey);

    expect(verifyDiscordSignature(publicKeyHex, request, rawBody)).toBe(false);
  });

  it("returns false for a stale timestamp (>5 min skew)", () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const { request, rawBody } = signedRequest({ type: 1 }, keyPair.secretKey, staleTimestamp);

    expect(verifyDiscordSignature(publicKeyHex, request, rawBody)).toBe(false);
  });

  it("returns false (without throwing) for a malformed/non-hex signature header", () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 1 });
    const request = new Request("https://example.com/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "not-hex-zz",
        "x-signature-timestamp": timestamp,
      },
      body: rawBody,
    });

    expect(() => verifyDiscordSignature(publicKeyHex, request, rawBody)).not.toThrow();
    expect(verifyDiscordSignature(publicKeyHex, request, rawBody)).toBe(false);
  });

  it("returns false when the signature/timestamp headers are missing", () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
    const rawBody = JSON.stringify({ type: 1 });
    const request = new Request("https://example.com/interactions", {
      method: "POST",
      body: rawBody,
    });

    expect(verifyDiscordSignature(publicKeyHex, request, rawBody)).toBe(false);
  });
});
