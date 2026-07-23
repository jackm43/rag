import { assert, test } from "vitest";

import { buildCommandPayload } from "../scripts/register-commands";

const EXPECTED_NAMES = [
  "rag",
  "ragboard",
  "ragspend",
  "ragspendboard",
  "raghammer",
  "ragunban",
  "undorag",
  "ask",
  "bicture",
  "ragjam",
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

test("ask's prompt option matches the original hand-written builder", () => {
  const payload = buildCommandPayload();
  const ask = payload.find((command) => command.name === "ask");
  assert.isDefined(ask);

  assert.deepEqual(ask?.options, [
    {
      type: 3,
      name: "prompt",
      description: "Question or topic for the new thread",
      required: true,
      min_length: 1,
      max_length: 6000,
    },
  ]);
});

test("rag's user option matches the original hand-written builder", () => {
  const payload = buildCommandPayload();
  const rag = payload.find((command) => command.name === "rag");
  assert.isDefined(rag);

  assert.deepEqual(rag?.options, [
    {
      type: 6,
      name: "user",
      description: "User to mark as ragging",
      required: true,
    },
  ]);
});

test("ragjam has both the required prompt option and the optional lyrics option", () => {
  const payload = buildCommandPayload();
  const ragjam = payload.find((command) => command.name === "ragjam");
  assert.isDefined(ragjam);

  assert.deepEqual(ragjam?.options, [
    {
      type: 3,
      name: "prompt",
      description: "Music style, mood, and scenario",
      required: true,
      min_length: 1,
      max_length: 2000,
    },
    {
      type: 3,
      name: "lyrics",
      description: "Song lyrics; omit to auto-generate lyrics",
      required: false,
      min_length: 1,
      max_length: 3500,
    },
  ]);
});
