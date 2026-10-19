import { Temporal } from "temporal-polyfill";
import { DeviceHub } from "./devices.ts";
import { isLocalHost } from "./greenhouse.ts";
import { trackerReport, type TrackerReport } from "./trackers.ts";
import type { DeviceSource, RanchConfig, TrackerFeed } from "./types.ts";
import { forecast, type Forecast } from "./weather.ts";
import { now as clockNow } from "../clock.ts";
import { Automations } from "./automations.ts";

/** The most ranch history kept. */
const MAX_HISTORY = 60;

/** Something that happened on the ranch, in words: a device switched, or an automation run or changed. */
export interface RanchHistoryEntry {
  at: Temporal.Instant;
  text: string;
  kind: "device" | "automation";
}

/**
 * A household's ranch: its configuration (where it is, its property map, its
 * thresholds), the sources its devices come from, its collar feed, and the
 * forecast for its location. The tools and screens read everything through
 * this, so a real connector and a simulation are the same to them.
 */
export class Ranch {
  readonly config: RanchConfig;
  readonly devices: DeviceHub;
  readonly trackers: TrackerFeed;
  readonly automations: Automations;
  readonly #now: () => Temporal.Instant;
  readonly #fetch?: typeof fetch;
  /** What's happened on the ranch, oldest first: devices switched, automations run or changed. */
  readonly #history: RanchHistoryEntry[] = [];

  /** With `history`, scheduled automations start as having run at their last time (a sample's past). */
  constructor(opts: { config: RanchConfig; sources: DeviceSource[]; trackers: TrackerFeed; now?: () => Temporal.Instant; fetch?: typeof fetch; history?: boolean }) {
    this.config = opts.config;
    this.devices = new DeviceHub(opts.sources);
    this.trackers = opts.trackers;
    this.#now = opts.now ?? clockNow;
    this.#fetch = opts.fetch;
    this.automations = new Automations(
      opts.config.automations ?? [],
      {
        devices: this.devices,
        timeZone: opts.config.timeZone,
        units: opts.config.units,
        now: this.#now,
        tonightLow: async () => (await this.weather().catch(() => null))?.tonight.lowValue ?? null,
        note: (text) => this.note(text, "automation"),
      },
      { history: opts.history },
    );
  }

  /** Runs any automation that came due since the ranch was last looked at. */
  tick(): Promise<void> {
    return this.automations.tick();
  }

  now(): Temporal.Instant {
    return this.#now();
  }

  /** Keeps something that happened on the ranch, for "since last night". */
  note(text: string, kind: RanchHistoryEntry["kind"] = "device"): void {
    this.#history.push({ at: this.#now(), text, kind });
    if (this.#history.length > MAX_HISTORY) this.#history.splice(0, this.#history.length - MAX_HISTORY);
  }

  /** What's happened on the ranch since `since`, oldest first. */
  history(since: Temporal.Instant): RanchHistoryEntry[] {
    return this.#history.filter((h) => Temporal.Instant.compare(h.at, since) >= 0);
  }

  weather(): Promise<Forecast> {
    return forecast({ location: this.config.location, timeZone: this.config.timeZone, units: this.config.units, fetch: this.#fetch, now: this.#now });
  }

  animals(animal?: unknown): Promise<TrackerReport> {
    return trackerReport(this.trackers, this.config, this.#now(), animal);
  }
}

/** What the local greenhouse connector needs from the Worker's environment. */
export interface GreenhouseEnv {
  GREENHOUSE_URL?: string;
  GREENHOUSE_KEY?: string;
  GREENHOUSE_LAN?: string;
  GREENHOUSE_MAX_RUN_S?: string;
}

/**
 * The real greenhouse controller, when it's allowed: only under `pnpm dev:lan`
 * (which sets GREENHOUSE_LAN), only with both GREENHOUSE_URL and
 * GREENHOUSE_KEY, and only while this Worker is being served from this
 * machine or the local network. A deployed Worker never reaches it.
 */
export function localGreenhouse(env: GreenhouseEnv, requestUrl: string): { url: string; key: string; maxRunS?: number } | null {
  if (env.GREENHOUSE_LAN !== "true" || !env.GREENHOUSE_URL?.trim() || !env.GREENHOUSE_KEY?.trim()) return null;
  if (!isLocalHost(new URL(requestUrl).hostname)) return null;
  const max = Number(env.GREENHOUSE_MAX_RUN_S);
  return { url: env.GREENHOUSE_URL.trim(), key: env.GREENHOUSE_KEY.trim(), ...(Number.isFinite(max) && max > 0 ? { maxRunS: Math.floor(max) } : {}) };
}
