// Checks the live demo the way a judge meets it: the simulator's page, the MCP server (in a household of
// its own, so it never moves anyone's clock), one real model turn and one Polly line. Exits 1 if any part
// fails, so a scheduled run alerts. Usage: DEMO_PASSCODE=... pnpm health [base], default the demo.
const base = (process.argv[2] ?? "https://alexa-demo.corral.narralogy.ai").replace(/\/+$/, "");
const passcode = process.env.DEMO_PASSCODE;
const household = "health-check";
// A spoken answer that takes longer than this to start would feel broken to a judge.
const SLOW_MODEL_MS = 12_000;

const results = [];
async function check(name, run) {
  const started = performance.now();
  try {
    const note = await run();
    results.push({ name, ok: true, ms: Math.round(performance.now() - started), note });
  } catch (err) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - started), note: err instanceof Error ? err.message : String(err) });
  }
}

const gated = passcode ? { "x-demo-passcode": passcode } : {};

await check("page", async () => {
  const res = await fetch(`${base}/echo`);
  const html = await res.text();
  if (!res.ok || !html.includes("simulated Echo Show")) throw new Error(`/echo answered ${res.status}`);
  if (!html.includes('data-voice="polly"')) throw new Error("the page says Polly isn't set up, so it would speak with the browser's voice");
  return "the simulator, with Polly";
});

let id = 0;
async function rpc(method, params = {}) {
  const res = await fetch(`${base}/mcp?household=${household}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-11-25" }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} answered ${res.status}`);
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1) : text;
  const body = JSON.parse(data);
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let tools = [];
await check("mcp", async () => {
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "demo-health", version: "1" } });
  tools = (await rpc("tools/list")).tools;
  const today = (await rpc("tools/call", { name: "show_today", arguments: {} })).structuredContent;
  if (!today?.events?.length) throw new Error("show_today came back without events");
  return `${tools.length} tools; show_today has ${today.events.length} events and ${today.tasks.length} chores`;
});

await check("model", async () => {
  if (!passcode) throw new Error("set DEMO_PASSCODE to check the model");
  const res = await fetch(`${base}/echo/model`, {
    method: "POST",
    headers: { "content-type": "application/json", ...gated },
    body: JSON.stringify({
      messages: [{ role: "user", content: "What's going on today?" }],
      // The tools the simulator gives the model: not the screen-only ones, and without $schema.
      tools: tools
        .filter((t) => !t._meta?.ui?.visibility || t._meta.ui.visibility.includes("model"))
        .map(({ name, title, description, inputSchema: { $schema: _drop, ...schema } }) => ({ name, description: description ?? title ?? name, input_schema: schema })),
      context: { timeZone: "America/Denver", now: new Date().toLocaleString("en-US", { timeZone: "America/Denver", dateStyle: "full", timeStyle: "short" }) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/echo/model answered ${res.status}: ${body.error?.message ?? ""}`);
  const uses = (body.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name);
  const said = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
  if (!uses.length && !said) throw new Error("the model answered with nothing");
  return `${body.model}: ${uses.length ? `calls ${uses.join(", ")}` : `says "${said.slice(0, 60)}"`}`;
});

await check("voice", async () => {
  if (!passcode) throw new Error("set DEMO_PASSCODE to check the voice");
  const res = await fetch(`${base}/echo/voice`, { method: "POST", headers: { "content-type": "application/json", ...gated }, body: JSON.stringify({ text: "Everything's running at Juniper Hollow." }) });
  const audio = await res.arrayBuffer();
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("audio/mpeg")) throw new Error(`/echo/voice answered ${res.status}`);
  if (audio.byteLength < 2000) throw new Error(`Polly's audio was only ${audio.byteLength} bytes`);
  return `${res.headers.get("x-voice")}, ${Math.round(audio.byteLength / 1024)} KB`;
});

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(6)} ${String(r.ms).padStart(6)} ms  ${r.note}`);
const model = results.find((r) => r.name === "model");
if (model?.ok && model.ms > SLOW_MODEL_MS) console.log(`slow: one model turn took ${(model.ms / 1000).toFixed(1)} s`);
const failed = results.filter((r) => !r.ok);
if (failed.length || (model?.ok && model.ms > SLOW_MODEL_MS)) {
  console.log(`\nThe demo needs a look: ${[...failed.map((r) => r.name), ...(model?.ok && model.ms > SLOW_MODEL_MS ? ["slow model"] : [])].join(", ")}.`);
  process.exit(1);
}
console.log("\nThe demo is healthy.");
