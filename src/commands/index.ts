import { ask } from "./ask";
import { bicture } from "./bicture";
import { rag } from "./rag";
import { ragboard } from "./ragboard";
import { raghammer } from "./raghammer";
import { ragjam } from "./ragjam";
import { ragspend } from "./ragspend";
import { ragspendboard } from "./ragspendboard";
import { ragunban } from "./ragunban";
import { undorag } from "./undorag";
import type { Command } from "../structs/command";

// The whole command surface, keyed by slash-command name. `data` is the single
// source of truth for the name (and, via Task 7, the registration payload).
export const commands: Map<string, Command> = new Map(
  [rag, ragboard, ragspend, ragspendboard, raghammer, ragunban, undorag, ask, bicture, ragjam].map(
    (command) => [command.data.name, command] as const,
  ),
);
