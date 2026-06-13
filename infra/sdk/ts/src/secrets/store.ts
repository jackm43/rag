export type SecretsStoreSecret = {
  get(): Promise<string>;
};

export type WorkerSecret = string | SecretsStoreSecret | undefined;

export const resolveSecret = async (value: WorkerSecret): Promise<string> => {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return value.get();
};

export const requireSecret = async (value: WorkerSecret, name: string): Promise<string> => {
  const resolved = await resolveSecret(value);
  if (!resolved) {
    throw new Error(`${name} is not configured`);
  }
  return resolved;
};
