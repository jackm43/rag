import type { CatalogApplication, PlatformCatalog } from "./types";
import { PLATFORM_CATALOG } from "./data.generated";

const applications = new Map<string, CatalogApplication>();
let bootstrapped = false;

export const registerCatalogApplication = (application: CatalogApplication): void => {
  applications.set(application.audience, application);
};

export const registerPlatformCatalog = (catalog: PlatformCatalog): void => {
  for (const application of Object.values(catalog.applications)) {
    registerCatalogApplication(application);
  }
};

export const bootstrapPlatformCatalog = (): void => {
  if (bootstrapped) {
    return;
  }
  bootstrapped = true;
  registerPlatformCatalog(PLATFORM_CATALOG);
};

export const registeredCatalogApplication = (application: string): CatalogApplication => {
  bootstrapPlatformCatalog();
  const entry = applications.get(application);
  if (!entry) {
    throw new Error(`application ${application} is not registered in the platform catalog`);
  }
  return entry;
};

export const registeredPlatformCatalog = (): PlatformCatalog => {
  bootstrapPlatformCatalog();
  return { applications: Object.fromEntries(applications) };
};

export const isCatalogApplicationRegistered = (application: string): boolean => {
  bootstrapPlatformCatalog();
  return applications.has(application);
};
