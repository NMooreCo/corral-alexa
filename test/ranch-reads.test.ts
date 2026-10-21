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

/** How long the controller takes to give up on a request, and how long the forecast takes to answer. */
const CONTROLLER_MS = 300;
const FORECAST_MS = 250;

// Friday, October 16, 2026, in Denver.
const at = (time: string) => Temporal.ZonedDateTime.from(`2026-10-16T${time}:00-06:00[America/Denver]`).toInstant();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The sample ranch's configuration with a controller that's slow (it answers after CONTROLLER_MS) or gone
 * (it never answers, so each request gives up at CONTROLLER_MS), and a forecast that answers after FORECAST_MS.
 * `events` says when each was asked and when each finished, in order.
 */
function slowRanch(start: string, controller: "slow" | "gone", lows = [40, 40, 40, 40, 40]) {
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
    timeoutMs: CONTROLLER_MS,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked++;
      events.push("controller asked");
      if (controller === "slow") {
        await sleep(CONTROLLER_MS - 50);
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
      await sleep(FORECAST_MS);
      events.push("forecast answered");
      return forecast.fetch(input, init);
    }) as typeof fetch,
  });
  return { ranch, events, asked: () => asked, move: (time: string) => (now = at(time)) };
}

/** How long `run` takes, in milliseconds, with what it answered. */
async function timed<T>(run: () => Promise<T>): Promise<{ took: number; answer: T }> {
  const started = performance.now();
  const answer = await run();
  return { took: performance.now() - started, answer };
}

beforeEach(() => {
  clearWeatherCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("reading the ranch from slow sources", () => {
  it("puts the Ranch screen up after the slower of a gone controller and a slow forecast, not both, asking the controller once", async () => {
    const { ranch, events, asked } = slowRanch("21:00", "gone");
    await ranch.tick(); // the first look only starts the clock; the next checks the horse tank's reading
    const { took, answer: view } = await timed(() => ranchView(ranch, new SampleHousehold()));
    // The automations' check of a reading, the devices and the automations all waited on the one request.
    expect(asked()).toBe(1);
    // The forecast was on its way before the controller gave up.
    expect(events.indexOf("forecast asked")).toBeLessThan(events.indexOf("controller gave up"));
    expect(took).toBeLessThan(CONTROLLER_MS + FORECAST_MS);
    // And the screen says what it always said.
    expect(view.places[0]!.devices[0]).toMatchObject({ name: "Greenhouse misters", reachable: false, state: null });
    expect(view.places[0]!.devices[0]!.attention[0]).toBe("The greenhouse controller isn't answering. If it loses its connection, it switches itself off.");
    expect(view.weather).toMatchObject({ tonight: expect.stringMatching(/^Low \d+°F tonight$/) });
    expect(view.automations).toHaveLength(4);
  });

  it("answers the assistant's weather without waiting first for the automations' read of the controller", async () => {
    const { ranch, events } = slowRanch("21:00", "gone");
    await ranch.tick();
    const call = async (name: string) => {
      const res = await serveMcp(
        new Request("https://bridge.example/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
        }),
        new SampleHousehold(),
        ranch,
      );
      const text = await res.text();
      // Answered as JSON or as a one-message event stream.
      const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5) : text;
      return (JSON.parse(data) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    };
    const { took, answer } = await timed(() => call("weather"));
    expect(answer.isError).toBeFalsy();
    expect(JSON.parse(answer.content[0]!.text)).toMatchObject({ place: "Juniper Hollow", source: "Open-Meteo" });
    expect(events.indexOf("forecast asked")).toBeLessThan(events.indexOf("controller gave up"));
    expect(took).toBeLessThan(CONTROLLER_MS + FORECAST_MS);
  });

  it("checks every automation's trigger at once: tonight's forecast and a device's reading together", async () => {
    const { ranch, events, move } = slowRanch("16:58", "slow", [12, 12, 12, 12, 12]);
    await ranch.automations.set("Freeze protection", true);
    await ranch.tick();
    move("17:01");
    events.length = 0;
    await ranch.tick();
    // Both were asked before either answered.
    expect(events.slice(0, 2).sort()).toEqual(["controller asked", "forecast asked"]);
    // It ran just as it would have, one rule after another.
    expect((await ranch.automations.list()).find((a) => a.name === "Freeze protection")!.lastRun).toMatchObject({ at: "Today at 5:01 PM", failed: [] });
    for (const name of ["Horse tank heater", "Barn heater"]) expect((await ranch.devices.all()).find((d) => d.name === name)!.state).toBe("on");
  });

  it("starts the morning briefing's history with the rest, not after", async () => {
    const { ranch, events } = slowRanch("07:30", "gone");
    const household: Household = {
      about: async () => ({ name: "Juniper Hollow", timeZone: "America/Denver" }),
      call: async () => [],
      history: async () => {
        events.push("history asked");
        await sleep(FORECAST_MS);
        events.push("history answered");
        return [{ at: "2026-10-16T06:15:00-06:00[America/Denver]", who: "Nick", text: "Nick fed the horses" }];
      },
    };
    const { took, answer: briefing } = await timed(() => briefingView(household, ranch));
    expect(events.indexOf("history asked")).toBeLessThan(events.indexOf("controller gave up"));
    expect(took).toBeLessThan(CONTROLLER_MS + FORECAST_MS);
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
