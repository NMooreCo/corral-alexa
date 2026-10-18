import { Temporal } from "temporal-polyfill";
import type { Units } from "./types.ts";

/** Numbers and times the way the ranch tools say them. */

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "30 seconds", "5 minutes", "1 minute 30 seconds", "2 hours", "1 hour 15 minutes". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return plural(s, "second");
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${plural(m, "minute")} ${plural(rest, "second")}` : plural(m, "minute");
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${plural(h, "hour")} ${plural(m, "minute")}` : plural(h, "hour");
}

/** "6:42 PM" in the household's time zone. */
export function clockAt(at: Temporal.Instant, timeZone: string): string {
  return at.toZonedDateTimeISO(timeZone).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}

/** "just now", "4 minutes ago", "2 hours ago". */
export function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 45) return "just now";
  if (s < 3600) return `${plural(Math.max(1, Math.round(s / 60)), "minute")} ago`;
  if (s < 86_400) return `${plural(Math.round(s / 3600), "hour")} ago`;
  return `${plural(Math.round(s / 86_400), "day")} ago`;
}

export const tempUnit = (units: Units) => (units === "us" ? "°F" : "°C");

/** Celsius in the household's units, rounded to whole degrees. */
export function fromCelsius(c: number, units: Units): number {
  return Math.round(units === "us" ? (c * 9) / 5 + 32 : c);
}

/** "38°F". */
export function degrees(value: number, units: Units): string {
  return `${Math.round(value)}${tempUnit(units)}`;
}

/** A number with thousands separators and at most one decimal. */
export function num(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** A reading's words, like "18%", "38°F" or "852.5 hPa". */
export function readingText(value: number | null, unit: string): string {
  if (value === null) return "No reading";
  return unit === "%" || unit.startsWith("°") ? `${num(value)}${unit}` : `${num(value)} ${unit}`;
}
