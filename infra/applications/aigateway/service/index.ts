import {
  createPlatformServiceClient,
  type ConnectorConfig,
  type Identity,
} from "@platy/sdk";

export const APPLICATION = "aigateway";
export type Connection = Omit<ConnectorConfig, "application">;

export const aigateway = {
  chatServiceClient: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).chatServiceClient(),
};
