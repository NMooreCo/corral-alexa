import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError, type CorralTask } from "../src/household.ts";
import { serveMcp } from "../src/http.ts";
import * as entry from "../src/index.ts";
import worker, { type Env } from "../src/index.ts";
import { SampleHouseholdObject } from "../src/sample/durable.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { MAX_KEPT_BYTES, SharedSample, freeze, thaw } from "../src/sample/shared.ts";
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

  it("takes back a change too big to keep and says so, so every later save still works", async () => {
    const store = memoryStore();
    const fresh = new SampleHousehold({ now: () => FRIDAY });
    fresh.state.history.push({ at: FRIDAY.toZonedDateTimeISO("America/Denver").toString(), who: null, text: "" });
    // A household within a few bytes of what it keeps.
    const room = MAX_KEPT_BYTES - new TextEncoder().encode(freeze(fresh.state)).length;
    fresh.state.history.at(-1)!.text = "h".repeat(room - 20);
    store.save({ day: "2026-10-16", version: 7, state: freeze(fresh.state) });
    const h = new SharedSample(store, { now: () => FRIDAY });
    await expect(h.call("add_list_item", { list: "Groceries", text: "salsa" })).rejects.toThrow(new ToolError("Juniper Hollow can't keep any more, so that change wasn't made. Starting the household over makes room."));
    // Taken back everywhere: in the household, in its storage and in its change counter.
    expect(((await h.call("lists", { list: "Groceries" })) as { items: { text: string }[] }).items.map((i) => i.text)).not.toContain("Salsa");
    expect(store.load()).toMatchObject({ version: 7 });
    expect(await h.version()).toBe(7);
    // Starting over makes room.
    h.reset();
    expect(await h.call("add_list_item", { list: "Groceries", text: "salsa" })).toMatchObject({ status: "done" });
    expect(store.load()).toMatchObject({ version: 9 });
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
    expect(await h.call("supplies", {})).toHaveLength(5);
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
  const result = await toolResult(env, name, args, path, headers);
  // A screen tool's structuredContent is what its screen shows; any other tool's is its JSON answer, with a list wrapped as its items.
  const said = JSON.parse(result.content[0]!.text) as unknown;
  return Array.isArray(said) ? said : (result.structuredContent ?? said);
}

/** One MCP tool call's result as it comes, an error included. */
async function toolResult(env: Env, name: string, args: Record<string, unknown> = {}, path = "/mcp", headers: Record<string, string> = {}) {
  const res = await call(env, path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)!
    : text;
  return (JSON.parse(data) as { result: { content: { text: string }[]; structuredContent?: { items?: unknown }; isError?: boolean } }).result;
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
    expect(await (await call(env, "/household")).json()).toEqual({ household: "demo", name: "Juniper Hollow", day: "2026-10-16", version: 1, clock: { now: FRIDAY.toString(), offsetMinutes: 0, evening: false, morning: false } });
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
    // Pepper's out at dusk; Hunter slips out a couple of minutes into the demo's evening.
    expect(trackers.outsideFence).toEqual(["Pepper"]);

    const back = (await (await call(env, "/household/clock", { ...evening, headers: { ...evening.headers, "x-demo-passcode": "hay bale" }, body: JSON.stringify({ mode: "now" }) })).json()) as { clock: unknown };
    expect(back.clock).toEqual({ now: FRIDAY.toString(), offsetMinutes: 0, evening: false, morning: false });
  });

  it("moves on to the next morning keeping the night before, and the morning briefing says what happened", async () => {
    const { env } = sampleEnv();
    const setClock = async (mode: string) =>
      (await (await call(env, "/household/clock", { method: "POST", body: JSON.stringify({ mode }), headers: { "content-type": "application/json" } })).json()) as { day: string; version: number; clock: { now: string; morning: boolean; evening: boolean } };
    const as = (person: string) => ({ "x-demo-person": person });
    await setClock("evening");

    // The evening: Nick turns the barn heater on, Jak takes out the trash, Jon asks for hay and Nick says yes.
    await tool(env, "set_device", { device: "sample.barn-heater", state: "on" }, "/mcp", as("Nick"));
    await tool(env, "set_device", { device: "sample.tank-heater-horses", state: "on" }, "/mcp", as("Nick"));
    await tool(env, "set_automation", { automation: "freeze-protection", enabled: true }, "/mcp", as("Nick"));
    await tool(env, "complete_task", { task: await choreId(env, "Take out the trash") }, "/mcp", as("Jak"));
    const asked = (await tool(env, "place_order", { items: [{ supply: "Hay" }] }, "/mcp", as("Jon"))) as { orders?: unknown };
    expect(asked).toBeTruthy();
    const waiting = (await tool(env, "approvals", {}, "/mcp", as("Nick"))) as { toDecide: { id: string; from: string; asks: string }[] };
    const hay = waiting.toDecide.find((r) => r.from === "Jon")!;
    expect(hay.asks).toContain("hay");
    // The kitchen's Today screen shows it to a parent, to approve with a tap; a kid's doesn't.
    expect(((await tool(env, "show_today", {}, "/mcp", as("Nick"))) as { toDecide?: { id: string }[] }).toDecide?.map((r) => r.id)).toContain(hay.id);
    expect(((await tool(env, "show_today", {}, "/mcp", as("Eli"))) as { toDecide?: unknown }).toDecide).toBeUndefined();
    await tool(env, "decide_approval", { request: hay.id, decision: "approve" }, "/mcp", as("Nick"));

    const morning = await setClock("morning");
    // Friday evening becomes Saturday at 6:45 AM, the same household, one change on.
    expect(morning).toMatchObject({ day: "2026-10-17", clock: { morning: true, evening: true } });
    expect(Temporal.Instant.from(morning.clock.now).toZonedDateTimeISO("America/Denver").toPlainTime().toString()).toBe("06:45:00");

    // Last night stayed: the heater's still on and the hay's on order.
    const devices = (await tool(env, "show_ranch", {}, "/mcp", as("Nick"))) as { places: { devices: { name: string; state: string }[] }[] };
    expect(devices.places.flatMap((p) => p.devices).find((d) => d.name === "Barn heater")?.state).toBe("on");
    const orders = (await tool(env, "orders", {}, "/mcp", as("Nick"))) as { status: string; lines: string[] }[];
    expect(orders.some((o) => o.status === "placed")).toBe(true);
    // Today's daily chores are there and nothing from yesterday is late.
    const today = (await tool(env, "show_today", {}, "/mcp", as("Nick"))) as { tasks: { title: string; status: string; due: string }[] };
    expect(today.tasks.find((t) => t.title === "Feed the horses (morning)")).toMatchObject({ status: "open" });
    expect(today.tasks.some((t) => t.status === "overdue")).toBe(false);

    // The briefing opens on what happened since last night.
    const briefing = (await tool(env, "show_briefing", {}, "/mcp", as("Nick"))) as { greeting: string; cards: { id: string; lines: { text: string }[] }[] };
    expect(briefing.greeting).toBe("Good morning");
    const overnight = briefing.cards[0]!;
    expect(overnight.id).toBe("overnight");
    const said = overnight.lines.map((l) => l.text).join(" | ");
    // Devices switched together share a line; turning on an automation has its own.
    expect(said).toContain("Barn heater and horse tank heater on");
    expect(said).toMatch(/\d:\d\d PM: Freeze protection turned on/);
    expect(said).toContain("Take out the trash: done by Jak");
    expect(said).toContain("Nick approved Jon's request");
    // A kid hears about the ranch, not who ordered what.
    const kids = (await tool(env, "show_briefing", {}, "/mcp", as("Eli"))) as { cards: { id: string; lines: { text: string }[] }[] };
    const theirs = kids.cards.find((c) => c.id === "overnight")?.lines.map((l) => l.text).join(" | ") ?? "";
    expect(theirs).toContain("Barn heater and horse tank heater on");
    expect(theirs).not.toContain("approved");

    // Back to the real time starts it over.
    const back = await setClock("now");
    expect(back).toMatchObject({ day: "2026-10-16", clock: { morning: false, evening: false } });
  });

  it("tells a device what it should say on its own: Hunter slipping out a couple of minutes into the evening", async () => {
    const { env } = sampleEnv();
    await call(env, "/household/clock", { method: "POST", body: JSON.stringify({ mode: "evening" }), headers: { "content-type": "application/json" } });
    // The first ask only learns who's out (Pepper, since dusk) and answers a cursor.
    const first = (await tool(env, "alerts")) as { alerts: unknown[]; cursor: string };
    expect(first.alerts).toEqual([]);
    // Three minutes on, Hunter's out past the fence, and the next ask says so, once.
    vi.setSystemTime(FRIDAY.add({ minutes: 3 }).epochMilliseconds);
    const next = (await tool(env, "alerts", { since: first.cursor })) as { alerts: { kind: string; text: string }[]; cursor: string };
    expect(next.alerts).toHaveLength(1);
    expect(next.alerts[0]).toMatchObject({ kind: "animal" });
    expect(next.alerts[0]!.text).toMatch(/^Hunter just left the fence, about \d+ ft out to the northeast, near the Woods$/);
    expect(((await tool(env, "alerts", { since: next.cursor })) as { alerts: unknown[] }).alerts).toEqual([]);
    // A cursor that isn't one is said plainly.
    const bad = await call(env, "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alerts", arguments: { since: "yesterday" } } }),
    });
    expect(await bad.text()).toContain("since is the cursor an earlier call answered");
  });

  it("still says Hunter's slip when the device's cursor is from later in the real evening than the household's evening", async () => {
    const { env } = sampleEnv();
    // The device asked first at 11 PM real time; then someone made it evening, which puts the household at 8:15.
    vi.setSystemTime(FRIDAY.add({ hours: 12, minutes: 30 }).epochMilliseconds);
    const late = (await tool(env, "alerts")) as { cursor: string };
    await call(env, "/household/clock", { method: "POST", body: JSON.stringify({ mode: "evening" }), headers: { "content-type": "application/json" } });
    const caughtUp = (await tool(env, "alerts", { since: late.cursor })) as { alerts: unknown[]; cursor: string };
    expect(caughtUp.alerts).toEqual([]);
    vi.setSystemTime(FRIDAY.add({ hours: 12, minutes: 33 }).epochMilliseconds);
    const next = (await tool(env, "alerts", { since: caughtUp.cursor })) as { alerts: { text: string }[] };
    expect(next.alerts.map((a) => a.text)).toEqual([expect.stringMatching(/^Hunter just left the fence/)]);
  });

  it("answers an oversized change in words, and the shared household goes on saving for everyone", async () => {
    const { env } = sampleEnv();
    const eggs = await choreId(env, "Collect eggs");
    // More than one value in a Durable Object's SQLite storage holds.
    const result = await toolResult(env, "complete_task", { task: eggs, values: { note: "x".repeat(2_500_000) } });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('What a task asks for goes in values by key, like {"eggs": 9}') }] });
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "overdue" });
    expect(await tool(env, "household_version")).toEqual({ version: 1 });
    await tool(env, "complete_task", { task: eggs, values: { eggs: 9 } });
    expect(await chore(env, "Collect eggs")).toMatchObject({ status: "done" });
    expect(await tool(env, "household_version")).toEqual({ version: 2 });
  });

  it("starts over with no passcode when the server has none", async () => {
    const { env } = sampleEnv();
    expect((await call(env, "/household/reset", { method: "POST" })).status).toBe(200);
  });

  it("holds starting over and setting the clock to a per-visitor limit, counted before the passcode", async () => {
    const keys: string[] = [];
    let left = 2;
    const HOUSEHOLD_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: left-- > 0 }) } as unknown as RateLimit;
    const { env } = sampleEnv({ DEMO_PASSCODE: "hay bale", HOUSEHOLD_LIMIT });
    const from = { "cf-connecting-ip": "203.0.113.7" };
    const clock = (mode: string) => call(env, "/household/clock", { method: "POST", headers: { ...from, "content-type": "application/json", "x-demo-passcode": "hay bale" }, body: JSON.stringify({ mode }) });
    expect((await call(env, "/household/reset", { method: "POST", headers: { ...from, "x-demo-passcode": "straw" } })).status).toBe(401);
    expect((await clock("evening")).status).toBe(200);
    // Out of tries, even the right passcode waits a minute.
    const reset = await call(env, "/household/reset", { method: "POST", headers: { ...from, "x-demo-passcode": "hay bale" } });
    expect(reset.status).toBe(429);
    expect(await reset.json()).toMatchObject({ error: { code: "rate_limited", message: "That's a lot of changes to the household at once. Give it a minute." } });
    expect((await clock("now")).status).toBe(429);
    expect(keys).toEqual(Array(4).fill("203.0.113.7"));
    // The household is still on the evening the last change that got through set, and reading it isn't limited.
    expect(await (await call(env, "/household", { headers: from })).json()).toMatchObject({ clock: { evening: true } });
    expect(keys).toHaveLength(4);
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
        body: JSON.stringify({ messages: [{ role: "user", content: "Jon fed the horses." }], tools: [], context: { timeZone: "America/Denver", ...context } }),
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

  it("holds each visitor to a limit on the model, the voice and the household's own changes, locally and in the demo", async () => {
    process.env.WRANGLER_LOG = "error";
    const { unstable_readConfig } = await import("wrangler");
    const config = (env?: string) => unstable_readConfig({ config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), env });
    for (const env of [undefined, "demo"]) {
      const limits = Object.fromEntries(config(env).ratelimits.map((r: { name: string; simple: unknown }) => [r.name, r.simple]));
      expect(limits).toEqual({ MODEL_LIMIT: { limit: 20, period: 60 }, VOICE_LIMIT: { limit: 30, period: 60 }, HOUSEHOLD_LIMIT: { limit: 10, period: 60 } });
    }
    // Each environment counts on its own.
    expect(new Set([...config().ratelimits, ...config("demo").ratelimits].map((r) => r.namespace_id)).size).toBe(6);
    expect(config("production").ratelimits).toEqual([]);
  }, 30_000);
});
