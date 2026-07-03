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
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input, textarea, button, select { font: inherit; width: 100%; box-sizing: border-box; padding: 0.5rem; }
  button { margin-top: 1rem; cursor: pointer; }
  button.link { width: auto; background: none; border: none; color: #2563eb; padding: 0; text-decoration: underline; }
  pre { background: #f4f4f5; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
  .muted { color: #71717a; font-size: 0.85rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .conn { border: 1px solid #e4e4e7; border-radius: 6px; padding: 0.75rem 1rem 1rem; margin: 0.75rem 0; }
  .conn label { margin-top: 0.5rem; }
  .badge { font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 4px; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.no { background: #fee2e2; color: #991b1b; }
  .result { margin-top: 0.5rem; }
  .result.ok { color: #166534; }
  .result.warn { color: #92400e; }
  .result.err { color: #991b1b; }
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

  <h2>Connectors</h2>
  <p class="muted">Manage the credential broker's connectors and their secrets. Secret values are write-only — they are sent to the broker and never displayed here. A backend that cannot be written at runtime is disabled for value entry.</p>
  <p id="connStatus" class="muted">Loading connectors…</p>
  <div id="connectors"></div>
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
        loadConnectors();
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

  // --- Connectors admin surface ---------------------------------------------
  // Lists the broker's connectors and their secret status, and offers a per-
  // connector form to choose a secrets backend and write/rotate or re-point the
  // secret. Secret values are WRITE-ONLY: sent with credentials:"include" and
  // never displayed. Non-writable backends are disabled for value entry.
  var providersCache = [];

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); }); }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  async function loadProviders() {
    try {
      var res = await fetch("/api/secrets/providers", { credentials: "include" });
      if (!res.ok) { return []; }
      var data = await res.json();
      return (data && data.providers) || [];
    } catch (e) { return []; }
  }

  async function loadConnectors() {
    var status = $("connStatus");
    var host = $("connectors");
    host.innerHTML = "";
    status.textContent = "Loading connectors…";
    providersCache = await loadProviders();
    try {
      var res = await fetch("/api/connectors", { credentials: "include" });
      if (!res.ok) { status.textContent = "Could not load connectors (HTTP " + res.status + ")."; return; }
      var data = await res.json();
      var connectors = (data && data.connectors) || [];
      if (!connectors.length) { status.textContent = "No connectors configured."; return; }
      status.textContent = "";
      connectors.forEach(function (c) { host.appendChild(renderConnector(c)); });
    } catch (e) { status.textContent = "Failed to load connectors: " + e; }
  }

  function renderConnector(c) {
    var box = el("div", { "class": "conn" });

    var head = el("div", { "class": "row" });
    head.appendChild(el("strong", null, c.id));
    head.appendChild(el("span", { "class": "muted" }, c.kind + " · " + c.host));
    box.appendChild(head);

    var badge = el("span", { "class": "badge " + (c.secretConfigured ? "ok" : "no") }, c.secretConfigured ? "secret configured" : "no secret");
    var statusLine = el("div", { "class": "muted" });
    statusLine.appendChild(badge);
    statusLine.appendChild(document.createTextNode(" via " + c.secretProvider + " · flows: " + (c.flows || []).join(", ")));
    box.appendChild(statusLine);

    // 3LO connectors get an "Authorize" action: begin the consent flow as the
    // signed-in admin (POST grant), then follow the returned provider URL. The
    // provider redirects back to /api/connectors/{id}/callback, which completes
    // broker-side and shows a self-contained result page.
    if ((c.flows || []).indexOf("authorize") !== -1) {
      var authorize = el("button", null, "Authorize (3LO consent)");
      box.appendChild(authorize);
      var authResult = el("div", { "class": "result muted" });
      box.appendChild(authResult);
      authorize.addEventListener("click", async function () {
        authResult.className = "result muted";
        authResult.textContent = "Starting authorization…";
        try {
          var res = await fetch("/api/connectors/" + encodeURIComponent(c.id) + "/grant", {
            method: "POST",
            credentials: "include"
          });
          var data = null;
          try { data = await res.json(); } catch (e) { /* non-JSON error */ }
          if (res.ok && data && data.url) {
            authResult.textContent = "Redirecting to the provider consent page…";
            window.location.assign(data.url);
          } else {
            authResult.className = "result err";
            authResult.textContent = "HTTP " + res.status + ((data && data.error) ? " — " + data.error : "");
          }
        } catch (e) {
          authResult.className = "result err";
          authResult.textContent = "Request failed: " + e;
        }
      });
    }

    // github_app connectors get an installations view: the broker lists the
    // App's installations (the App JWT stays broker-side), the identifying
    // fields an admin needs to pick an installationId for a grant.
    if (c.kind === "github_app") {
      var insBtn = el("button", null, "List installations");
      box.appendChild(insBtn);
      var insResult = el("div", { "class": "result muted" });
      box.appendChild(insResult);
      insBtn.addEventListener("click", async function () {
        insResult.className = "result muted";
        insResult.textContent = "Loading installations…";
        try {
          var res = await fetch("/api/connectors/" + encodeURIComponent(c.id) + "/installations", { credentials: "include" });
          var data = null;
          try { data = await res.json(); } catch (e) { /* non-JSON error */ }
          if (!res.ok) {
            insResult.className = "result err";
            insResult.textContent = "HTTP " + res.status + ((data && data.error) ? " — " + data.error : "");
            return;
          }
          var installations = (data && data.installations) || [];
          if (!installations.length) { insResult.textContent = "No installations."; return; }
          insResult.textContent = "";
          var list = el("ul");
          installations.forEach(function (i) {
            list.appendChild(el("li", null, "#" + i.id + " — " + i.accountLogin + " (" + i.repositorySelection + " repositories)"));
          });
          insResult.appendChild(list);
        } catch (e) {
          insResult.className = "result err";
          insResult.textContent = "Request failed: " + e;
        }
      });
    }

    box.appendChild(el("label", null, "Secrets provider"));
    var select = el("select");
    providersCache.forEach(function (p) {
      var suffix = (p.writable ? "" : " (read-only at runtime)") + (p.configured ? "" : " (unconfigured)");
      var opt = el("option", { value: p.name }, p.name + suffix);
      if (p.name === c.secretProvider) { opt.setAttribute("selected", "selected"); }
      select.appendChild(opt);
    });
    box.appendChild(select);

    box.appendChild(el("label", null, "Reference / locator"));
    var ref = el("input", { placeholder: "e.g. secret/ragbot#GITHUB_APP_PRIVATE_KEY" });
    box.appendChild(ref);

    box.appendChild(el("label", null, "Secret value (optional — blank to only re-point)"));
    var val = el("input", { type: "password", placeholder: "write-only; never displayed" });
    box.appendChild(val);

    var save = el("button", null, "Save secret");
    box.appendChild(save);

    var result = el("div", { "class": "result muted" });
    box.appendChild(result);

    function updateWritability() {
      var p = providersCache.filter(function (x) { return x.name === select.value; })[0];
      var writable = p && p.writable;
      val.disabled = !writable;
      val.placeholder = writable ? "write-only; never displayed" : "not writable at runtime — provision out of band";
    }
    select.addEventListener("change", updateWritability);
    updateWritability();

    save.addEventListener("click", async function () {
      result.className = "result muted";
      result.textContent = "Saving…";
      var body = { provider: select.value };
      var r = ref.value.trim();
      if (r) { body.ref = r; }
      if (!val.disabled && val.value) { body.value = val.value; }
      if (!body.ref && !body.value) { result.className = "result err"; result.textContent = "Enter a reference or a value."; return; }
      if (body.value && !body.ref) { result.className = "result err"; result.textContent = "A value needs a reference to write to."; return; }
      try {
        var res = await fetch("/api/connectors/" + encodeURIComponent(c.id) + "/secret", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include"
        });
        val.value = ""; // never keep the value around, whatever the outcome
        var data = null;
        try { data = await res.json(); } catch (e) { /* non-JSON error */ }
        var secret = data && data.secret;
        if (secret) {
          var cls = (secret.status === "written" || secret.status === "referenced") ? "ok"
            : (secret.status === "provision_required" ? "warn" : "err");
          result.className = "result " + cls;
          result.textContent = secret.status + (secret.detail ? " — " + secret.detail : "");
          badge.className = "badge " + (secret.secretConfigured ? "ok" : "no");
          badge.textContent = secret.secretConfigured ? "secret configured" : "no secret";
        } else {
          result.className = "result err";
          result.textContent = "HTTP " + res.status + ((data && data.error) ? " — " + data.error : "");
        }
      } catch (e) {
        result.className = "result err";
        result.textContent = "Request failed: " + e;
      }
    });

    return box;
  }

  $("signin").addEventListener("click", signIn);
  $("signout").addEventListener("click", signOut);
  $("run").addEventListener("click", run);
  loadSession();
</script>
</body>
</html>`;
