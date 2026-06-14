import {
  createPlatformServiceClient,
  type ConnectorConfig,
  type Identity,
} from "@platy/sdk";

export const APPLICATION = "deploy";
export type Connection = Omit<ConnectorConfig, "application">;

export const deploy = {
  deployServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).deployServiceClient(),
};
