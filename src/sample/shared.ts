import { Temporal } from "temporal-polyfill";
import type { Household, HouseholdAbout, HouseholdTool } from "../household.ts";
import { SampleHousehold } from "./index.ts";
import { seed, type SampleState } from "./seed.ts";
import type { KeptSample, SampleStore } from "./store.ts";

/** What a shared sample household says about itself: its name, its day and its change counter. */
export interface SampleStatus {
  name: string;
  day: string;
  version: number;
}

/**
 * One sample household shared by everyone who asks for it (two Echo Shows,
 * Alexa+ and the simulator, every request), kept in `store` so it outlasts
 * the process that serves it. It keeps a change counter that screens poll to
 * know when to refresh. Its times are laid out around today, so it starts
 * over when its day changes, and it can be started over on purpose.
 */
export class SharedSample implements Household {
  readonly #store: SampleStore;
  readonly #now: () => Temporal.Instant;
  readonly #timeZone: string | undefined;
  #household: SampleHousehold | null = null;
  #kept: KeptSample | null = null;

  constructor(store: SampleStore, opts: { now?: () => Temporal.Instant; timeZone?: string } = {}) {
    this.#store = store;
    this.#now = opts.now ?? (() => Temporal.Now.instant());
    this.#timeZone = opts.timeZone;
  }

  get name(): string {
    return this.#current().name;
  }

  /** A sample household decides its own requests, so a parent can approve a kid's. */
  readonly decidesRequests = true;

  about(): Promise<HouseholdAbout> {
    return this.#current().about();
  }

  /**
   * Any tool, then the household is kept again if it changed. Which tools
   * change things is the household's business, so this compares what's kept
   * rather than keeping a list of them.
   */
  async call(tool: HouseholdTool, args: Record<string, unknown>): Promise<unknown> {
    return this.#callAs(null, tool, args);
  }

  /** The household as one speaker hears it (see SampleHousehold.as), still kept and counted after every call. */
  as(speaker: string | null | undefined): Household {
    const shared = this;
    return {
      get name() {
        return shared.name;
      },
      decidesRequests: true,
      about: () => shared.about(),
      call: (tool, args) => shared.#callAs(speaker, tool, args),
      version: () => shared.version(),
      refusal: (action) => shared.#current().as(speaker).refusal?.(action) ?? null,
    };
  }

  async #callAs(speaker: string | null | undefined, tool: HouseholdTool, args: Record<string, unknown>): Promise<unknown> {
    const household = this.#current();
    try {
      return await household.as(speaker).call(tool, args);
    } finally {
      this.#keep(household);
    }
  }

  async version(): Promise<number> {
    return this.status().version;
  }

  status(): SampleStatus {
    const household = this.#current();
    return { name: household.name, day: this.#kept!.day, version: this.#kept!.version };
  }

  /** Starts the household over, as if it were a new day. */
  reset(): SampleStatus {
    if (!this.#household) this.#load();
    this.#start();
    return this.status();
  }

  #current(): SampleHousehold {
    if (!this.#household) this.#load();
    if (this.#dayOf(this.#household!) !== this.#kept!.day) this.#start();
    return this.#household!;
  }

  #load() {
    const kept = this.#store.load();
    const state = kept ? thaw(kept.state) : null;
    if (kept && state && this.#fits(state)) {
      this.#household = new SampleHousehold({ now: this.#now, state });
      this.#kept = kept;
      return;
    }
    // Nothing kept yet, or kept by a build whose sample had different parts: start over, after the version it had.
    this.#kept = kept;
    this.#start();
  }

  /** Whether a kept household has every part this build's sample has. */
  #fits(state: SampleState): boolean {
    const parts = Object.keys(seed(this.#now(), this.#timeZone));
    return parts.every((p) => p in state);
  }

  #start() {
    const household = new SampleHousehold({ now: this.#now, timeZone: this.#timeZone });
    this.#household = household;
    this.#kept = { day: this.#dayOf(household), version: (this.#kept?.version ?? 0) + 1, state: freeze(household.state) };
    this.#store.save(this.#kept);
  }

  #keep(household: SampleHousehold) {
    // Started over while this call ran: what it changed went with the old household.
    if (household !== this.#household || !this.#kept) return;
    const state = freeze(household.state);
    if (state === this.#kept.state) return;
    this.#kept = { ...this.#kept, version: this.#kept.version + 1, state };
    this.#store.save(this.#kept);
  }

  #dayOf(household: SampleHousehold): string {
    return this.#now().toZonedDateTimeISO(household.state.timeZone).toPlainDate().toString();
  }
}

// ---------- Keeping a household as JSON ----------

const TEMPORAL = {
  Instant: Temporal.Instant,
  ZonedDateTime: Temporal.ZonedDateTime,
  PlainDate: Temporal.PlainDate,
  PlainDateTime: Temporal.PlainDateTime,
  PlainTime: Temporal.PlainTime,
  Duration: Temporal.Duration,
} as const;
type TemporalType = keyof typeof TEMPORAL;

/** A household's state as JSON, with its Temporal values marked so thaw brings them back as themselves. */
export function freeze(state: SampleState): string {
  return JSON.stringify(state, function (this: Record<string, unknown>, key: string, value: unknown) {
    // JSON.stringify has already turned a Temporal value into its string; the original is still on its holder.
    const raw = this[key];
    for (const type of Object.keys(TEMPORAL) as TemporalType[]) {
      if (raw instanceof TEMPORAL[type]) return { $temporal: type, value: String(raw) };
    }
    return value;
  });
}

/** A household's state from freeze's JSON, or null if it isn't that. */
export function thaw(text: string): SampleState | null {
  try {
    const state = JSON.parse(text, (_key, value: unknown) => {
      if (value && typeof value === "object" && "$temporal" in value && "value" in value) {
        const { $temporal, value: wire } = value as { $temporal: string; value: unknown };
        const kind = TEMPORAL[$temporal as TemporalType] as { from(v: string): unknown } | undefined;
        if (kind && typeof wire === "string") return kind.from(wire);
      }
      return value;
    }) as unknown;
    return state && typeof state === "object" ? (state as SampleState) : null;
  } catch {
    return null;
  }
}
