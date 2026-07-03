// Dev-proxy capability surface.
//
// The gateway's DevProxy service-binding entrypoint authenticates the dev-proxy
// APPLICATION (via the verified identity-context token + service.invoke in
// services.cedar) and then, before it runs any command, asks this policy which
// command operations the dev application is permitted to proxy at all. This is
// the policy-driven capability surface: it is evaluated with the dev-proxy
// machine principal (NOT the human), so it bounds the dev tool independently of
// what any individual user may do.
//
// The command the payload names is authorized a SECOND time, per-user, by the
// ordinary command.* policy (commands.cedar) once the DevProxy entrypoint maps
// the call onto the existing command pre-flight — so a dev-proxy-initiated
// command is authorized identically to a Discord-initiated one, AND is
// additionally bounded by this app-level surface.
//
// Default surface: the same public commands a Discord user could run. The
// admin/moderation commands (raghammer, ragunban, undorag) are deliberately
// omitted — the dev tool is for exercising real read/AI paths, not moderating
// through a browser. Widen this list to grant the dev app more surface.

@id("devproxy-proxiable-commands")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"devproxy.invoke",
  resource == DevProxy::"gateway"
)
when
{
  context has command &&
  ["ask", "rag", "ragboard", "ragspend", "ragspendboard", "bicture", "ragjam"].contains(context.command)
};
