import { Temporal } from "temporal-polyfill";

/**
 * An Open-Meteo forecast answer shaped like the real one (local times with no
 * offset, a units block, "mp/h" for miles per hour), for five days from
 * `start`. Overnight lows follow `lows` (Fahrenheit), one per night.
 */
export function openMeteo(start: string, opts: { lows?: number[]; highs?: number[]; snow?: number[]; codes?: number[] } = {}) {
  const lows = opts.lows ?? [40, 28, 18, 35, 41];
  const highs = opts.highs ?? [62, 50, 38, 55, 60];
  const days = Array.from({ length: 5 }, (_, i) => Temporal.PlainDate.from(start).add({ days: i }).toString());
  const time: string[] = [];
  const temperature_2m: number[] = [];
  days.forEach((d, i) => {
    for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      // Each day is coldest at 6 AM (its daily low) and warmest mid-afternoon, then cools toward the next dawn.
      const low = lows[i]!;
      const next = lows[i + 1] ?? low;
      const t = h <= 6 ? low + (6 - h) * 0.8 : h <= 15 ? low + ((highs[i]! - low) * (h - 6)) / 9 : highs[i]! - ((highs[i]! - (next + 4.8)) * (h - 15)) / 9;
      temperature_2m.push(Math.round(t * 10) / 10);
    }
  });
  return {
    latitude: 43.435387,
    longitude: -105.214645,
    generationtime_ms: 1.2,
    utc_offset_seconds: -21600,
    timezone: "America/Denver",
    timezone_abbreviation: "GMT-6",
    elevation: 1469.0,
    current_units: { time: "iso8601", interval: "seconds", temperature_2m: "°F", wind_speed_10m: "mp/h" },
    current: { time: `${start}T10:30`, interval: 900, temperature_2m: 47.3, apparent_temperature: 41.0, relative_humidity_2m: 22, wind_speed_10m: 12.4, wind_gusts_10m: 25.1, weather_code: 3 },
    hourly_units: { time: "iso8601", temperature_2m: "°F" },
    hourly: { time, temperature_2m },
    daily_units: { time: "iso8601", temperature_2m_max: "°F", temperature_2m_min: "°F", precipitation_sum: "inch", snowfall_sum: "inch", wind_speed_10m_max: "mp/h" },
    daily: {
      time: days,
      weather_code: opts.codes ?? [3, 71, 73, 2, 0],
      temperature_2m_max: highs,
      temperature_2m_min: lows,
      precipitation_probability_max: [10, 60, 80, 5, 0],
      precipitation_sum: [0, 0.12, 0.3, 0, 0],
      snowfall_sum: opts.snow ?? [0, 1.2, 3.4, 0, 0],
      wind_speed_10m_max: [14.2, 18.9, 22.0, 9.1, 7.7],
      wind_gusts_10m_max: [28.0, 35.1, 41.3, 15.0, 12.2],
    },
  };
}

/** A fetch that answers Open-Meteo with `body` and records each URL asked. */
export function openMeteoFetch(body: unknown) {
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (!url.startsWith("https://api.open-meteo.com/")) throw new Error(`unexpected fetch to ${url}`);
    return Response.json(body);
  }) as typeof fetch;
  return { fetch: fn, urls };
}
