import { assert, test } from "vitest";

import { routeInteraction } from "../../../packages/domain/commands/router.ts";
import { executeCommand, type CommandSpec } from "../../../packages/domain/commands/registry.ts";
import { APPLICATION_COMMAND, type Env } from "../../../packages/contracts/types.ts";

const executionCtx = {} as ExecutionContext;

test("router replies with a fallback for unknown commands", async () => {
  const response = await routeInteraction(
    { type: APPLICATION_COMMAND, data: { name: "definitely-not-a-command" } },
    {} as Env,
    executionCtx,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "Unknown command." },
  });
});

test("registry pre-flight rejects a missing required option before running the command", async () => {
  const spec: CommandSpec = {
    name: "spec-test",
    kind: "inline",
    requiredOptions: [{ name: "target", message: "A target is required." }],
    run: () => {
      throw new Error("run should not be reached");
    },
  };

  const response = await executeCommand(
    spec,
    { type: APPLICATION_COMMAND, data: { name: "spec-test", options: [] } },
    {} as Env,
    executionCtx,
  );

  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "A target is required.", allowed_mentions: { parse: [] } },
  });
});

test("registry pre-flight denies admin-only commands to non-admin invokers", async () => {
  const spec: CommandSpec = {
    name: "spec-admin-test",
    kind: "inline",
    adminOnly: true,
    run: () => {
      throw new Error("run should not be reached");
    },
  };

  const response = await executeCommand(
    spec,
    {
      type: APPLICATION_COMMAND,
      data: { name: "spec-admin-test" },
      member: { user: { id: "999", username: "eve" } },
    },
    {} as Env,
    executionCtx,
  );

  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "You are not allowed to use /spec-admin-test.",
      allowed_mentions: { parse: [] },
    },
  });
});

test("registry pre-flight refuses to enqueue without interaction credentials", async () => {
  const spec: CommandSpec = {
    name: "spec-enqueue-test",
    kind: "enqueue",
    buildJob: () => {
      throw new Error("buildJob should not be reached");
    },
  };

  const response = await executeCommand(
    spec,
    {
      type: APPLICATION_COMMAND,
      data: { name: "spec-enqueue-test" },
      member: { user: { id: "1", username: "alice" } },
    },
    {} as Env,
    executionCtx,
  );

  assert.deepEqual(await response.json(), {
    type: 4,
    data: {
      content: "Could not defer /spec-enqueue-test without interaction credentials.",
      allowed_mentions: { parse: [] },
    },
  });
});
