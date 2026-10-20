import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/household.ts";
import { DeviceHub } from "../src/ranch/devices.ts";
import { GreenhouseController, controllerBase, isLocalHost, probeFault } from "../src/ranch/greenhouse.ts";
import { localGreenhouse } from "../src/ranch/index.ts";
import { SAMPLE_GREENHOUSE, simulatedController } from "../src/sample/ranch.ts";

// Friday, October 16, 2026, 10:30 AM in Denver.
const START = Temporal.Instant.from("2026-10-16T16:30:00Z");
const KEY = "test-key-not-real";

function clock() {
  let now = START;
  return { now: () => now, advance: (seconds: number) => (now = now.add({ seconds })) };
}

/** A fake controller with the firmware's routes and JSON, recording every call. */
function fakeController(now: () => Temporal.Instant) {
  const sim = simulatedController({ now, timeZone: "America/Denver", key: KEY });
  const calls: { method: string; url: string; key: string | null }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ method: req.method, url: req.url, key: req.headers.get("x-api-key") });
    return sim(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function controller(opts: { fetch: typeof fetch; now: () => Temporal.Instant; calibrated?: boolean; timeoutMs?: number; maxRunS?: number }) {
  return new GreenhouseController({
    url: "192.0.2.72",
    key: KEY,
    config: { ...SAMPLE_GREENHOUSE, ...(opts.calibrated ? {} : { calibration: undefined }), limits: { ...SAMPLE_GREENHOUSE.limits, ...(opts.maxRunS ? { maxRunS: opts.maxRunS } : {}) } },
    units: "us",
    timeZone: "America/Denver",
    live: true,
    fetch: opts.fetch,
    now: opts.now,
    timeoutMs: opts.timeoutMs ?? 200,
    cacheMs: 0,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("the greenhouse controller connector (against a fake controller)", () => {
  it("reads /status into the valve, the air and the soil, in the household's units", async () => {
    const c = clock();
    const fake = fakeController(c.now);
    const devices = await controller({ fetch: fake.fetch, now: c.now }).list();
    expect(fake.calls).toEqual([{ method: "GET", url: "http://192.0.2.72/status", key: null }]);
    expect(devices.map((d) => d.id)).toEqual(["greenhouse.valve1", "greenhouse.climate", "greenhouse.soil"]);
    const [valve, air, soil] = devices;
    expect(valve).toMatchObject({ name: "Greenhouse misters", kind: "valve", place: "Greenhouse", live: true, switchable: true, state: "off", run: null, reachable: true, limits: { maxRunS: 600, defaultRunS: 120, failsafe: "off" } });
    expect(air!.readings.map((r) => [r.label, r.unit])).toEqual([
      ["Air temperature", "°F"],
      ["Humidity", "%"],
      ["Station pressure", "hPa"],
    ]);
    expect(air!.readings[2]!.text).toBe("852.5 hPa");
    // An uncalibrated bed reads its raw millivolts, never a made-up percentage.
    expect(soil!.readings.map((r) => r.text)).toEqual(["1,640 mV", "1,830 mV", "2,390 mV", "1,520 mV", "1,700 mV"]);
    expect(soil!.note).toMatch(/higher is drier/);
  });

  it("turns calibrated beds into percentages and flags a dry one", async () => {
    const c = clock();
    const soil = (await controller({ fetch: fakeController(c.now).fetch, now: c.now, calibrated: true }).list())[2]!;
    expect(soil.readings.map((r) => r.text)).toEqual(["72%", "59%", "19%", "81%", "68%"]);
    expect(soil.readings[2]).toMatchObject({ label: "Bed 3", low: true });
    expect(soil.attention).toEqual(["Bed 3 is low: 19%"]);
    expect(soil.note).toBeUndefined();
  });

  it("runs the valve with POST /on?sec=N and the key, then counts the run down until the firmware closes it", async () => {
    const c = clock();
    const fake = fakeController(c.now);
    const gh = controller({ fetch: fake.fetch, now: c.now });
    const after = await gh.set("greenhouse.valve1", { state: "on", seconds: 30 });
    expect(fake.calls.at(-1)).toEqual({ method: "POST", url: "http://192.0.2.72/on?sec=30", key: KEY });
    expect(after).toMatchObject({ state: "on", run: { secondsLeft: 30, endsLabel: "10:30 AM" } });
    c.advance(12);
    expect((await gh.list())[0]!.run!.secondsLeft).toBe(18);
    c.advance(20);
    expect((await gh.list())[0]).toMatchObject({ state: "off", run: null });
  });

  it("closes the valve with POST /off", async () => {
    const c = clock();
    const fake = fakeController(c.now);
    const gh = controller({ fetch: fake.fetch, now: c.now });
    await gh.set("greenhouse.valve1", { state: "on", seconds: 300 });
    const after = await gh.set("greenhouse.valve1", { state: "off" });
    expect(fake.calls.at(-1)).toEqual({ method: "POST", url: "http://192.0.2.72/off", key: KEY });
    expect(after).toMatchObject({ state: "off", run: null });
  });

  it("never switches anything but the valve", async () => {
    const c = clock();
    const gh = controller({ fetch: fakeController(c.now).fetch, now: c.now });
    await expect(gh.set("greenhouse.climate", { state: "on", seconds: 5 })).rejects.toThrow(ToolError);
  });

  it("says a refused key plainly, without the key, and switches nothing", async () => {
    const c = clock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gh = new GreenhouseController({ url: "http://greenhouse.local", key: "wrong-key", config: SAMPLE_GREENHOUSE, units: "us", timeZone: "America/Denver", live: true, fetch: fakeController(c.now).fetch, now: c.now, cacheMs: 0 });
    const err = await gh.set("greenhouse.valve1", { state: "on", seconds: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe("The greenhouse controller didn't accept this connection's key, so nothing was switched.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("wrong-key");
  });

  it("passes on the firmware's own refusal of a bad run length", async () => {
    const c = clock();
    const gh = controller({ fetch: fakeController(c.now).fetch, now: c.now });
    await expect(gh.set("greenhouse.valve1", { state: "on", seconds: 0 })).resolves.toMatchObject({ state: "on" });
    // The connector never sends less than a second; a hand-made bad request shows what the firmware says.
    const res = await fakeController(c.now).fetch("http://g/on?sec=-5", { method: "POST", headers: { "X-Api-Key": KEY } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "sec must be a positive integer" });
  });

  it("caps any run at the firmware's 1800 seconds, whatever the configuration says", async () => {
    const c = clock();
    const valve = (await controller({ fetch: fakeController(c.now).fetch, now: c.now, maxRunS: 99_999 }).list())[0]!;
    expect(valve.limits.maxRunS).toBe(1800);
  });

  it("when the controller doesn't answer, says so, keeps its last readings, and says the valve looks after itself", async () => {
    const c = clock();
    const fake = fakeController(c.now);
    let down = false;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!down) return fake.fetch(input, init);
      // A controller that's gone: nothing comes back until the request gives up.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    }) as typeof globalThis.fetch;
    const gh = controller({ fetch, now: c.now, timeoutMs: 30 });
    await gh.list();
    down = true;
    c.advance(300);
    const devices = await gh.list();
    expect(devices[0]).toMatchObject({ reachable: false, state: null, run: null });
    expect(devices[0]!.attention[0]).toBe("The greenhouse controller isn't answering. If it loses its connection, it switches itself off.");
    expect(devices[1]!.readings[0]!.fault).toBe("last read 5 minutes ago");
    const err = await gh.set("greenhouse.valve1", { state: "on", seconds: 30 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/can't tell whether the Greenhouse misters started.*closes on its own/);
  });

  it("says when something other than the controller answers at its address", async () => {
    const c = clock();
    const gh = controller({ fetch: (async () => new Response("<html>router login</html>", { status: 200 })) as unknown as typeof fetch, now: c.now });
    const [valve] = await gh.list();
    expect(valve).toMatchObject({ reachable: false });
    expect(valve!.attention[0]).toMatch(/not the way the controller does/);
  });

  it("goes through the device hub with the hub's own limits first", async () => {
    const c = clock();
    const fake = fakeController(c.now);
    const hub = new DeviceHub([controller({ fetch: fake.fetch, now: c.now })]);
    await expect(hub.set({ device: "misters", state: "on", minutes: 20 })).rejects.toThrow("The Greenhouse misters runs at most 10 minutes at a time. Offer 10 minutes or less.");
    expect(fake.calls.some((x) => x.method === "POST")).toBe(false);
    const answer = await hub.set({ device: "the greenhouse misters", state: "on", seconds: 30 });
    expect(answer).toMatchObject({ status: "done", summary: "Greenhouse misters on for 30 seconds, until 10:30 AM", device: { live: true, run: "30 seconds left, until 10:30 AM" } });
  });
});

describe("the firmware's facts", () => {
  it("reads a probe's millivolts for wiring faults the way the bench tests found them", () => {
    expect(probeFault(6)).toMatch(/wiring fault/);
    expect(probeFault(300)).toBe("no probe connected");
    expect(probeFault(700)).toMatch(/out of a working probe's range/);
    expect(probeFault(1850)).toBeUndefined();
  });

  it("takes an address however it's written", () => {
    expect(controllerBase("192.0.2.72")).toBe("http://192.0.2.72");
    expect(controllerBase("greenhouse.local/")).toBe("http://greenhouse.local");
    expect(controllerBase("http://10.0.0.5:8080")).toBe("http://10.0.0.5:8080");
  });
});

describe("keeping the real greenhouse local", () => {
  const env = { GREENHOUSE_LAN: "true", GREENHOUSE_URL: "http://192.0.2.72", GREENHOUSE_KEY: KEY };

  it("uses the real controller only under dev:lan, with both values, served from this machine or the LAN", () => {
    expect(localGreenhouse(env, "http://localhost:8795/mcp")).toEqual({ url: "http://192.0.2.72", key: KEY });
    expect(localGreenhouse(env, "http://127.0.0.1:8802/mcp")).not.toBeNull();
    expect(localGreenhouse(env, "http://192.168.1.20:8795/mcp")).not.toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_MAX_RUN_S: "45" }, "http://localhost/mcp")).toMatchObject({ maxRunS: 45 });
  });

  it("from a tunnel to this machine only when that host is named, and still only under dev:lan", () => {
    const tunnel = "https://example-tunnel.trycloudflare.com/mcp";
    expect(localGreenhouse(env, tunnel)).toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_HOSTS: "Example-Tunnel.trycloudflare.com, other.example" }, tunnel)).not.toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_HOSTS: "other.example" }, tunnel)).toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_LAN: undefined, GREENHOUSE_HOSTS: "example-tunnel.trycloudflare.com" }, tunnel)).toBeNull();
  });

  it("never from a deployed address, without dev:lan, or with a value missing", () => {
    expect(localGreenhouse(env, "https://alexa-demo.corral.narralogy.ai/mcp")).toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_LAN: undefined }, "http://localhost:8795/mcp")).toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_KEY: " " }, "http://localhost:8795/mcp")).toBeNull();
    expect(localGreenhouse({ ...env, GREENHOUSE_URL: undefined }, "http://localhost:8795/mcp")).toBeNull();
  });

  it("knows a local host from a public one", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "app.localhost", "10.1.2.3", "172.20.0.1", "192.168.1.9"]) expect(isLocalHost(h), h).toBe(true);
    for (const h of ["alexa.corral.narralogy.ai", "8.8.8.8", "172.32.0.1", "192.169.0.1", "localhost.example.com"]) expect(isLocalHost(h), h).toBe(false);
  });
});
