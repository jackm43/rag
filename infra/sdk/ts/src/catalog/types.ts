import type { HttpMethod, RouteContract } from "../http/types";

export type CatalogHttpMethod = {
  method: HttpMethod;
  path: `/${string}`;
  pathParams?: string[];
  stream?: "ndjson";
};

export type CatalogMethod = {
  name: string;
  scope: string;
  operationId: string;
  http: CatalogHttpMethod;
  route: RouteContract;
};

export type CatalogResource = {
  name: string;
  methods: CatalogMethod[];
};

export type CatalogApplication = {
  audience: string;
  apiName: string;
  resources: CatalogResource[];
  routePrefix: string;
};

export type PlatformCatalog = {
  applications: Record<string, CatalogApplication>;
};
