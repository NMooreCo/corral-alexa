import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CorralTask } from "../src/household.ts";
import { serveMcp } from "../src/http.ts";
import * as entry from "../src/index.ts";
import worker, { type Env } from "../src/index.ts";
import { SampleHouseholdObject } from "../src/sample/durable.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { SharedSample, freeze, thaw } from "../src/sample/shared.ts";
import { memoryStore } from "../src/sample/store.ts";
import { fakeHouseholds, forbiddenHouseholds } from "./fake-households.ts";
import { MemoryKV } from "./memory-kv.ts";

const CTX = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
// Friday, October 16, 2026, 10:30 AM in Denver.
const FRIDAY = Temporal.Instant.from("2026-10-16T16:30:00Z");
// Saturday, October 17, 2026, 12:05 AM in Denver: five minutes into the household's next day.
const SATURDAY = Temporal.Instant.from("2026-10-17T06:05:00Z");

async function taskId(h: { call: SharedSample["call"] }, title: string): Promise<string> {
  const tasks = (await h.call("tasks", { include_done: true })) as CorralTask[];
  return tasks.find((t) => t.title === title)!.id;
}

async function task(h: { call: SharedSample["call"] }, title: string): Promise<CorralTask> {
  const tasks = (await h.call("tasks", { include_done: true })) as CorralTask[];
  return tasks.find((t) => t.title === title)!;
}

describe("the shared sample household", () => {
  it("counts each change, and only changes", async () => {
    const store = memoryStore();
    const h = new SharedSample(store, { now: () => FRIDAY });
    expect(await h.version()).toBe(1);
    await h.call("tasks", {});
    await h.call("calendar", {});
    expect(await h.version()).toBe(1);
    // A refused change changes nothing.
    await expect(h.call("complete_task", { task: "nope" })).rejects.toThrow("Use the task's id");
    expect(await h.version()).toBe(1);
    await h.call("complete_task", { task: await taskId(h, "Collect eggs"), by: "Jak" });
    expect(await h.version()).toBe(2);
    await h.call("add_list_item", { list: "Groceries", text: "salsa" });
    expect(await h.version()).toBe(3);
    expect(store.load()).toMatchObject({ day: "2026-10-16", version: 3 });
  });

  it("comes back exactly as it was kept, after a restart", async () => {
    const store = memoryStore();
    const first = new SharedSample(store, { now: () => FRIDAY });
    await first.call("complete_task", { task: await taskId(first, "Collect eggs"), by: "Eli", values: { eggs: 9 } });
    await first.call("update_supply", { supply: "hay", change: "used", amount: 2 });
    // A new process, the same storage.
    const second = new SharedSample(store, { now: () => FRIDAY });
    expect(await task(second, "Collect eggs")).toMatchObject({ status: "done", doneBy: "Eli Rivera" });
    expect(await second.call("tasks", { include_done: true })).toEqual(await first.call("tasks", { include_done: true }));
    expect(await second.call("supplies", {})).toEqual(await first.call("supplies", {}));
    // Whereabouts run on Temporal instants, which have to come back as themselves.
    expect(await second.call("whereabouts", {})).toEqual(await first.call("whereabouts", {}));
    expect(await second.version()).toBe(await first.version());
  });

  it("keeps Temporal values as themselves in its JSON", () => {
    const state = new SampleHousehold({ now: () => FRIDAY }).state;
    const back = thaw(freeze(state))!;
    expect(back.stays[0]!.start).toBeInstanceOf(Temporal.Instant);
    expect(back.stays.map((s) => `${s.start}/${s.end}`)).toEqual(state.stays.map((s) => `${s.start}/${s.end}`));
    expect(freeze(back)).toBe(freeze(state));
    expect(thaw("not json")).toBeNull();
    expect(thaw("42")).toBeNull();
  });

  it("starts over when its day changes, with its counter still going up", async () => {
    let now = FRIDAY;
    const store = memoryStore();
    const h = new SharedSample(store, { now: () => now });
    await h.call("complete_task", { task: await taskId(h, "Collect eggs") });
    expect(await h.version()).toBe(2);
    now = SATURDAY;
    // Saturday's own chores, laid out around Saturday, with none of Friday's check-offs.
    expect(await task(h, "Collect eggs")).toMatchObject({ status: "open", due: "Sat, Oct 17, 9:00 AM" });
    expect(await h.version()).toBe(3);
    expect(store.load()).toMatchObject({ day: "2026-10-17", version: 3 });
  });

  it("starts over a household kept on another day when it comes back", async () => {
    const store = memoryStore();
    const friday = new SharedSample(store, { now: () => FRIDAY });
    await friday.call("complete_task", { task: await taskId(friday, "Collect eggs") });
    const saturday = new SharedSample(store, { now: () => SATURDAY });
    expect(await task(saturday, "Collect eggs")).toMatchObject({ status: "open", due: "Sat, Oct 17, 9:00 AM" });
    expect(await saturday.version()).toBe(3);
  });

  it("starts over on purpose", async () => {
    const store = memoryStore();
    const h = new SharedSample(store, { now: () => FRIDAY });
    await h.call("complete_task", { task: await taskId(h, "Collect eggs") });
    expect(h.reset()).toEqual({ name: "Juniper Hollow", day: "2026-10-16", version: 3 });
    expect(await task(h, "Collect eggs")).toMatchObject({ status: "overdue" });
    expect(store.load()?.version).toBe(3);
  });

  it("starts over a household kept by a build whose sample had other parts", async () => {
    const store = memoryStore();
    await new SharedSample(store, { now: () => FRIDAY }).version();
    const kept = store.load()!;
    const older = JSON.parse(kept.state) as Record<string, unknown>;
    delete older.supplies;
    store.save({ ...kept, state: JSON.stringify(older) });
    const h = new SharedSample(store, { now: () => FRIDAY });
    expect(await h.call("supplies", {})).toHaveLength(4);
    expect(await h.version()).toBe(2);
  });

  it("starts over a household kept by a build whose sample had other people", async () => {
    const store = memoryStore();
    await new SharedSample(store, { now: () => FRIDAY }).version();
    const kept = store.load()!;
    const older = JSON.parse(kept.state) as { people: { name: string; shortName: string }[] };
    older.people[0] = { ...older.people[0]!, name: "Sam Rivera", shortName: "Sam" };
    store.save({ ...kept, state: JSON.stringify(older) });
    const h = new SharedSample(store, { now: () => FRIDAY });
    expect(((await h.call("people", {})) as { shortName: string }[]).map((p) => p.shortName)).toContain("Nick");
    expect(await h.version()).toBe(2);
  });
});

// ---------- Through the Worker, with the household's Durable Object ----------

function sampleEnv(more: Partial<Env> = {}) {
  const households = fakeHouseholds();
  const env: Env = { BACKEND: "sample", SAMPLE_HOUSEHOLDS: households.namespace, ...more };
  return { households, env };
}

const call = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request(`https://bridge.example${path}`, init), env, CTX);

/** One MCP tool call the way Alexa+ makes it (2025-11-25, one POST), with the tool's JSON answer. */
async function tool(env: Env, name: string, args: Record<string, unknown> = {}, path = "/mcp", headers: Record<string, string> = {}) {
  const res = await call(env, path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)!
    : text;
  const result = (JSON.parse(data) as { result: { content: { text: string }[]; structuredContent?: unknown; isError?: boolean } }).result;
  return result.structuredContent ?? JSON.parse(result.content[0]!.text);
}

/** The id of a chore by its title, through MCP. */
async function choreId(env: Env, title: string, path = "/mcp"): Promise<string> {
  const tasks = (await tool(env, "tasks", { include_done: true }, path)) as CorralTask[];
  return tasks.find((t) => t.title === title)!.id;
}

async function chore(env: Env, title: string, path = "/mcp"): Promise<CorralTask> {
  const tasks = (await tool(env, "tasks", { include_done: true }, path)) as CorralTask[];
  return tasks.find((t) => t.title === title)!;
}

/** An Echo Show: its own MCP client, on the current protocol. */
async function device(env: Env, name: string, path = "/mcp"): Promise<Client> {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://bridge.example${path}`), { fetch: (input, init) => worker.fetch(new Request(input, init), env, CTX) }));
  return client;
}

describe("the sample household's Durable Object", () => {
  // The object keeps its own clock; hold it at Friday morning in Denver.
  beforeEach(() => vi.useFakeTimers({ now: FRIDAY.epochMilliseconds, toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("serves sample mode's MCP from the one shared household", async () => {
    const { households, env } = sampleEnv();
    const kitchen = await device(env, "kitchen");
    expect((await kitchen.listTools()).tools.map((t) => t.name)).toContain("show_today");
    await kitchen.close();
    expect(households.asked.length).toBeGreaterThan(0);
    expect(new Set(households.asked)).toEqual(new Set(["demo"]));
  });

  it("shows a chore checked off on one Echo Show on the other", async () => {
    const { env } = sampleEnv();
    const kitchen = await device(env, "kitchen");
    const barn = await device(env, "barn");
    const version = async (c: Client) => ((await c.callTool({ name: "household_version", arguments: {} })).structuredContent as { version: number }).version;
    const before = await version(barn);

    const id = await choreId(env, "Collect eggs");
    const done = await kitchen.callTool({ name: "complete_task", arguments: { task: id, by: "Jak" } });
    expect(done.isError).toBeFalsy();

    // The barn's screen sees the counter move, and its refresh has the chore done.
    expect(await version(barn)).toBe(before + 1);
    const today = (await barn.callTool({ name: "refresh_today", arguments: {} })).structuredContent as { tasks: CorralTask[] };
    expect(today.tasks.find((t) => t.id === id)).toMatchObject({ status: "done", doneBy: "Jak Rivera" });
    await kitchen.close();
    await barn.close();
  });

  it("hears who's speaking inside the object: a kid's request waits, and a parent on another device approves it", async () => {
    const { env } = sampleEnv();
    const as = (person: string) => ({ "x-demo-person": person });
    const sleepover = { title: "Sleepover at Ava's", start: "2026-10-23T18:00:00-06:00[America/Denver]", people: ["Eli"], location: "Ava's house" };

    const asked = (await tool(env, "add_event", sleepover, "/mcp", as("Eli"))) as { status: string; requestId: string };
    expect(asked).toMatchObject({ status: "waiting_for_approval", requestId: expect.any(String) });
    const waiting = (await tool(env, "approvals", {}, "/mcp", as("Nick"))) as { toDecide: { id: string }[] };
    expect(waiting.toDecide.map((r) => r.id)).toContain(asked.requestId);

    expect(await tool(env, "decide_approval", { request: asked.requestId, decision: "approve" }, "/mcp", as("Nick"))).toMatchObject({ status: "done" });
    const friday = (await tool(env, "calendar", { from: "2026-10-23", to: "2026-10-23" }, "/mcp", as("Holly"))) as { title: string }[];
    expect(friday.map((e) => e.title)).toContain("Sleepover at Ava's");
  });

  it("keeps the household in its SQLite storage through a restart", async () => {
    const { households, env } = sampleEnv();
    await tool(env, "complete_task", { task: await choreId(env, "Collect eggs"), by: "Eli" });
    households.restart();
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "done", doneBy: "Eli Rivera" });
    const row = households.databases.get("demo")!.prepare("SELECT day, version, state FROM household").get() as { day: string; version: number; state: string };
    expect(row).toMatchObject({ day: "2026-10-16", version: 2 });
    expect(thaw(row.state)?.tasks.find((t) => t.title === "Collect eggs")?.status).toBe("done");
  });

  it("starts over when the household's day changes", async () => {
    const { households, env } = sampleEnv();
    await tool(env, "complete_task", { task: await choreId(env, "Collect eggs") });
    households.restart();
    vi.setSystemTime(SATURDAY.epochMilliseconds);
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "open", due: "Sat, Oct 17, 9:00 AM" });
    expect(await tool(env, "household_version")).toEqual({ version: 3 });
  });

  it("keeps another household, named with ?household=, apart from the shared one", async () => {
    const { households, env } = sampleEnv();
    await tool(env, "complete_task", { task: await choreId(env, "Collect eggs", "/mcp?household=take-2") }, "/mcp?household=take-2");
    expect(await chore(env, "Collect eggs", "/mcp?household=take-2")).toMatchObject({ status: "done" });
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "overdue" });
    expect(new Set(households.asked)).toEqual(new Set(["take-2", "demo"]));
  });

  it("refuses a household id that isn't one, without waking an object", async () => {
    const { households, env } = sampleEnv();
    for (const id of ["../etc", "Juniper%20Hollow", "x".repeat(41)]) {
      const res = await call(env, `/mcp?household=${id}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(400);
    }
    expect(households.asked).toEqual([]);
  });

  it("says how the household stands, and starts it over after the demo passcode", async () => {
    const { env } = sampleEnv({ DEMO_PASSCODE: "hay bale" });
    expect(await (await call(env, "/household")).json()).toEqual({ household: "demo", name: "Juniper Hollow", day: "2026-10-16", version: 1, clock: { now: FRIDAY.toString(), offsetMinutes: 0, evening: false } });
    await tool(env, "complete_task", { task: await choreId(env, "Collect eggs") });

    expect((await call(env, "/household/reset", { method: "POST" })).status).toBe(401);
    expect((await call(env, "/household/reset", { method: "POST", headers: { "x-demo-passcode": "straw" } })).status).toBe(401);
    expect((await call(env, "/household/reset")).status).toBe(405);
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "done" });

    const res = await call(env, "/household/reset", { method: "POST", headers: { "x-demo-passcode": " hay bale " } });
    expect(await res.json()).toMatchObject({ household: "demo", name: "Juniper Hollow", day: "2026-10-16", version: 3 });
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "overdue" });
  });

  it("runs the household at evening when a visitor asks, so the demo's evening is there at any hour", async () => {
    const { env } = sampleEnv({ DEMO_PASSCODE: "hay bale" });
    const evening = { method: "POST", body: JSON.stringify({ mode: "evening" }), headers: { "content-type": "application/json" } };
    expect((await call(env, "/household/clock", evening)).status).toBe(401);
    expect((await call(env, "/household/clock", { ...evening, headers: { ...evening.headers, "x-demo-passcode": "hay bale" }, body: JSON.stringify({ mode: "noon" }) })).status).toBe(400);

    const set = (await (await call(env, "/household/clock", { ...evening, headers: { ...evening.headers, "x-demo-passcode": "hay bale" } })).json()) as { clock: { now: string } };
    // Friday at 10:30 AM in Denver becomes 8:15 PM the same day.
    expect(set).toMatchObject({ day: "2026-10-16", clock: { offsetMinutes: 585, evening: true } });
    expect(Temporal.Instant.from(set.clock.now).toZonedDateTimeISO("America/Denver").toPlainTime().toString()).toBe("20:15:00");
    // Everything about the household follows: the Today screen's clock and the animals out for the night.
    const today = (await tool(env, "show_today")) as { at: string };
    expect(Temporal.Instant.from(today.at).toZonedDateTimeISO("America/Denver").hour).toBe(20);
    const trackers = (await tool(env, "trackers")) as { outsideFence: string[] };
    expect(trackers.outsideFence).toEqual(["Hunter", "Pepper"]);

    const back = (await (await call(env, "/household/clock", { ...evening, headers: { ...evening.headers, "x-demo-passcode": "hay bale" }, body: JSON.stringify({ mode: "now" }) })).json()) as { clock: unknown };
    expect(back.clock).toEqual({ now: FRIDAY.toString(), offsetMinutes: 0, evening: false });
  });

  it("starts over with no passcode when the server has none", async () => {
    const { env } = sampleEnv();
    expect((await call(env, "/household/reset", { method: "POST" })).status).toBe(200);
  });

  it("offers screens its change counter, kept from the model", async () => {
    const { env } = sampleEnv();
    const kitchen = await device(env, "kitchen");
    const counter = (await kitchen.listTools()).tools.find((t) => t.name === "household_version");
    expect(counter?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    expect(counter?.annotations?.readOnlyHint).toBe(true);
    await kitchen.close();
  });

  it("is exported by the Worker, as Wrangler needs it to be", () => {
    expect(entry.SampleHouseholdObject).toBe(SampleHouseholdObject);
  });
});

describe("the two-device view", () => {
  it("serves a kitchen Echo Show 8 and a barn Echo Show 5 on one household at /echo?devices=2", async () => {
    const res = await call({ BACKEND: "sample" }, "/echo?devices=2");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("One household, two Echo Shows");
    // Each device is the simulator's own page in a frame: its own MCP client, conversation and screen.
    expect(html).toMatch(/<iframe id="kitchen"[^>]*allow="microphone/);
    expect(html).toMatch(/<iframe id="barn"[^>]*allow="microphone/);
    expect(html).toContain("embed");
    // One device is still the default.
    expect(await (await call({ BACKEND: "sample" }, "/echo")).text()).not.toContain("One household, two Echo Shows");
  });

  it("tells the model which room the display is in", async () => {
    const systems: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = (await new Request(input, init).json()) as { system: { text: string }[] };
      systems.push(body.system.map((s) => s.text).join("\n"));
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    });
    try {
      const turn = (context: Record<string, string>) => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Jordan fed the horses." }], tools: [], context: { timeZone: "America/Denver", ...context } }),
      });
      const env: Env = { BACKEND: "sample", ANTHROPIC_API_KEY: "key" };
      expect((await call(env, "/echo/model", turn({ place: "Barn" }))).status).toBe(200);
      expect((await call(env, "/echo/model", turn({}))).status).toBe(200);
      expect(systems[0]).toContain("This display is in the barn.");
      expect(systems[1]).not.toContain("This display is in");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("corral mode", () => {
  it("never asks for a sample household, whatever the path", async () => {
    const forbidden = forbiddenHouseholds();
    const env: Env = { BACKEND: "corral", CORRAL_URL: "https://corral.example", OAUTH_KV: new MemoryKV() as unknown as KVNamespace, SAMPLE_HOUSEHOLDS: forbidden.namespace };
    const mcp = await call(env, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(401);
    for (const path of ["/household", "/household?household=take-2", "/echo?devices=2"]) expect((await call(env, path)).status).not.toBe(200);
    expect((await call(env, "/household/reset", { method: "POST" })).status).not.toBe(200);
    expect(forbidden.asked).toEqual([]);
  });

  it("offers no change counter for a household that keeps none, so screens keep their own refresh", async () => {
    // A linked household, like Corral's, has no version().
    const linked = { about: async () => ({ name: "Linked" }), call: async () => [] };
    const res = await serveMcp(
      new Request("https://bridge.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      linked,
    );
    const text = await res.text();
    const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5) : text;
    const names = (JSON.parse(data) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("refresh_today");
    expect(names).not.toContain("household_version");
  });
});

describe("the Wrangler config", () => {
  it("binds the SQLite-backed household object locally and in the demo, and never in production", async () => {
    process.env.WRANGLER_LOG = "error";
    const { unstable_readConfig } = await import("wrangler");
    const config = (env?: string) => unstable_readConfig({ config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), env });
    for (const env of [undefined, "demo"]) {
      const c = config(env);
      expect(c.vars.BACKEND).toBe("sample");
      expect(c.durable_objects.bindings).toEqual([{ name: "SAMPLE_HOUSEHOLDS", class_name: "SampleHouseholdObject" }]);
      expect(c.exports).toEqual({ SampleHouseholdObject: { type: "durable-object", storage: "sqlite" } });
      expect(c.migrations).toEqual([]);
    }
    const production = config("production");
    expect(production.vars.BACKEND).toBe("corral");
    expect(production.durable_objects.bindings).toEqual([]);
    expect(production.exports).toEqual({});
    expect(production.migrations).toEqual([]);
  }, 30_000);
});
