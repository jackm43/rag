export type ServiceCredential = {
  clientId: string;
  clientSecret: string;
};

export const actorToken = (credential: ServiceCredential): string =>
  `${credential.clientId}:${credential.clientSecret}`;

export const serviceCredentialFromEnv = (env: {
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
}): ServiceCredential | null =>
  env.SERVICE_CLIENT_ID && env.SERVICE_CLIENT_SECRET
    ? { clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET }
    : null;
