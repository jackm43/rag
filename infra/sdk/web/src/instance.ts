import type { BrowserAuth } from "./browser-auth";

// Chat session client SDK: each chat conversation is a federated client
// identity. The page generates a non-extractable ES256 key for the chat,
// registers it through the web application's worker (which acts for the user
// over its idp delegation), and receives the gateway-signed, key-bound
// identity document — application audience, user subject, key thumbprint.
// `headers` go on every request the chat makes, so the BFF partitions tokens
// per chat and spans carry the instance id.

export const CLIENT_INSTANCE_HEADER = "x-client-instance";
export const CLIENT_TOKEN_HEADER = "x-client-token";

export type ClientIdentityDocument = {
  instanceId: string;
  application: string;
  subject: string;
  email: string;
  kind: string;
  jkt: string;
  createdAt: number;
  expiresAt: number;
};

export type ChatInstance = {
  id: string;
  // Gateway-signed ES256 identity token (aud = the application, sub = the
  // user, cnf.jkt = this chat's key).
  token: string;
  identity: ClientIdentityDocument | null;
  // The chat's own keypair; private key is non-extractable.
  key: { privateKey: CryptoKey; publicJwk: JsonWebKey } | null;
  headers: Record<string, string>;
};

const generateInstanceKey = async (): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
};

export const registerChatInstance = async (
  auth: BrowserAuth,
  options: { path?: string; kind?: string } = {},
): Promise<ChatInstance> => {
  const key = await generateInstanceKey();
  const response = await auth.appPost(options.path ?? "/client/chats", {
    publicJwk: JSON.stringify(key.publicJwk),
    kind: options.kind ?? "chat",
  });
  if (!response.ok) {
    throw new Error(`chat registration failed (${response.status})`);
  }
  const body = (await response.json()) as {
    chatId?: string;
    token?: string;
    identity?: ClientIdentityDocument;
  };
  if (!body.chatId) {
    throw new Error("chat registration returned no chat id");
  }
  return {
    id: body.chatId,
    token: body.token ?? "",
    identity: body.identity ?? null,
    key,
    headers: {
      [CLIENT_INSTANCE_HEADER]: body.chatId,
      ...(body.token ? { [CLIENT_TOKEN_HEADER]: body.token } : {}),
    },
  };
};
