import {
  createPlatformServiceClient,
  type ConnectorConfig,
  type Identity,
} from "@platy/sdk";

export const APPLICATION = "ragbot";
export type Connection = Omit<ConnectorConfig, "application">;

export const ragbot = {
  configServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).configServiceClient(),
  interactionServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).interactionServiceClient(),
  chatServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).chatServiceClient(),
  leaderboardServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).leaderboardServiceClient(),
  databaseServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).databaseServiceClient(),
  gatewayControlServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).gatewayControlServiceClient(),
};
