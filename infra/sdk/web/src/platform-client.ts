import { createPlatformAuthClient } from "@platy/sdk/client/platform-auth";
import type { PlatformWebClientOptions } from "@platy/sdk/client/platform-web";

import type { BrowserAuth } from "./browser-auth";

export type { PlatformWebClientOptions };

export type PlatformWebServiceClient = Record<string, (...args: any[]) => any>;

export type PlatformWebClients = Record<string, () => PlatformWebServiceClient>;

export const createPlatformWebClient = (
  auth: BrowserAuth,
  application: string,
  options: PlatformWebClientOptions = {},
): PlatformWebClients =>
  createPlatformAuthClient({
    application,
    request: (app, path, init) => auth.request(app, path, init),
  }).catalog(application, options) as PlatformWebClients;
