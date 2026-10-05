// Small JSON helpers shared by the bot and the admin app.
export const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
