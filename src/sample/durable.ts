import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { serveMcp } from "../http.ts";
import { SampleRanchHolder } from "./ranch.ts";
import { SPEAKER_HEADER, speakerOf } from "./roles.ts";
import { SharedSample, type SampleStatus } from "./shared.ts";
import { sqlStore } from "./store.ts";
import { HouseholdClock, shiftClock } from "../clock.ts";

/** What a household's clock is set to: the real time, or another hour for a demo (`evening` is any other hour; `morning`, a morning one). */
export interface SampleClock {
  now: string;
  offsetMinutes: number;
  evening: boolean;
  morning: boolean;
}

/** The evening a demo is set to: after the sample's dogs wander off, before bedtime. */
export const EVENING = "20:15";
/** The next morning a demo moves on to: before the school run and the first chores. */
export const MORNING = "06:45";

/** How a visitor can set a sample household's clock. */
export type ClockMode = "evening" | "morning" | "now";
export const CLOCK_MODES: readonly ClockMode[] = ["evening", "morning", "now"];

/** A clock in words for /household. */
export function clockStatus(clock: HouseholdClock, timeZone?: string): SampleClock {
  const shifted = clock.offsetMinutes !== 0;
  const hour = timeZone ? clock.now().toZonedDateTimeISO(timeZone).hour : 12;
  return { now: clock.now().toString(), offsetMinutes: clock.offsetMinutes, evening: shifted, morning: shifted && hour < 12 };
}

/**
 * Sets a sample household's clock. Evening, or back to the real time, starts
 * the household over at that hour; morning moves it on to the next morning
 * and keeps the night before (the heaters left on, what was ordered), so a
 * demo can show the morning after.
 */
export function setSampleClock(mode: ClockMode, sample: { household: SharedSample; ranch: SampleRanchHolder; clock: HouseholdClock }, timeZone: string): void {
  if (mode === "morning") {
    sample.clock.set(HouseholdClock.offsetToNext(MORNING, timeZone, sample.clock.now()));
    sample.household.advanceDay();
    return;
  }
  sample.clock.set(mode === "evening" ? HouseholdClock.offsetTo(EVENING, timeZone) : 0);
  sample.ranch.reset();
  sample.household.reset();
}

/**
 * One sample household as a Durable Object (sample mode only). The Worker
 * sends every /mcp request for a household here, so two Echo Shows, or
 * Alexa+ and the simulator, see the same chore checked off, and the
 * object's SQLite storage keeps the household through restarts and deploys.
 * MCP is still served statelessly, one request at a time, from inside the
 * object.
 */
export class SampleHouseholdObject extends DurableObject<Env> {
  readonly #household: SharedSample;
  /** The household's ranch, in memory: both Echo Shows reach this one object, so they see the same runs. */
  readonly #ranch = new SampleRanchHolder();
  /** The household's own clock, kept in storage so a visitor's "evening" lasts through restarts. */
  readonly #clock = new HouseholdClock();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    shiftClock(env.CLOCK_SHIFT_MINUTES);
    // Making the table is synchronous, so it's done before any request reaches the object.
    this.#household = new SharedSample(sqlStore(ctx.storage.sql), { now: this.#clock.now });
    // The clock's offset sits beside the household in the same SQLite storage, read before any request.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK (id = 1), offset_minutes INTEGER NOT NULL)");
    const [row] = ctx.storage.sql.exec<{ offset_minutes: number }>("SELECT offset_minutes FROM clock WHERE id = 1").toArray();
    this.#clock.set(row?.offset_minutes ?? 0);
  }

  /** An MCP request (either protocol era), answered from this household. */
  async fetch(request: Request): Promise<Response> {
    const { timeZone } = await this.#household.about();
    const ranch = this.#ranch.ranchFor(this.env, request.url, timeZone, this.#clock.now);
    return serveMcp(request, this.#household.as(speakerOf(request.headers.get(SPEAKER_HEADER))), ranch);
  }

  async status(): Promise<SampleStatus & { clock: SampleClock }> {
    const { timeZone } = await this.#household.about();
    return { ...this.#household.status(), clock: clockStatus(this.#clock, timeZone) };
  }

  /** Sets the household's clock (see setSampleClock), and keeps it. */
  async setClock(mode: ClockMode): Promise<SampleStatus & { clock: SampleClock }> {
    const { timeZone } = await this.#household.about();
    setSampleClock(mode, { household: this.#household, ranch: this.#ranch, clock: this.#clock }, timeZone ?? "UTC");
    this.ctx.storage.sql.exec("INSERT INTO clock (id, offset_minutes) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET offset_minutes = excluded.offset_minutes", this.#clock.offsetMinutes);
    return this.status();
  }

  /** Starts the household over, for a fresh demo take. */
  async reset(): Promise<SampleStatus> {
    this.#ranch.reset();
    return this.#household.reset();
  }
}
