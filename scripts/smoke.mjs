// Talks to a running bridge the way Alexa+ does (MCP 2025-11-25, one POST per
// message) and prints what it finds. Usage: pnpm smoke [url], default
// http://127.0.0.1:8795/mcp. Set CORRAL_TOKEN to send a Bearer credential.
const url = process.argv[2] ?? "http://127.0.0.1:8795/mcp";
const token = process.env.CORRAL_TOKEN;

let id = 0;
async function rpc(method, params = {}) {
  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-11-25" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text}`);
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)
    : text;
  const body = JSON.parse(data);
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return { result: body.result, ms };
}

const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
console.log(`initialize: protocol ${init.result.protocolVersion}, server ${init.result.serverInfo.name} ${init.result.serverInfo.version} (${init.ms} ms)`);

const list = await rpc("tools/list");
console.log(`tools/list: ${list.result.tools.length} tools (${list.ms} ms): ${list.result.tools.map((t) => t.name).join(", ")}`);

const today = await rpc("tools/call", { name: "show_today", arguments: {} });
const view = today.result.structuredContent;
console.log(`show_today (${today.ms} ms): ${view.events.length} events, ${view.tasks.length} chores, ${view.whereabouts.length} people`);
for (const e of view.events) console.log(`  ${e.when}  ${e.title}`);

const page = await rpc("resources/read", { uri: list.result.tools.find((t) => t.name === "show_today")._meta.ui.resourceUri });
console.log(`Today screen: ${page.result.contents[0].mimeType}, ${Math.round(page.result.contents[0].text.length / 1024)} KB (${page.ms} ms)`);
