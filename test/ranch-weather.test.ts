import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/household.ts";
import { clearWeatherCache, conditions, forecast, forecastUrl } from "../src/ranch/weather.ts";
import { sampleRanchConfig } from "../src/sample/ranch.ts";
import { openMeteo, openMeteoFetch } from "./ranch-fixtures.ts";

// Friday, October 16, 2026, 10:30 AM in Denver.
const MORNING = Temporal.Instant.from("2026-10-16T16:30:00Z");
const config = sampleRanchConfig();
const opts = (fetch: typeof globalThis.fetch, now = MORNING) => ({ location: config.location, timeZone: config.timeZone, units: config.units, fetch, now: () => now });

beforeEach(() => {
  clearWeatherCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the weather tool (Open-Meteo)", () => {
  it("asks for the household's own location, elevation, time zone and units", () => {
    const url = new URL(forecastUrl(config));
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ latitude: "43.4400", longitude: "-105.2100", elevation: "1469", timezone: "America/Denver", temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch", forecast_days: "5" });
  });

  it("says today, tonight's low with a freeze flag, wind, precipitation and the next days", async () => {
    const f = await forecast(opts(openMeteoFetch(openMeteo("2026-10-16")).fetch));
    expect(f).toMatchObject({ place: "Juniper Hollow", elevation: "about 4,800 ft", source: "Open-Meteo" });
    expect(f.now).toMatchObject({ temperature: "47°F", feelsLike: "41°F", conditions: "Cloudy", wind: "12 mph, gusts to 25", humidity: "22%" });
    expect(f.today).toMatchObject({ label: "Fri, Oct 16", high: "62°F", low: "40°F", conditions: "Cloudy", freeze: false });
    // Tonight runs from this evening to tomorrow mid-morning: the fixture bottoms out at 28 near dawn.
    expect(f.tonight).toMatchObject({ low: "28°F", lowValue: 28, lowestAround: "6 AM", freeze: true, hardFreeze: true });
    expect(f.days.map((d) => d.label)).toEqual(["Sat, Oct 17", "Sun, Oct 18", "Mon, Oct 19", "Tue, Oct 20"]);
    expect(f.days[1]).toMatchObject({ conditions: "Snow", low: "18°F", snow: "3.4 in", precipitation: "80% chance, 0.3 in", wind: "Up to 22 mph, gusts to 41", freeze: true });
    expect(f.nextFreeze).toBe("Sat, Oct 17");
  });

  it("before mid-morning, tonight is the rest of this night", async () => {
    const early = Temporal.Instant.from("2026-10-17T10:00:00Z"); // 4 AM Saturday
    const f = await forecast(opts(openMeteoFetch(openMeteo("2026-10-17", { lows: [12, 30, 30, 30, 30] })).fetch, early));
    expect(f.today.label).toBe("Sat, Oct 17");
    expect(f.tonight.lowValue).toBeLessThanOrEqual(14);
    expect(f.tonight.freeze).toBe(true);
  });

  it("caches a forecast for a few minutes", async () => {
    const stub = openMeteoFetch(openMeteo("2026-10-16"));
    await forecast(opts(stub.fetch));
    await forecast(opts(stub.fetch));
    expect(stub.urls).toHaveLength(1);
  });

  it("says plainly when Open-Meteo can't be reached and nothing's cached", async () => {
    const down = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(forecast(opts(down))).rejects.toThrow(new ToolError("The forecast isn't reachable right now. Try again in a few minutes."));
    const refusing = (async () => Response.json({ error: true, reason: "Latitude must be in range of -90 to 90°." }, { status: 400 })) as unknown as typeof fetch;
    await expect(forecast(opts(refusing))).rejects.toThrow(ToolError);
  });

  it("falls back to an older forecast, and says how old, when a refresh fails", async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    await forecast(opts(openMeteoFetch(openMeteo("2026-10-16")).fetch));
    clock.mockReturnValue(t0 + 40 * 60 * 1000);
    const f = await forecast(opts((async () => new Response("gateway timeout", { status: 504 })) as unknown as typeof fetch));
    expect(f.stale).toBe("Couldn't refresh the forecast; this one is from 40 minutes ago.");
    expect(f.tonight.low).toBe("28°F");
  });

  it("says metric to a metric household", async () => {
    const stub = openMeteoFetch(openMeteo("2026-10-16", { lows: [4, -3, -8, 1, 5], highs: [17, 10, 3, 12, 15] }));
    const f = await forecast({ ...opts(stub.fetch), units: "metric" });
    expect(new URL(stub.urls[0]!).searchParams.get("temperature_unit")).toBe("celsius");
    expect(f.tonight).toMatchObject({ low: "-3°C", freeze: true, hardFreeze: true });
    expect(f.elevation).toBe("about 1,470 m");
  });

  it("names the WMO weather codes", () => {
    expect([0, 2, 45, 63, 66, 75, 86, 95, 99].map(conditions)).toEqual(["Clear", "Partly cloudy", "Fog", "Rain", "Freezing rain", "Heavy snow", "Snow showers", "Thunderstorms", "Thunderstorms with hail"]);
  });
});
