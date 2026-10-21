import { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import type { RanchLocation, Units } from "./types.ts";
import { ago, clockAt, num } from "./words.ts";
import { now as clockNow } from "../clock.ts";

/**
 * The forecast for a household's own location, from Open-Meteo (free, no
 * key). The location and units are the household's configuration; this asks
 * for them, caches the answer briefly, and says it in words: today, tonight's
 * low with a plain freeze flag, the next few days, wind and precipitation.
 */

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const FRESH_MS = 10 * 60 * 1000;
/** When Open-Meteo can't be reached, an answer this old still beats none (and says how old it is). */
const USABLE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

const cache = new Map<string, { at: number; data: OpenMeteo }>();

/** Forgets every cached forecast (for tests). */
export function clearWeatherCache() {
  cache.clear();
}

interface OpenMeteo {
  current?: { time: string; temperature_2m?: number; apparent_temperature?: number; relative_humidity_2m?: number; wind_speed_10m?: number; wind_gusts_10m?: number; weather_code?: number };
  hourly?: { time: string[]; temperature_2m: (number | null)[] };
  daily?: {
    time: string[];
    weather_code: (number | null)[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    precipitation_probability_max: (number | null)[];
    precipitation_sum: (number | null)[];
    snowfall_sum: (number | null)[];
    wind_speed_10m_max: (number | null)[];
    wind_gusts_10m_max: (number | null)[];
  };
  error?: boolean;
  reason?: string;
}

/** WMO weather codes, as Open-Meteo reports them, in words. */
export function conditions(code: number | null | undefined): string {
  if (code === null || code === undefined) return "Unknown";
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 55) return "Drizzle";
  if (code === 56 || code === 57) return "Freezing drizzle";
  if (code === 61) return "Light rain";
  if (code === 63) return "Rain";
  if (code === 65) return "Heavy rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code === 71) return "Light snow";
  if (code === 73) return "Snow";
  if (code === 75) return "Heavy snow";
  if (code === 77) return "Snow grains";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorms";
  if (code === 96 || code === 99) return "Thunderstorms with hail";
  return "Mixed";
}

const UNITS = {
  us: { temperature: "fahrenheit", wind: "mph", precipitation: "inch", t: "°F", w: "mph", p: "in", snow: "in", freeze: 32, hard: 28 },
  metric: { temperature: "celsius", wind: "kmh", precipitation: "mm", t: "°C", w: "km/h", p: "mm", snow: "cm", freeze: 0, hard: -2 },
} as const;

export interface DayForecast {
  date: string;
  label: string;
  high: string;
  low: string;
  highValue: number | null;
  lowValue: number | null;
  conditions: string;
  precipitation: string;
  snow?: string;
  wind: string;
  freeze: boolean;
}

export interface Forecast {
  place: string;
  elevation: string;
  now: { temperature: string; temperatureValue: number | null; feelsLike: string; conditions: string; wind: string; humidity: string } | null;
  today: DayForecast;
  tonight: { low: string; lowValue: number | null; lowestAround: string | null; freeze: boolean; hardFreeze: boolean };
  days: DayForecast[];
  /** The next day with a freezing low, when one's coming. */
  nextFreeze: string | null;
  updated: string;
  source: "Open-Meteo";
  /** When the forecast couldn't be refreshed and this is an older one. */
  stale?: string;
}

export interface WeatherOptions {
  location: RanchLocation;
  timeZone: string;
  units: Units;
  fetch?: typeof fetch;
  now?: () => Temporal.Instant;
}

export function forecastUrl(o: Pick<WeatherOptions, "location" | "timeZone" | "units">): string {
  const u = UNITS[o.units];
  const q = new URLSearchParams({
    latitude: o.location.latitude.toFixed(4),
    longitude: o.location.longitude.toFixed(4),
    elevation: String(Math.round(o.location.elevationM)),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code",
    hourly: "temperature_2m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max",
    temperature_unit: u.temperature,
    wind_speed_unit: u.wind,
    precipitation_unit: u.precipitation,
    timezone: o.timeZone,
    forecast_days: "5",
  });
  return `${OPEN_METEO}?${q}`;
}

/** The forecast for the household's location, at most ten minutes old when Open-Meteo answers. */
export async function forecast(o: WeatherOptions): Promise<Forecast> {
  const now = (o.now ?? clockNow)();
  const url = forecastUrl(o);
  const kept = cache.get(url);
  if (kept && Date.now() - kept.at < FRESH_MS) return summarize(kept.data, o, now, kept.at, false);
  try {
    const init: RequestInit & { cf: { cacheTtl: number; cacheEverything: boolean } } = {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Cloudflare's edge keeps the answer for as long as it's fresh, so a cold isolate needn't wait on Open-Meteo (Alexa+ wants answers in under 500 ms).
      cf: { cacheTtl: FRESH_MS / 1000, cacheEverything: true },
    };
    const res = await (o.fetch ?? ((i, init) => fetch(i, init)))(url, init);
    const data = (await res.json()) as OpenMeteo;
    if (!res.ok || data.error || !data.daily?.time?.length) throw new Error(data.reason ?? `HTTP ${res.status}`);
    cache.set(url, { at: Date.now(), data });
    return summarize(data, o, now, Date.now(), false);
  } catch (err) {
    console.warn(`weather: Open-Meteo didn't answer (${err instanceof Error ? err.message : err})`);
    if (kept && Date.now() - kept.at < USABLE_MS) return summarize(kept.data, o, now, kept.at, true);
    throw new ToolError("The forecast isn't reachable right now. Try again in a few minutes.");
  }
}

function summarize(data: OpenMeteo, o: WeatherOptions, now: Temporal.Instant, fetchedAt: number, stale: boolean): Forecast {
  const u = UNITS[o.units];
  const tz = o.timeZone;
  const deg = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)}${u.t}` : "Unknown");
  const local = now.toZonedDateTimeISO(tz);
  const today = local.toPlainDate();
  const d = data.daily!;

  const day = (i: number): DayForecast => {
    const date = Temporal.PlainDate.from(d.time[i]!);
    const low = d.temperature_2m_min[i] ?? null;
    const precip = d.precipitation_sum[i] ?? 0;
    const chance = d.precipitation_probability_max[i];
    const snow = d.snowfall_sum[i] ?? 0;
    const gust = d.wind_gusts_10m_max[i];
    return {
      date: date.toString(),
      label: date.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" }),
      high: deg(d.temperature_2m_max[i]),
      low: deg(low),
      highValue: d.temperature_2m_max[i] ?? null,
      lowValue: low,
      conditions: conditions(d.weather_code[i]),
      precipitation: `${typeof chance === "number" ? `${Math.round(chance)}% chance` : "Chance unknown"}${precip > 0 ? `, ${num(precip)} ${u.p}` : ""}`,
      ...(snow > 0 ? { snow: `${num(snow)} ${u.snow}` } : {}),
      wind: `Up to ${Math.round(d.wind_speed_10m_max[i] ?? 0)} ${u.w}${typeof gust === "number" ? `, gusts to ${Math.round(gust)}` : ""}`,
      freeze: typeof low === "number" && low <= u.freeze,
    };
  };

  const todayIndex = Math.max(0, d.time.indexOf(today.toString()));
  const days = d.time.map((_, i) => day(i));
  const todays = days[todayIndex]!;

  // Tonight: before 10 in the morning it's the rest of this night; after, it's from evening (or now) until tomorrow mid-morning.
  const at = (date: Temporal.PlainDate, hour: number) => date.toZonedDateTime({ timeZone: tz, plainTime: new Temporal.PlainTime(hour) }).toInstant();
  const [from, to] = local.hour < 10 ? [now, at(today, 10)] : [Temporal.Instant.compare(now, at(today, 18)) > 0 ? now : at(today, 18), at(today.add({ days: 1 }), 10)];
  let lowest: { value: number; at: Temporal.Instant } | null = null;
  const h = data.hourly;
  if (h) {
    for (let i = 0; i < h.time.length; i++) {
      const v = h.temperature_2m[i];
      if (typeof v !== "number") continue;
      const t = Temporal.PlainDateTime.from(h.time[i]!).toZonedDateTime(tz).toInstant();
      if (Temporal.Instant.compare(t, from) < 0 || Temporal.Instant.compare(t, to) > 0) continue;
      if (!lowest || v < lowest.value) lowest = { value: v, at: t };
    }
  }
  const tonightLow = lowest?.value ?? (local.hour < 10 ? todays.lowValue : (days[todayIndex + 1]?.lowValue ?? todays.lowValue));

  const c = data.current;
  const nextFreeze = days.slice(todayIndex + 1).find((x) => x.freeze)?.label ?? null;
  return {
    place: o.location.name,
    elevation: o.units === "us" ? `about ${num(Math.round((o.location.elevationM * 3.28084) / 100) * 100)} ft` : `about ${num(Math.round(o.location.elevationM / 10) * 10)} m`,
    now: c
      ? {
          temperature: deg(c.temperature_2m),
          temperatureValue: c.temperature_2m ?? null,
          feelsLike: deg(c.apparent_temperature),
          conditions: conditions(c.weather_code),
          wind: `${Math.round(c.wind_speed_10m ?? 0)} ${u.w}${typeof c.wind_gusts_10m === "number" ? `, gusts to ${Math.round(c.wind_gusts_10m)}` : ""}`,
          humidity: typeof c.relative_humidity_2m === "number" ? `${Math.round(c.relative_humidity_2m)}%` : "Unknown",
        }
      : null,
    today: todays,
    tonight: {
      low: deg(tonightLow),
      lowValue: tonightLow,
      lowestAround: lowest ? clockAt(lowest.at, tz).replace(":00", "") : null,
      freeze: typeof tonightLow === "number" && tonightLow <= u.freeze,
      hardFreeze: typeof tonightLow === "number" && tonightLow <= u.hard,
    },
    days: days.slice(todayIndex + 1, todayIndex + 5),
    nextFreeze,
    updated: clockAt(Temporal.Instant.fromEpochMilliseconds(fetchedAt), tz),
    source: "Open-Meteo",
    ...(stale ? { stale: `Couldn't refresh the forecast; this one is from ${ago((Date.now() - fetchedAt) / 1000)}.` } : {}),
  };
}
