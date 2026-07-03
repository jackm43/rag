// Slash-command surface. Mirrors the registry pre-flight exactly: every
// user may run the public commands, admin commands need the rag-admins
// group, and a raghammer ban forbids /rag plus the AI commands (read-only
// boards stay available to banned users).

@id("user-commands")
permit (
  principal is Human,
  action in [
    Action::"command.rag",
    Action::"command.ragboard",
    Action::"command.ragspend",
    Action::"command.ragspendboard",
    Action::"command.ask",
    Action::"command.bicture",
    Action::"command.ragjam"
  ],
  resource is Guild
);

@id("admin-commands")
permit (
  principal in Group::"rag-admins",
  action in [
    Action::"command.raghammer",
    Action::"command.ragunban",
    Action::"command.undorag"
  ],
  resource is Guild
);

@id("banned")
forbid (
  principal is Human,
  action in [
    Action::"command.rag",
    Action::"command.ask",
    Action::"command.bicture",
    Action::"command.ragjam"
  ],
  resource
) when { context has banned && context.banned };
