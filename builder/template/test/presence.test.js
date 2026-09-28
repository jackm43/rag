import assert from "node:assert/strict";
import { test } from "node:test";
import { members } from "../src/presence.js";

test("one entry per member, counting tabs", () => {
  const peers = [
    { sid: "b", id: "2", name: "Zed" },
    { sid: "a", id: "1", name: "Amy" },
    { sid: "c", id: "2", name: "Zed" },
  ];
  assert.deepEqual(
    members(peers).map((m) => [m.name, m.tabs]),
    [
      ["Amy", 1],
      ["Zed", 2],
    ],
  );
});
