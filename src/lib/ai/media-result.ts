import { isRecord } from "../contracts";

// Providers wrap media in up to two `result` envelopes.
export const mediaResultString = (result: unknown, field: "image" | "audio"): string | null => {
  for (let depth = 0; depth < 3 && isRecord(result); depth += 1) {
    const value = result[field];
    if (typeof value === "string" && value.length > 0) return value;
    result = result.result;
  }
  return null;
};
