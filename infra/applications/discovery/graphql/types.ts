export type MethodInfo = { name: string; scope: string };
export type ResourceInfo = { name: string; methods: MethodInfo[] };
export type DelegationInfo = { audience: string; scopes: string[] };

export type ApplicationInfo = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  provider: string;
  trustZone: string;
  createdAt: number;
  updatedAt: number;
  resources?: ResourceInfo[];
  delegations?: DelegationInfo[];
};

export type DelegationEdge = { application: string; audience: string; scopes: string[] };

export type SyncState = {
  syncedAt: number;
  applications: number;
  delegations: number;
  methods: number;
};
