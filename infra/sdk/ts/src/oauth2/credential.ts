import { resolveSecret, type WorkerSecret } from "../secrets/store";

export type ServiceCredential = {
  clientId: string;
  clientSecret: string;
};

export const actorToken = (credential: ServiceCredential): string =>
  `${credential.clientId}:${credential.clientSecret}`;

export type ServiceCredentialEnv = {
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: WorkerSecret;
};

export const serviceCredentialFromEnv = (env: ServiceCredentialEnv): ServiceCredential | null => {
  const clientId = env.SERVICE_CLIENT_ID?.trim();
  if (!clientId) {
    return null;
  }
  const clientSecret = env.SERVICE_CLIENT_SECRET;
  if (typeof clientSecret === "string" && clientSecret.trim() !== "") {
    return { clientId, clientSecret: clientSecret.trim() };
  }
  if (clientSecret && typeof clientSecret !== "string") {
    return { clientId, clientSecret: "" };
  }
  return null;
};

export const loadServiceCredentialFromEnv = async (
  env: ServiceCredentialEnv,
): Promise<ServiceCredential | null> => {
  const clientId = env.SERVICE_CLIENT_ID?.trim();
  if (!clientId) {
    return null;
  }
  const clientSecret = await resolveSecret(env.SERVICE_CLIENT_SECRET);
  if (!clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
};
