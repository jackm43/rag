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
// Default surface: the public commands a Discord user could run that also round
// trip synchronously. The dev-proxy runs commands synchronously and returns the
// real result, so only commands whose result IS that response are proxiable:
// inline commands (ragboard, ragspend, ragspendboard) and deferred-inline ones
// (ask, rag). The async media generators (bicture, ragjam) deliver to Discord
// out of band and cannot round trip here, so they are withheld rather than
// silently accepted and lost. The admin/moderation commands (raghammer,
// ragunban, undorag) are deliberately omitted — the dev tool exercises real
// read/AI paths, not moderation through a browser.
@id("devproxy-proxiable-commands")
permit (
  principal == Machine::"dev-proxy",
  action == Action::"devproxy.invoke",
  resource == DevProxy::"gateway"
)
when
{
  context has command &&
  ["ask", "rag", "ragboard", "ragspend", "ragspendboard"].contains(context.command)
};
