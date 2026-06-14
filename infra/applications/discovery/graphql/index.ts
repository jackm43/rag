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
} from "./query";
export type {
  ApplicationInfo,
  DelegationEdge,
  DelegationInfo,
  MethodInfo,
  ResourceInfo,
  SyncState,
} from "./types";
export type { DiscoveryClient } from "./graphql";
export { queryDiscovery } from "./graphql";
