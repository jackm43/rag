// The dev-proxy's single self-contained page. Deliberately minimal (per the
// build's "cut UI richness, not verification rigor" guidance): it generates a
// non-extractable WebCrypto P-256 keypair in the browser, and for each command
// signs a fresh DPoP proof bound to the request. The Cloudflare Access token is
// attached automatically by Access (cookie), so the page never handles it.
//
// The private key lives in memory for the page's lifetime; persisting it to
// IndexedDB (so a reload keeps the same jkt-bound session) is a documented
// hardening, omitted here to keep the page dependency-free and self-contained.
// Inner script uses string concatenation, not template literals, so it does not
// collide with this module's template string.
export const DEV_PROXY_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ragbot dev proxy</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input, textarea, button { font: inherit; width: 100%; box-sizing: border-box; padding: 0.5rem; }
  button { margin-top: 1rem; cursor: pointer; }
  pre { background: #f4f4f5; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
  .muted { color: #71717a; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>ragbot dev proxy</h1>
<p class="muted">Runs real commands through the production gateway. Authenticated by Cloudflare Access and a per-request DPoP proof from a key generated in this tab.</p>
<p class="muted">DPoP key thumbprint (jkt): <code id="jkt">generating…</code></p>

<label for="command">Command</label>
<input id="command" value="ragboard" />

<label for="channel">Channel id (optional)</label>
<input id="channel" placeholder="snowflake" />

<label for="options">Options (JSON array of {name, value})</label>
<textarea id="options" rows="3">[]</textarea>

<button id="run">Run command</button>

<label>Result</label>
<pre id="out">—</pre>

<script>
  var keyPair = null;

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function encodeJson(obj) {
    return b64url(new TextEncoder().encode(JSON.stringify(obj)));
  }
  async function thumbprint(jwk) {
    var canonical = '{"crv":"' + jwk.crv + '","kty":"EC","x":"' + jwk.x + '","y":"' + jwk.y + '"}';
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return b64url(new Uint8Array(digest));
  }
  async function makeProof(htm, htu) {
    var pub = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    var jwk = { kty: "EC", crv: pub.crv, x: pub.x, y: pub.y };
    var header = { typ: "dpop+jwt", alg: "ES256", jwk: jwk };
    var payload = { htm: htm, htu: htu, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) };
    var signingInput = encodeJson(header) + "." + encodeJson(payload);
    var sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(signingInput));
    return signingInput + "." + b64url(new Uint8Array(sig));
  }

  async function init() {
    keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    var pub = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    document.getElementById("jkt").textContent = await thumbprint({ crv: pub.crv, x: pub.x, y: pub.y });
  }

  async function run() {
    var out = document.getElementById("out");
    out.textContent = "running…";
    var options;
    try { options = JSON.parse(document.getElementById("options").value || "[]"); }
    catch (e) { out.textContent = "Options must be valid JSON."; return; }
    var body = { command: document.getElementById("command").value.trim(), options: options };
    var channel = document.getElementById("channel").value.trim();
    if (channel) { body.channelId = channel; }
    var htu = location.origin + "/api/command";
    try {
      var proof = await makeProof("POST", htu);
      var res = await fetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json", "DPoP": proof },
        body: JSON.stringify(body)
      });
      var text = await res.text();
      out.textContent = "HTTP " + res.status + "\\n\\n" + text;
    } catch (e) {
      out.textContent = "Request failed: " + e;
    }
  }

  document.getElementById("run").addEventListener("click", run);
  init();
</script>
</body>
</html>`;
