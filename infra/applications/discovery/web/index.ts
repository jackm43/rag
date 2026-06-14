export {
  inlineQuery,
  operationQuery,
  applicationSummaryFields,
  applicationDetailFields,
  syncStateFields,
  applicationsListQuery,
  applicationDetailQuery,
  delegationGraphQuery,
  registryQuery,
} from "../graphql";
export type {
  ApplicationInfo,
  DelegationEdge,
  DelegationInfo,
  MethodInfo,
  ResourceInfo,
  SyncState,
} from "../graphql";
export type { DiscoveryClient } from "../graphql/graphql";
export { queryDiscovery } from "../graphql/graphql";

import { createPlatformWebClient, type BrowserAuth } from "@platy/web";
import type { DiscoveryClient } from "../graphql/graphql";

export const discoveryBrowserClient = (auth: BrowserAuth): DiscoveryClient => {
  const service = createPlatformWebClient(auth, "discovery").discoveryServiceClient();
  return {
    query: (input) =>
      service.query(input) as ReturnType<DiscoveryClient["query"]>,
    sync: (request) =>
      service.sync(request ?? {}) as ReturnType<DiscoveryClient["sync"]>,
  };
};
