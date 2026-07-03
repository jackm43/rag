// The dev-proxy's single self-contained admin page. Deliberately minimal (per
// the build's "cut UI richness, not verification rigor" guidance).
//
// Auth is layered and handled entirely by cookies:
//   - Cloudflare Access (the perimeter) is transparent to this page — Access
//     attaches its cookie to every request automatically.
//   - Better Auth (Discord OAuth) provides the app identity. "Sign in with
//     Discord" asks Better Auth for the provider authorize URL and redirects to
//     it; after the callback the browser holds the session cookie. Commands POST
//     with credentials:"include" so that cookie rides along — no per-request
//     proof, no WebCrypto.
// The inner script uses string concatenation, not template literals, so it does
// not collide with this module's template string.
export const DEV_PROXY_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ragbot admin</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input, textarea, button { font: inherit; width: 100%; box-sizing: border-box; padding: 0.5rem; }
  button { margin-top: 1rem; cursor: pointer; }
  button.link { width: auto; background: none; border: none; color: #2563eb; padding: 0; text-decoration: underline; }
  pre { background: #f4f4f5; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
  .muted { color: #71717a; font-size: 0.85rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  #app { display: none; }
</style>
</head>
<body>
<h1>ragbot admin</h1>
<p class="muted">Runs real commands through the production gateway. Behind Cloudflare Access; app identity is your Discord login, and each command runs as your Discord user.</p>

<div id="auth">
  <p id="authStatus" class="muted">Checking session…</p>
  <button id="signin" style="display:none">Sign in with Discord</button>
</div>

<div id="app">
  <div class="row">
    <span class="muted">Signed in as <strong id="who"></strong></span>
    <button id="signout" class="link" type="button">Sign out</button>
  </div>

  <label for="command">Command</label>
  <input id="command" value="ragboard" />

  <label for="channel">Channel id (optional)</label>
  <input id="channel" placeholder="snowflake" />

  <label for="options">Options (JSON array of {name, value})</label>
  <textarea id="options" rows="3">[]</textarea>

  <button id="run">Run command</button>

  <label>Result</label>
  <pre id="out">—</pre>
</div>

<script>
  var $ = function (id) { return document.getElementById(id); };

  async function loadSession() {
    try {
      var res = await fetch("/api/auth/get-session", { credentials: "include" });
      var data = res.ok ? await res.json() : null;
      if (data && data.user) {
        $("who").textContent = data.user.name || data.user.email || data.user.id;
        $("auth").style.display = "none";
        $("app").style.display = "block";
        return;
      }
    } catch (e) { /* fall through to signed-out UI */ }
    $("authStatus").textContent = "Not signed in.";
    $("signin").style.display = "block";
    $("app").style.display = "none";
  }

  async function signIn() {
    $("authStatus").textContent = "Redirecting to Discord…";
    try {
      var res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "discord", callbackURL: "/" }),
        credentials: "include"
      });
      var data = await res.json();
      if (data && data.url) { window.location.href = data.url; return; }
      $("authStatus").textContent = "Could not start Discord sign-in.";
    } catch (e) {
      $("authStatus").textContent = "Sign-in request failed: " + e;
    }
  }

  async function signOut() {
    try { await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" }); }
    catch (e) { /* ignore; re-check below */ }
    loadSession();
  }

  async function run() {
    var out = $("out");
    out.textContent = "running…";
    var options;
    try { options = JSON.parse($("options").value || "[]"); }
    catch (e) { out.textContent = "Options must be valid JSON."; return; }
    var body = { command: $("command").value.trim(), options: options };
    var channel = $("channel").value.trim();
    if (channel) { body.channelId = channel; }
    try {
      var res = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include"
      });
      var text = await res.text();
      if (res.status === 401) {
        out.textContent = "HTTP 401 — session invalid or expired. Sign in again.";
        loadSession();
        return;
      }
      out.textContent = "HTTP " + res.status + "\\n\\n" + text;
    } catch (e) {
      out.textContent = "Request failed: " + e;
    }
  }

  $("signin").addEventListener("click", signIn);
  $("signout").addEventListener("click", signOut);
  $("run").addEventListener("click", run);
  loadSession();
</script>
</body>
</html>`;
