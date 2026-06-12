import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";

import { errorMessage, logger } from "../../../../sdk/ts/src";
import type { Env } from "./types";

const ROTATION_SECONDS = 7 * 24 * 60 * 60;
const CURRENT_KEY = "signing:current";
const PREVIOUS_KEY = "signing:previous";

type StoredKey = {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  createdAt: number;
};

const generateStoredKey = async (): Promise<StoredKey> => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = crypto.randomUUID();
  return {
    kid,
    privateJwk: await exportJWK(privateKey),
    publicJwk: await exportJWK(publicKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
};

const publicJwkResponse = (key: StoredKey) => ({
  ...key.publicJwk,
  kid: key.kid,
  alg: "ES256",
  use: "sig",
});

export class SigningKeys {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) { }

  private async currentKey(): Promise<StoredKey> {
    let current = await this.state.storage.get<StoredKey>(CURRENT_KEY);
    const now = Math.floor(Date.now() / 1000);
    if (!current) {
      current = await generateStoredKey();
      await this.state.storage.put(CURRENT_KEY, current);
      logger.info("signing_key_created", { kid: current.kid });
      return current;
    }
    if (now - current.createdAt > ROTATION_SECONDS) {
      const next = await generateStoredKey();
      await this.state.storage.put(PREVIOUS_KEY, current);
      await this.state.storage.put(CURRENT_KEY, next);
      logger.info("signing_key_rotated", { kid: next.kid, retired: current.kid });
      return next;
    }
    return current;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/jwks" && request.method === "GET") {
      const current = await this.currentKey();
      const previous = await this.state.storage.get<StoredKey>(PREVIOUS_KEY);
      const keys = [publicJwkResponse(current)];
      if (previous) {
        keys.push(publicJwkResponse(previous));
      }
      return Response.json({ keys });
    }

    if (url.pathname === "/sign" && request.method === "POST") {
      try {
        const payload = (await request.json()) as Record<string, unknown>;
        const current = await this.currentKey();
        const privateKey = await importJWK(current.privateJwk, "ES256");
        const token = await new SignJWT(payload)
          .setProtectedHeader({ alg: "ES256", kid: current.kid })
          .sign(privateKey);
        return Response.json({ token });
      } catch (error) {
        logger.error("signing_failed", { error: errorMessage(error) });
        return Response.json({ error: "signing failed" }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }
}

export const signingKeysStub = (env: Env) =>
  env.SIGNING_KEYS.get(env.SIGNING_KEYS.idFromName("signing-keys"));

export const signToken = async (env: Env, payload: Record<string, unknown>): Promise<string> => {
  const response = await signingKeysStub(env).fetch(
    new Request("https://signing-keys/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (!response.ok) {
    throw new Error("token signing failed");
  }
  const body = (await response.json()) as { token: string };
  return body.token;
};

export const getJwks = async (env: Env): Promise<Response> =>
  signingKeysStub(env).fetch(new Request("https://signing-keys/jwks", { method: "GET" }));
