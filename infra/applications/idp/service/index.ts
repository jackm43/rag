import {
  createPlatformServiceClient,
  type ConnectorConfig,
  type Identity,
} from "@platy/sdk";

export const APPLICATION = "idp";
export type Connection = Omit<ConnectorConfig, "application">;

export const idp = {
  discoveryServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).discoveryServiceClient(),
  identityServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).identityServiceClient(),
  registryServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).registryServiceClient(),
  clientIdentityServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).clientIdentityServiceClient(),
  traceServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).traceServiceClient(),
};
