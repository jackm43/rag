import { assert, test } from "vitest";

import { errorDetails } from "../../packages/logger/index.ts";

test("errorDetails logs only name, message, and cause name/message", () => {
  const cause = new Error("upstream refused");
  const error = new Error("request failed", { cause });
  Object.assign(error, { responseBody: '{"secret":"prompt text from upstream"}' });

  const details = errorDetails(error);

  assert.deepEqual(details, {
    name: "Error",
    message: "request failed",
    cause: { name: "Error", message: "upstream refused" },
  });
  assert.notInclude(JSON.stringify(details), "secret");
  assert.notInclude(JSON.stringify(details), "stack");
});

test("errorDetails stringifies non-Error values and causes", () => {
  assert.deepEqual(errorDetails("boom"), { message: "boom" });

  const withPlainCause = new Error("wrapper", { cause: 503 });
  assert.deepEqual(errorDetails(withPlainCause), {
    name: "Error",
    message: "wrapper",
    cause: { message: "503" },
  });

  const withoutCause = new Error("plain");
  assert.deepEqual(errorDetails(withoutCause), { name: "Error", message: "plain" });
});
