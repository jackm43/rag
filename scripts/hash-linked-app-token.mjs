const token = process.argv[2];
if (!token) {
  console.error("usage: node scripts/hash-linked-app-token.mjs <linked-app-token>");
  process.exitCode = 1;
} else {
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) {
    binary += String.fromCharCode(byte);
  }
  console.log(btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}
