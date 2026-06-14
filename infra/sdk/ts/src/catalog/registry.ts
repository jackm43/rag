import type { PlatformCatalog } from "./types";
import {
  bootstrapPlatformCatalog,
  registeredCatalogApplication,
  registeredPlatformCatalog,
  registerCatalogApplication,
  registerPlatformCatalog,
} from "./register";

export {
  bootstrapPlatformCatalog,
  registerCatalogApplication,
  registerPlatformCatalog,
  registeredCatalogApplication,
  registeredPlatformCatalog,
};

export const platformCatalog = (): PlatformCatalog => registeredPlatformCatalog();

export const catalogApplication = (application: string) => registeredCatalogApplication(application);

export const catalogRoutes = (application: string) => {
  const app = catalogApplication(application);
  return app.resources.flatMap((resource) => resource.methods.map((method) => method.route));
};

export const catalogMethod = (application: string, operationId: string) => {
  for (const resource of catalogApplication(application).resources) {
    for (const method of resource.methods) {
      if (method.operationId === operationId) {
        return method;
      }
    }
  }
  throw new Error(`operation ${application}.${operationId} is not in the platform catalog`);
};

export const catalogRoutePrefix = (application: string) =>
  catalogApplication(application).routePrefix;
