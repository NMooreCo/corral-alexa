import { Temporal } from "temporal-polyfill";

/**
 * Times in words, exactly as Corral's tools say them ("Fri, Oct 16, 3:30 PM",
 * "Sat, Oct 17"), so the sample reads like the real thing.
 */

/** An all-day value like "2026-10-16" rather than a zoned time. */
export function isAllDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function whenLabel(value: string): string {
  if (isAllDay(value)) return Temporal.PlainDate.from(value).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return Temporal.ZonedDateTime.from(value)
    .toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .replace(/ /g, " ");
}

/** Just the time of day, like "4:45 PM". */
export function clock(value: string): string {
  return Temporal.ZonedDateTime.from(value).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}

/** "1 bag", "46 bales", "2.5 lb". */
export function unitAmount(quantity: number, unit: string): string {
  const n = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(1).replace(/\.0$/, "");
  const many = quantity === 1 || unit.length <= 2 ? unit : `${unit}s`;
  return `${n} ${many}`;
}

/** Cents as dollars, like "$12.50". */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
