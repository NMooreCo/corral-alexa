// Makes and updates Alexa's client on a running bridge, through /admin/clients.
// Needs ADMIN_TOKEN in the environment, matching the bridge's secret.
//
//   pnpm alexa:client create <bridge-url> [redirect-uri ...]
//   pnpm alexa:client redirects <bridge-url> <client-id> <redirect-uri ...>
//   pnpm alexa:client show <bridge-url> <client-id>
//
// Alexa shows its redirect addresses only after `alexa-ai configure-account-linking`,
// which needs the client id first: create without them, then set them with `redirects`.
const [command, bridge, ...rest] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!command || !bridge || !token) {
  console.error("Usage: ADMIN_TOKEN=... pnpm alexa:client create|redirects|show <bridge-url> ...");
  process.exit(1);
}
const base = bridge.replace(/\/+$/, "");

async function admin(method, path, body) {
  const res = await fetch(`${base}/admin/clients${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} /admin/clients${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

if (command === "create") {
  // Until Alexa says where to send people back, a harmless address on the bridge itself.
  const redirects = rest.length ? rest : [`${base}/no-redirect-yet`];
  const client = await admin("POST", "", { name: "Alexa+", redirect_uris: redirects });
  console.log(`client_id:     ${client.client_id}`);
  console.log(`client_secret: ${client.client_secret}`);
  console.log("Keep the secret now; it isn't shown again. Give it to the Alexa AI CLI through ALEXA_CLIENT_SECRET, never as a flag.");
} else if (command === "redirects") {
  const [id, ...uris] = rest;
  if (!id || !uris.length) throw new Error("Give the client id and at least one redirect address.");
  console.log(await admin("PUT", `/${encodeURIComponent(id)}`, { redirect_uris: uris }));
} else if (command === "show") {
  if (!rest[0]) throw new Error("Give the client id.");
  console.log(await admin("GET", `/${encodeURIComponent(rest[0])}`));
} else {
  throw new Error(`Unknown command "${command}".`);
}
