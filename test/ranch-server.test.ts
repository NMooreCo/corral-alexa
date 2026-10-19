import { Temporal } from "temporal-polyfill";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveMcp } from "../src/http.ts";
import worker, { type Env } from "../src/index.ts";
import { BRIEFING_URI, RANCH_URI } from "../src/ranch/views.ts";
import { clearWeatherCache } from "../src/ranch/weather.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { openMeteo, openMeteoFetch } from "./ranch-fixtures.ts";

const CTX = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const SAMPLE: Env = { BACKEND: "sample" };

type Rpc = { result?: Record<string, any>; error?: { message: string } };

async function rpc(method: string, params: Record<string, unknown> = {}, send: (req: Request) => Promise<Response> = (req) => worker.fetch(req, SAMPLE, CTX), headers: Record<string, string> = {}): Promise<Rpc> {
  const res = await send(
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1)! : text;
  return JSON.parse(data) as Rpc;
}

const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result!;

let forecastCalls: string[] = [];
beforeEach(() => {
  // Evening at the ranch, whatever time the tests run: before 10 AM "tonight" is the night that's ending.
  const today = Temporal.Now.plainDateISO("America/Denver");
  vi.useFakeTimers({ now: today.toZonedDateTime({ timeZone: "America/Denver", plainTime: "20:00" }).epochMilliseconds, toFake: ["Date"] });
  clearWeatherCache();
  const stub = openMeteoFetch(openMeteo(today.toString(), { lows: [30, 12, 20, 35, 41] }));
  forecastCalls = stub.urls;
  vi.stubGlobal("fetch", stub.fetch);
});
afterEach(() => vi.useRealTimers());
afterAll(() => vi.unstubAllGlobals());

describe("the ranch over MCP", () => {
  it("tells the assistant there's a ranch and how to switch things safely", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "alexa", version: "1" } });
    expect(result!.instructions).toContain("It also runs the ranch");
    expect(result!.instructions).toContain("switch one only after the person says yes");
  });

  it("marks what reads, what switches, and what reaches past the server", async () => {
    const { result } = await rpc("tools/list");
    const tool = (name: string) => (result!.tools as { name: string; annotations: Record<string, boolean>; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } }; inputSchema: { required?: string[] } }[]).find((t) => t.name === name)!;
    expect(tool("devices").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool("weather").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool("trackers").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool("set_device").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tool("set_device").inputSchema.required).toEqual(["device", "state"]);
    expect(tool("set_device")._meta?.ui?.resourceUri).toBe(RANCH_URI);
    expect(tool("show_ranch")._meta?.ui?.resourceUri).toBe(RANCH_URI);
    expect(tool("refresh_ranch")._meta?.ui).toEqual({ resourceUri: RANCH_URI, visibility: ["app"] });
    expect(tool("show_briefing")._meta?.ui?.resourceUri).toBe(BRIEFING_URI);
  });

  it("serves the Ranch and briefing screens as self-contained pages that reach no other origin", async () => {
    for (const uri of [RANCH_URI, BRIEFING_URI]) {
      const [page] = (await rpc("resources/read", { uri })).result!.contents as { uri: string; mimeType: string; text: string; _meta: unknown }[];
      expect(page).toMatchObject({ uri, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
      expect(page!.text).toMatch(/^<!doctype html>/i);
      expect(page!.text).not.toMatch(/<script[^>]+src=/);
      expect(page!.text).not.toMatch(/(src|href)=["']?https?:/);
    }
  });

  it("answers devices, weather and trackers in words", async () => {
    const devices = JSON.parse((await call("devices", { place: "Greenhouse" })).content[0].text);
    expect(devices.map((d: { name: string }) => d.name)).toEqual(["Greenhouse misters", "Greenhouse air", "Greenhouse beds", "Greenhouse heater"]);
    expect(devices[0]).toMatchObject({ id: "greenhouse.valve1", state: "off", maxRun: "10 minutes", defaultRun: "2 minutes", ifUnreachable: "switches itself off", live: false });

    const weather = JSON.parse((await call("weather")).content[0].text);
    expect(weather).toMatchObject({ place: "Juniper Hollow", tonight: { low: "12°F", freeze: true, hardFreeze: true } });
    expect(new URL(forecastCalls[0]!).searchParams.get("latitude")).toBe("43.4400");

    const animals = JSON.parse((await call("trackers")).content[0].text);
    expect(animals.animals).toHaveLength(9);
    // Coordinates stay out of what the assistant reads.
    expect(animals.animals[0].position).toBeUndefined();
    expect(animals.lowBattery).toEqual(["Matilda"]);
  });

  it("shows the ranch: a map with the fence, zones and a pin per collar, and every device by place", async () => {
    const result = await call("show_ranch");
    const view = result.structuredContent;
    expect(view.household).toBe("Juniper Hollow");
    expect(view.map.fence).toMatch(/^M.* Z$/);
    expect(view.map.zones.map((z: { name: string }) => z.name)).toEqual(expect.arrayContaining(["North pasture", "South pasture", "Barn", "Coop", "House", "Garden", "Greenhouse"]));
    expect(view.map.pins).toHaveLength(9);
    expect(view.map.scale.label).toMatch(/ft$/);
    expect(view.places[0].name).toBe("Greenhouse");
    expect(view.weather).toMatchObject({ tonight: "Low 12°F tonight", freeze: true });
    // The assistant hears the gist, not the drawing.
    const said = JSON.parse(result.content[0].text);
    expect(said.shown).toMatch(/^The Ranch screen/);
    expect(result.content[0].text).not.toContain(view.map.fence);
    expect(said.needsAttention).toContain("Propane tank: Propane is low: 18%");
  });

  it("switches a device, answering the change to the assistant and the Ranch screen with the run to the screen", async () => {
    const result = await call("set_device", { device: "greenhouse misters", state: "on", seconds: 30 });
    const change = JSON.parse(result.content[0].text);
    expect(change).toMatchObject({ status: "done", summary: expect.stringMatching(/^Greenhouse misters on for 30 seconds, until \d{1,2}:\d\d [AP]M$/) });
    const misters = result.structuredContent.places[0].devices[0];
    expect(misters).toMatchObject({ id: "greenhouse.valve1", state: "on", run: { secondsLeft: 30 } });
    expect(Date.parse(misters.run.endsAt) - Date.now()).toBeGreaterThan(25_000);
    // The screen's own refresh sees the same run.
    const refreshed = (await call("refresh_ranch")).structuredContent.places[0].devices[0];
    expect(refreshed.state).toBe("on");
    expect(JSON.parse((await call("set_device", { device: "greenhouse.valve1", state: "off" })).content[0].text).summary).toBe("Greenhouse misters off");
  });

  it("says a limit back to the assistant as a tool error, and switches nothing", async () => {
    const result = await call("set_device", { device: "misters", state: "on", minutes: 45 });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "The Greenhouse misters runs at most 10 minutes at a time. Offer 10 minutes or less." }] });
    expect(result.structuredContent).toBeUndefined();
  });

  it("shows the briefing as cards, in order, saying what needs a look", async () => {
    const view = (await call("show_briefing")).structuredContent;
    expect(view.greeting).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(view.cards.map((c: { id: string }) => c.id)).toEqual(["today", "weather", "chores", "supplies", "animals", "place:Greenhouse", "devices"]);
    const card = (id: string) => view.cards.find((c: { id: string }) => c.id === id);
    expect(card("weather")).toMatchObject({ warn: true, headline: expect.stringContaining("Low 12°F tonight: hard freeze") });
    expect(card("supplies").lines.map((l: { text: string }) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^Dog food: 4 lb/)]));
    expect(card("devices").lines.map((l: { text: string }) => l.text)).toContain("Propane tank: Propane is low: 18%");
    expect(card("animals").lines.map((l: { text: string }) => l.text)).toContain("Matilda's collar battery is at 11%");
  });

  it("goes up without the forecast when Open-Meteo is down", async () => {
    clearWeatherCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect((await call("show_ranch")).structuredContent.weather).toBeNull();
    expect((await call("show_briefing")).structuredContent.cards[1]).toMatchObject({ id: "weather", headline: "The forecast isn't reachable right now." });
    expect(await call("weather")).toMatchObject({ isError: true });
  });

  it("offers no ranch tools to a household without a ranch", async () => {
    const { result } = await rpc("tools/list", {}, (req) => serveMcp(req, new SampleHousehold()));
    const names = (result!.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("devices");
    expect(names).not.toContain("show_ranch");
    expect(names).toContain("show_today");
  });
});

describe("who may switch the ranch's devices", () => {
  const as = (person: string) => async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args }, undefined, { "x-demo-person": person })).result!;

  it("lets a parent or the farm hand switch a device, and tells a kid or a guest who can", async () => {
    const lamp = { device: "coop heat lamp", state: "on" };
    const kid = await as("Jak")("set_device", lamp);
    expect(kid.isError).toBe(true);
    expect(kid.content[0].text).toBe("Jak can't switch the ranch's devices. Nick, Holly or Jon can.");
    const guest = await as("guest")("set_device", lamp);
    expect(guest.isError).toBe(true);
    expect(guest.content[0].text).toContain("Nick, Holly or Jon can.");

    for (const grownUp of ["Nick", "Jon"]) expect((await as(grownUp)("set_device", lamp)).isError).toBeFalsy();
  });

  it("tells a kid who can switch a device when they look at it, before anything is offered", async () => {
    const kid = JSON.parse((await as("Jak")("devices", { device: "coop heat lamp" })).content[0].text);
    expect(kid.switching).toBe("Jak can't switch the ranch's devices. Nick, Holly or Jon can.");
    expect(kid.devices[0].name).toBe("Coop heat lamp");
    const parent = JSON.parse((await as("Nick")("devices", { device: "coop heat lamp" })).content[0].text);
    expect(Array.isArray(parent)).toBe(true);
  });

  it("lets the same people change the automations, and shows the change on the Automations tab", async () => {
    const kid = await as("Jak")("set_automation", { automation: "Freeze protection", enabled: true });
    expect(kid.isError).toBe(true);
    expect(kid.content[0].text).toContain("Nick, Holly or Jon can.");
    expect(JSON.parse((await as("Jak")("automations")).content[0].text).changing).toContain("Nick, Holly or Jon can.");

    const parent = await as("Nick")("set_automation", { automation: "Freeze protection", enabled: true });
    expect(parent.isError).toBeFalsy();
    expect(JSON.parse(parent.content[0].text)).toMatchObject({ name: "Freeze protection", enabled: true });
    expect(parent.structuredContent).toMatchObject({ tab: "automations" });
    expect(parent.structuredContent.automations.find((a: { name: string }) => a.name === "Freeze protection")).toMatchObject({ enabled: true });

    const added = await as("Holly")("add_automation", { name: "Evening misting", when: { kind: "schedule", times: ["18:00"] }, then: [{ device: "greenhouse misters", state: "on", minutes: 1 }] });
    expect(added.isError).toBeFalsy();
    expect(JSON.parse(added.content[0].text)).toMatchObject({ name: "Evening misting", when: "Every day at 6:00 PM", then: ["Run the greenhouse misters for 1 minute"] });
  });

  it("opens the Ranch screen on the tab asked for", async () => {
    expect((await as("Nick")("show_ranch", { view: "animals" })).structuredContent).toMatchObject({ tab: "animals" });
    expect((await as("Nick")("show_ranch")).structuredContent.tab).toBeUndefined();
  });
});

describe("starting the household over", () => {
  it("starts the ranch's devices over too, so every demo take begins the same", async () => {
    const lamp = async () => ((await call("devices", { device: "coop heat lamp" })).structuredContent ?? JSON.parse((await call("devices", { device: "coop heat lamp" })).content[0].text)) as unknown;
    const state = async () => JSON.stringify(await lamp()).includes('"state":"on"');
    expect((await call("set_device", { device: "coop heat lamp", state: "on" })).isError).toBeFalsy();
    expect(await state()).toBe(true);
    const reset = await worker.fetch(new Request("https://bridge.example/household/reset", { method: "POST" }), SAMPLE, CTX);
    expect(reset.status).toBe(200);
    expect(await state()).toBe(false);
  });
});
