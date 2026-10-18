import { Temporal } from "temporal-polyfill";

/**
 * The time, as the server asks for it. Local development can shift it with
 * CLOCK_SHIFT_MINUTES, to record a demo at another hour (evening, when the
 * sample's dogs wander off) without waiting for it. Nothing deployed sets it.
 */
let shiftMs = 0;

/** Shifts the clock by this many minutes; none, zero or nonsense puts it back. */
export function shiftClock(minutes: string | number | undefined): void {
  const n = Number(minutes ?? 0);
  shiftMs = Number.isFinite(n) ? Math.round(n * 60_000) : 0;
}

/** Now, shifted if local development asked for it. */
export function now(): Temporal.Instant {
  const real = Temporal.Now.instant();
  return shiftMs ? real.add({ milliseconds: shiftMs }) : real;
}

/** Today's date in a time zone, by the same clock. */
export function todayIn(zone: string): Temporal.PlainDate {
  return now().toZonedDateTimeISO(zone).toPlainDate();
}
