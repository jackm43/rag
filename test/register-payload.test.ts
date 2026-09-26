import { assert, expect, test } from "vitest";

import { buildCommandPayload } from "../scripts/register-commands";

const EXPECTED_NAMES = [
  "rag", "ragboard", "ragspend", "ragspendboard", "raghammer", "ragunban", "undorag", "ask", "bicture", "ragjam",
];

test("buildCommandPayload derives exactly the ten registered commands", () => {
  const payload = buildCommandPayload();

  assert.deepEqual(
    payload.map((command) => command.name).sort(),
    [...EXPECTED_NAMES].sort(),
  );
  assert.lengthOf(payload, 10);
});

test("every payload entry has a name and description", () => {
  const payload = buildCommandPayload();

  for (const command of payload) {
    assert.isString(command.name);
    assert.isNotEmpty(command.name);
    assert.isString(command.description);
    assert.isNotEmpty(command.description);
  }
});

test.each([
  { name: "ask's prompt option matches the original hand-written builder", command: "ask", options: [
    { type: 3, name: "prompt", description: "Question or topic for the new thread", required: true, min_length: 1, max_length: 6000 },
  ] },
  { name: "rag's user option matches the original hand-written builder", command: "rag", options: [
    { type: 6, name: "user", description: "User to mark as ragging", required: true },
  ] },
  { name: "ragjam has both the required prompt option and the optional lyrics option", command: "ragjam", options: [
    { type: 3, name: "prompt", description: "Music style, mood, and scenario", required: true, min_length: 1, max_length: 2000 },
    { type: 3, name: "lyrics", description: "Song lyrics; omit to auto-generate lyrics", required: false, min_length: 1, max_length: 3500 },
  ] },
].map(row => [row.name, row] as const))("%s", (_, { command, options }) => {
  const entry = buildCommandPayload().find(entry => entry.name === command);
  assert.isDefined(entry);
  expect(entry?.options).toEqual(options);
});
