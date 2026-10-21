import { Temporal } from "temporal-polyfill";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serveMcp } from "../src/http.ts";
import type { Household } from "../src/household.ts";
import { GreenhouseController } from "../src/ranch/greenhouse.ts";
import { Ranch } from "../src/ranch/index.ts";
import { briefingView, ranchView } from "../src/ranch/views.ts";
import { clearWeatherCache } from "../src/ranch/weather.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { SAMPLE_GREENHOUSE, SampleCollars, SampleDevices, sampleRanch, sampleRanchConfig, simulatedController } from "../src/sample/ranch.ts";
import { openMeteo, openMeteoFetch } from "./ranch-fixtures.ts";

/**
 * The ranch's reads wait on their sources together, not one after another:
 * a greenhouse controller on weak Wi-Fi and a forecast that takes its time
 * cost a screen or a tool the slower of the two, never both, and never the
 * controller twice (once for the automations' check and again for the read).
 */

// Friday, October 16, 2026, in Denver.
const at = (time: string) => Temporal.ZonedDateTime.from(`2026-10-16T${time}:00-06:00[America/Denver]`).toInstant();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The sample ranch's configuration with a controller that's slow (it answers after `controllerMs`) or gone
 * (it never answers, so each request gives up at `controllerMs`), and a forecast that answers after `forecastMs`.
 * `events` says when each was asked and when each finished, in order.
 */
function slowRanch(start: string, controller: "slow" | "gone", opts: { controllerMs?: number; forecastMs?: number; lows?: number[] } = {}) {
  const { controllerMs = 300, forecastMs = 250, lows = [40, 40, 40, 40, 40] } = opts;
  let now = at(start);
  const clock = () => now;
  const config = sampleRanchConfig();
  const events: string[] = [];
  let asked = 0;
  const sim = simulatedController({ now: clock, timeZone: config.timeZone, key: "test-key-not-real" });
  const greenhouse = new GreenhouseController({
    url: "192.0.2.72",
    key: "test-key-not-real",
    config: SAMPLE_GREENHOUSE,
    units: config.units,
    timeZone: config.timeZone,
    live: true,
    now: clock,
    timeoutMs: controllerMs,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked++;
      events.push("controller asked");
      if (controller === "slow") {
        await sleep(controllerMs - 50);
        events.push("controller answered");
        return sim(input, init);
      }
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => {
          events.push("controller gave up");
          reject(new DOMException("timed out", "TimeoutError"));
        }),
      );
    }) as typeof fetch,
  });
  const forecast = openMeteoFetch(openMeteo("2026-10-16", { lows }));
  const ranch = new Ranch({
    config,
    sources: [greenhouse, new SampleDevices({ now: clock, timeZone: config.timeZone, units: config.units })],
    trackers: new SampleCollars({ now: clock, timeZone: config.timeZone }),
    now: clock,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      events.push("forecast asked");
      await sleep(forecastMs);
      events.push("forecast answered");
      return forecast.fetch(input, init);
    }) as typeof fetch,
  });
  return { ranch, events, asked: () => asked, move: (time: string) => (now = at(time)) };
}

/** Every one of `sources` was asked before any of them finished: they were waited on together. */
function askedTogether(events: string[], ...sources: string[]) {
  expect(events.slice(0, sources.length).sort()).toEqual(sources.map((s) => `${s} asked`).sort());
}

beforeEach(() => {
  clearWeatherCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reading the ranch from slow sources", () => {
  it("puts the Ranch screen up waiting on a gone controller and a slow forecast together, asking the controller once", async () => {
    const { ranch, events, asked } = slowRanch("21:00", "gone");
    await ranch.tick(); // the first look only starts the clock; the next checks the horse tank's reading
    const view = await ranchView(ranch, new SampleHousehold());
    askedTogether(events, "controller", "forecast");
    // The automations' check of a reading, the devices and the automations all waited on the one request.
    expect(asked()).toBe(1);
    // And the screen says what it always said.
    expect(view.places[0]!.devices[0]).toMatchObject({ name: "Greenhouse misters", reachable: false, state: null });
    expect(view.places[0]!.devices[0]!.attention[0]).toBe("The greenhouse controller isn't answering. If it loses its connection, it switches itself off.");
    expect(view.weather).toMatchObject({ tonight: expect.stringMatching(/^Low \d+°F tonight$/) });
    expect(view.automations).toHaveLength(4);
  });

  it("so the screen takes about the slower source's wait, not the two added up", async () => {
    // Long enough that a busy machine's own slowness can't make up the difference.
    const controllerMs = 1000;
    const forecastMs = 900;
    const { ranch } = slowRanch("21:00", "gone", { controllerMs, forecastMs });
    await ranch.tick();
    const started = performance.now();
    await ranchView(ranch, new SampleHousehold());
    const took = performance.now() - started;
    // One after another, it was the controller for the automations' check, then the controller again beside the forecast: 2,000 ms.
    expect(took).toBeGreaterThanOrEqual(controllerMs - 20);
    expect(took).toBeLessThan(controllerMs + forecastMs);
  });

  it("answers the assistant's weather without waiting first for the automations' read of the controller", async () => {
    const { ranch, events } = slowRanch("21:00", "gone");
    await ranch.tick();
    const res = await serveMcp(
      new Request("https://bridge.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "weather", arguments: {} } }),
      }),
      new SampleHousehold(),
      ranch,
    );
    const text = await res.text();
    // Answered as JSON or as a one-message event stream.
    const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5) : text;
    const answer = (JSON.parse(data) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    expect(answer.isError).toBeFalsy();
    expect(JSON.parse(answer.content[0]!.text)).toMatchObject({ place: "Juniper Hollow", source: "Open-Meteo" });
    askedTogether(events, "controller", "forecast");
  });

  it("checks every automation's trigger at once: tonight's forecast and a device's reading together", async () => {
    const { ranch, events, move } = slowRanch("16:58", "slow", { lows: [12, 12, 12, 12, 12] });
    await ranch.automations.set("Freeze protection", true);
    await ranch.tick();
    move("17:01");
    events.length = 0;
    await ranch.tick();
    askedTogether(events, "controller", "forecast");
    // It ran just as it would have, one rule after another.
    expect((await ranch.automations.list()).find((a) => a.name === "Freeze protection")!.lastRun).toMatchObject({ at: "Today at 5:01 PM", failed: [] });
    for (const name of ["Horse tank heater", "Barn heater"]) expect((await ranch.devices.all()).find((d) => d.name === name)!.state).toBe("on");
  });

  it("asks for the morning briefing's history with the rest, not after", async () => {
    const { ranch, events } = slowRanch("07:30", "gone");
    const household: Household = {
      about: async () => ({ name: "Juniper Hollow", timeZone: "America/Denver" }),
      call: async () => [],
      history: async () => {
        events.push("history asked");
        await sleep(250);
        events.push("history answered");
        return [{ at: "2026-10-16T06:15:00-06:00[America/Denver]", who: "Nick", text: "Nick fed the horses" }];
      },
    };
    const briefing = await briefingView(household, ranch);
    askedTogether(events, "controller", "forecast", "history");
    expect(briefing.cards[0]).toMatchObject({ id: "overnight", lines: [{ text: expect.stringMatching(/^6:15\sAM: Nick fed the horses$/) }] });
  });
});

describe("a look at the ranch", () => {
  /** The sample ranch, fast, on a clock the test moves. */
  function sample(start: string) {
    let now = at(start);
    const ranch = sampleRanch({ now: () => now, fetch: openMeteoFetch(openMeteo("2026-10-16")).fetch });
    return { ranch, move: (time: string) => (now = at(time)) };
  }

  it("reads once while nothing comes due", async () => {
    const { ranch } = sample("21:00");
    let reads = 0;
    await ranch.look(async () => ++reads);
    await ranch.look(async () => ++reads);
    expect(reads).toBe(2);
  });

  it("reads again when an automation ran meanwhile, so the answer shows what it did", async () => {
    const { ranch, move } = sample("06:58");
    await ranch.tick();
    move("07:01");
    let reads = 0;
    const devices = await ranch.look(async () => {
      reads++;
      return ranch.devices.all();
    });
    expect(reads).toBe(2);
    expect(devices.find((d) => d.name === "Greenhouse misters")).toMatchObject({ state: "on", run: { secondsLeft: 120 } });
  });

  it("passes on what the read refuses, as it would have after the tick", async () => {
    const { ranch } = sample("21:00");
    await expect(ranch.look(() => ranch.devices.list({ place: "Moon" }))).rejects.toThrow(/There are no devices at "Moon"/);
  });
});
