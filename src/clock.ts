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

/**
 * A household's own clock: the server's, plus an offset a simulator sets so
 * a demo can be seen at another hour (evening, when the sample's dogs wander
 * off) whenever someone visits. Everything about the household asks it.
 */
export class HouseholdClock {
  #offsetMs = 0;

  /** Now, for this household. */
  readonly now = (): Temporal.Instant => {
    const n = now();
    return this.#offsetMs ? n.add({ milliseconds: this.#offsetMs }) : n;
  };

  get offsetMinutes(): number {
    return Math.round(this.#offsetMs / 60_000);
  }

  set(minutes: number): void {
    this.#offsetMs = Number.isFinite(minutes) ? Math.round(minutes * 60_000) : 0;
  }

  /** The offset, in minutes, that makes it `time` ("20:15") today in `timeZone`. */
  static offsetTo(time: string, timeZone: string, at: Temporal.Instant = now()): number {
    const target = at.toZonedDateTimeISO(timeZone).toPlainDate().toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) }).toInstant();
    return Math.round(target.since(at).total("minutes"));
  }

  /** The offset, in minutes, that makes it the next `time` ("06:45") after `from` (a household's now) in `timeZone`: the next morning, say. */
  static offsetToNext(time: string, timeZone: string, from: Temporal.Instant, at: Temporal.Instant = now()): number {
    const local = from.toZonedDateTimeISO(timeZone);
    let target = local.toPlainDate().toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) });
    if (Temporal.ZonedDateTime.compare(target, local) <= 0) target = target.add({ days: 1 });
    return Math.round(target.toInstant().since(at).total("minutes"));
  }
}

/** Today's date in a time zone, by the same clock. */
export function todayIn(zone: string): Temporal.PlainDate {
  return now().toZonedDateTimeISO(zone).toPlainDate();
}
