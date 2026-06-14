export const operationIdForMethod = (name: string): string =>
  name.charAt(0).toLowerCase() + name.slice(1);

export const serviceClientKey = (resourceName: string): string =>
  `${resourceName.charAt(0).toLowerCase()}${resourceName.slice(1)}Client`;

export const methodClientKey = (methodName: string): string =>
  operationIdForMethod(methodName);
