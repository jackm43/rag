// Wire-validation kernel: the character classes, caps, and tiny predicates
// every app's message validators are built from. App-specific job validators
// live with their app's contracts (apps/*/contracts, @rag/outbound/contracts).
// Value constraints the Cap'n Proto schema cannot express. Applied at encode
// (producer) and decode (consumer) time so neither side trusts the other hop.
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const MAX_FREE_TEXT_LENGTH = 4000;
export const MAX_USERNAME_LENGTH = 100;
export const MAX_INTERACTION_TOKEN_LENGTH = 2000;

export const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const isString = (value: unknown): value is string => typeof value === "string";

export const isSnowflake = (value: unknown): value is string =>
  isString(value) && SNOWFLAKE_PATTERN.test(value);

export const isOptionalSnowflake = (value: unknown) => value === undefined || isSnowflake(value);

export const isFreeText = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_FREE_TEXT_LENGTH;

export const isOptionalFreeText = (value: unknown) => value === undefined || isFreeText(value);

export const isUsername = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_USERNAME_LENGTH;

export const isOptionalUsername = (value: unknown) => value === undefined || isUsername(value);

export const isInteractionToken = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_INTERACTION_TOKEN_LENGTH;

// Gateway message content may be empty (e.g. attachment-only messages); the
// workflows drops anything that resolves to an empty prompt.
export const isCappedText = (value: unknown): value is string =>
  isString(value) && value.length <= MAX_FREE_TEXT_LENGTH;
