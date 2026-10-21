import { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import type { DeviceHub } from "./devices.ts";
import type { Device, Units } from "./types.ts";
import { degrees, duration } from "./words.ts";

/**
 * Automations: rules a household sets up for its devices, like heaters that
 * come on when a freeze is coming, or misters on a schedule. Each one is data
 * (when, and which switches to make), and nothing here knows what a heater or
 * a mister is. They switch through the same device hub as everyone else, so a
 * device's limits still apply, and they run when the ranch is next looked at
 * after they come due (screens look every few seconds while they're up).
 */

export type AutomationTrigger =
  /** Every day at these times ("07:00"), in the household's time zone. */
  | { kind: "schedule"; times: string[] }
  /** At `at` each day, when tonight's forecast low is at or below `below` (the household's units). */
  | { kind: "freeze"; below: number; at: string }
  /** Whenever a device's reading drops below `below`, at most once an hour. */
  | { kind: "reading"; device: string; reading: string; below: number };

export interface AutomationStep {
  device: string;
  state: "on" | "off";
  seconds?: number;
  minutes?: number;
}

export interface AutomationSpec {
  id: string;
  name: string;
  enabled: boolean;
  when: AutomationTrigger;
  then: AutomationStep[];
}

/** One automation in words, for the assistant and the screen. */
export interface AutomationView {
  id: string;
  name: string;
  enabled: boolean;
  /** What starts it, for a screen's icon. */
  kind: AutomationTrigger["kind"];
  /** "Every day at 7:00 AM and 3:00 PM". */
  when: string;
  /** "Run the greenhouse misters for 2 minutes". */
  then: string[];
  /** "Today at 5:00 PM, if it's 25°F or colder"; null while it's off. */
  next: string | null;
  lastRun: { at: string; did: string[]; failed: string[] } | null;
}

export interface AutomationContext {
  devices: DeviceHub;
  timeZone: string;
  units: Units;
  now: () => Temporal.Instant;
  /** Tonight's forecast low in the household's units, or null when the forecast can't be read. */
  tonightLow: () => Promise<number | null>;
  /** Keeps what happened (an automation run, turned on or off, added) for the ranch's history. */
  note?: (text: string, kind?: "automation" | "run") => void;
}

interface Rule extends AutomationSpec {
  /** `past` marks a run from a sample's history, said from its steps. */
  lastRun: { at: Temporal.Instant; did: string[]; failed: string[]; past?: boolean } | null;
}

const READING_EVERY_MINUTES = 60;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** The longest name an automation takes, and how many a ranch keeps. */
const MAX_NAME = 60;
const MAX_AUTOMATIONS = 20;

export class Automations {
  #rules: Rule[];
  #checked: Temporal.Instant | null = null;
  #ticking: Promise<unknown> = Promise.resolve();
  readonly #ctx: AutomationContext;

  /** With `history`, each scheduled automation that's on starts as having run at its last time (a sample's past). */
  constructor(specs: AutomationSpec[], ctx: AutomationContext, opts: { history?: boolean } = {}) {
    this.#ctx = ctx;
    this.#rules = specs.map((s) => ({ ...structuredClone(s), lastRun: null }));
    if (opts.history) {
      const now = ctx.now();
      for (const r of this.#rules) {
        if (!r.enabled || r.when.kind !== "schedule") continue;
        const last = this.#occurrences(r.when.times, now.subtract({ hours: 24 }), now).at(-1);
        if (last) r.lastRun = { at: last, did: [], failed: [], past: true };
      }
    }
  }

  /** Every automation, in words. */
  async list(): Promise<AutomationView[]> {
    const devices = await this.#ctx.devices.all().catch(() => [] as Device[]);
    return this.#rules.map((r) => this.#view(r, devices));
  }

  /** Turns an automation on or off, by its id or however someone says its name. */
  async set(said: unknown, enabled: unknown): Promise<AutomationView> {
    if (typeof enabled !== "boolean") throw new ToolError("Say whether to turn it on (true) or off (false).");
    const rule = this.#match(said);
    if (rule.enabled !== enabled) this.#ctx.note?.(`${rule.name} turned ${enabled ? "on" : "off"}`);
    rule.enabled = enabled;
    const devices = await this.#ctx.devices.all().catch(() => [] as Device[]);
    return this.#view(rule, devices);
  }

  /** Adds a new automation after checking every device and run against its limits; it starts on. */
  async add(input: { name?: unknown; when?: unknown; then?: unknown }): Promise<AutomationView> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new ToolError("Give the automation a short name, like \"Freeze protection\".");
    if (name.length > MAX_NAME) throw new ToolError(`Give the automation a shorter name, ${MAX_NAME} characters at most, like "Freeze protection".`);
    if (this.#rules.length >= MAX_AUTOMATIONS) throw new ToolError(`The ranch already has ${MAX_AUTOMATIONS} automations, as many as it keeps, so this one wasn't added. Turn one that's there on or off instead.`);
    if (this.#rules.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new ToolError(`There's already an automation called "${name}". Turn it on or off instead, or pick another name.`);
    const when = await this.#trigger(input.when);
    const then = await this.#steps(input.then);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "automation";
    let id = base;
    for (let i = 2; this.#rules.some((r) => r.id === id); i++) id = `${base}-${i}`;
    const rule: Rule = { id, name, enabled: true, when, then, lastRun: null };
    this.#rules.push(rule);
    this.#ctx.note?.(`${name} added, and on`);
    return this.#view(rule, await this.#ctx.devices.all());
  }

  /** Runs whatever came due since the last look. The first look only starts the clock. */
  tick(): Promise<void> {
    const next = this.#ticking.then(() => this.#tick());
    this.#ticking = next.catch(() => {});
    return next;
  }

  async #tick(): Promise<void> {
    const now = this.#ctx.now();
    const since = this.#checked;
    this.#checked = now;
    if (!since) return;
    // Every rule is checked at once (tonight's forecast, a device's reading), so a slow source is waited on once, not once a rule.
    const rules = [...this.#rules];
    const due = await Promise.all(rules.map((r) => r.enabled && this.#due(r, since, now)));
    let ran = false;
    for (const [i, r] of rules.entries()) {
      if (!due[i] || !r.enabled) continue;
      // A run before this one may have moved the reading this one watches, so it looks again.
      if (ran && r.when.kind === "reading" && !(await this.#due(r, since, now))) continue;
      ran = true;
      const did: string[] = [];
      const failed: string[] = [];
      for (const s of r.then) {
        try {
          did.push((await this.#ctx.devices.set({ device: s.device, state: s.state, seconds: s.seconds, minutes: s.minutes })).summary);
        } catch (err) {
          failed.push(err instanceof ToolError ? err.message : `${s.device} didn't answer.`);
        }
      }
      r.lastRun = { at: now, did, failed };
      this.#ctx.note?.(`${r.name} ran: ${[...did, ...failed].join("; ") || "nothing to do"}`, "run");
    }
  }

  async #due(r: Rule, since: Temporal.Instant, now: Temporal.Instant): Promise<boolean> {
    const w = r.when;
    if (w.kind === "schedule") return this.#occurrences(w.times, since, now).length > 0;
    if (w.kind === "freeze") {
      if (!this.#occurrences([w.at], since, now).length) return false;
      const low = await this.#ctx.tonightLow();
      return low !== null && low <= w.below;
    }
    if (r.lastRun && now.since(r.lastRun.at).total("minutes") < READING_EVERY_MINUTES) return false;
    const value = await this.#reading(w.device, w.reading).catch(() => null);
    return value !== null && value < w.below;
  }

  async #reading(device: string, reading: string): Promise<number | null> {
    const d = this.#ctx.devices.match(await this.#ctx.devices.all(), device);
    return readingOf(d, reading)?.value ?? null;
  }

  /** The instants of these daily times that fall after `from` and at or before `to`. */
  #occurrences(times: string[], from: Temporal.Instant, to: Temporal.Instant): Temporal.Instant[] {
    const tz = this.#ctx.timeZone;
    const today = to.toZonedDateTimeISO(tz).toPlainDate();
    const out: Temporal.Instant[] = [];
    for (const day of [today.subtract({ days: 1 }), today]) {
      for (const t of times) {
        const at = day.toZonedDateTime({ timeZone: tz, plainTime: Temporal.PlainTime.from(t) }).toInstant();
        if (Temporal.Instant.compare(at, from) > 0 && Temporal.Instant.compare(at, to) <= 0) out.push(at);
      }
    }
    return out.sort(Temporal.Instant.compare);
  }

  #match(said: unknown): Rule {
    const text = typeof said === "string" ? said.trim().toLowerCase() : "";
    if (!text) throw new ToolError("Say which automation.");
    const exact = this.#rules.find((r) => r.id === text || r.name.toLowerCase() === text);
    if (exact) return exact;
    const fits = this.#rules.filter((r) => r.name.toLowerCase().includes(text) || text.includes(r.name.toLowerCase()));
    if (fits.length === 1) return fits[0]!;
    const names = this.#rules.map((r) => r.name).join(", ");
    if (fits.length > 1) throw new ToolError(`"${said}" could be ${fits.map((r) => r.name).join(" or ")}. Say which.`);
    throw new ToolError(`There's no automation called "${said}". Automations: ${names || "none yet"}.`);
  }

  async #trigger(raw: unknown): Promise<AutomationTrigger> {
    const w = (raw ?? {}) as Record<string, unknown>;
    const time = (t: unknown) => {
      if (typeof t !== "string" || !TIME.test(t.trim())) throw new ToolError(`A time is like "07:00" or "17:30", not "${String(t)}".`);
      const [h, m] = t.trim().split(":");
      return `${h!.padStart(2, "0")}:${m}`;
    };
    const number = (v: unknown, what: string) => {
      const n = Number(v);
      if (v === undefined || v === null || v === "" || !Number.isFinite(n)) throw new ToolError(`Say ${what} as a number.`);
      return n;
    };
    if (w.kind === "schedule") {
      const times = Array.isArray(w.times) ? w.times.map(time) : [];
      if (!times.length || times.length > 6) throw new ToolError("A schedule needs one to six times a day.");
      return { kind: "schedule", times: [...new Set(times)].sort() };
    }
    if (w.kind === "freeze") return { kind: "freeze", below: number(w.below, "how cold tonight has to get"), at: w.at === undefined ? "17:00" : time(w.at) };
    if (w.kind === "reading") {
      const d = this.#ctx.devices.match(await this.#ctx.devices.all(), String(w.device ?? ""));
      const r = readingOf(d, String(w.reading ?? ""));
      if (!r) throw new ToolError(`The ${d.name} reads ${d.readings.map((x) => x.label).join(", ") || "nothing"}. Say which.`);
      return { kind: "reading", device: d.id, reading: r.key, below: number(w.below, "the reading to act below") };
    }
    throw new ToolError('Say when it runs: kind "schedule" (times), "freeze" (below, at) or "reading" (device, reading, below).');
  }

  async #steps(raw: unknown): Promise<AutomationStep[]> {
    if (!Array.isArray(raw) || !raw.length || raw.length > 8) throw new ToolError("Say one to eight devices to switch.");
    const steps: AutomationStep[] = [];
    for (const item of raw) {
      const s = (item ?? {}) as Record<string, unknown>;
      // Checked as if switching now, so a run over a device's limit is refused here, not later.
      const { device } = await this.#ctx.devices.check({ device: s.device, state: s.state, seconds: s.seconds, minutes: s.minutes });
      steps.push({ device: device.id, state: s.state as "on" | "off", ...(s.seconds !== undefined ? { seconds: Number(s.seconds) } : {}), ...(s.minutes !== undefined ? { minutes: Number(s.minutes) } : {}) });
    }
    return steps;
  }

  #view(r: Rule, devices: Device[]): AutomationView {
    const named = (id: string) => devices.find((d) => d.id === id);
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      kind: r.when.kind,
      when: this.#whenWords(r.when, named),
      then: r.then.map((s) => stepWords(s, named(s.device))),
      next: r.enabled ? this.#nextWords(r.when) : null,
      lastRun: r.lastRun ? { at: this.#dayAndTime(r.lastRun.at), did: r.lastRun.past ? r.then.map((s) => stepDone(s, named(s.device))) : r.lastRun.did, failed: r.lastRun.failed } : null,
    };
  }

  #whenWords(w: AutomationTrigger, named: (id: string) => Device | undefined): string {
    if (w.kind === "schedule") return `Every day at ${and(w.times.map(clock))}`;
    if (w.kind === "freeze") return `At ${clock(w.at)}, when tonight's low is ${degrees(w.below, this.#ctx.units)} or colder`;
    const d = named(w.device);
    const r = d ? readingOf(d, w.reading) : undefined;
    return `Whenever the ${lower(d?.name ?? w.device)}'s ${lower(r?.label ?? w.reading)} is below ${amount(w.below, r?.unit, this.#ctx.units)}`;
  }

  #nextWords(w: AutomationTrigger): string | null {
    const now = this.#ctx.now();
    if (w.kind === "reading") return "Whenever that happens";
    const times = w.kind === "schedule" ? w.times : [w.at];
    const tz = this.#ctx.timeZone;
    const today = now.toZonedDateTimeISO(tz).toPlainDate();
    const upcoming = [today, today.add({ days: 1 })]
      .flatMap((day) => times.map((t) => day.toZonedDateTime({ timeZone: tz, plainTime: Temporal.PlainTime.from(t) }).toInstant()))
      .filter((at) => Temporal.Instant.compare(at, now) > 0)
      .sort(Temporal.Instant.compare)[0];
    if (!upcoming) return null;
    const when = this.#dayAndTime(upcoming);
    return w.kind === "freeze" ? `${when}, if it's ${degrees(w.below, this.#ctx.units)} or colder tonight` : when;
  }

  /** "Today at 3:00 PM", "Tomorrow at 7:00 AM", "Yesterday at 5:00 PM". */
  #dayAndTime(at: Temporal.Instant): string {
    const tz = this.#ctx.timeZone;
    const z = at.toZonedDateTimeISO(tz);
    const today = this.#ctx.now().toZonedDateTimeISO(tz).toPlainDate();
    const days = z.toPlainDate().since(today).days;
    const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : z.toPlainDate().toLocaleString("en-US", { weekday: "long" });
    return `${day} at ${clock(`${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`)}`;
  }
}

function readingOf(d: Device, said: string): Device["readings"][number] | undefined {
  const want = said.trim().toLowerCase();
  return d.readings.find((r) => r.key.toLowerCase() === want || r.label.toLowerCase() === want) ?? d.readings.find((r) => r.label.toLowerCase().includes(want));
}

/** "7:00 AM" for "07:00". */
function clock(t: string): string {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function and(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function lower(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function amount(value: number, unit: string | undefined, units: Units): string {
  if (!unit || unit.startsWith("°")) return degrees(value, units);
  return unit === "%" ? `${value}%` : `${value} ${unit}`;
}

function runOf(s: AutomationStep): number | null {
  const total = (s.seconds ?? 0) + (s.minutes ?? 0) * 60;
  return total > 0 ? total : null;
}

/** "Run the greenhouse misters for 2 minutes", "Turn on the coop heat lamp for its usual 12 hours", "Turn off the barn heater". */
function stepWords(s: AutomationStep, d: Device | undefined): string {
  const name = `the ${lower(d?.name ?? s.device)}`;
  if (s.state === "off") return `Turn off ${name}`;
  const run = runOf(s);
  if (run) return `Run ${name} for ${duration(run)}`;
  if (d?.limits.maxRunS && d.limits.defaultRunS) return `Turn on ${name} for its usual ${duration(d.limits.defaultRunS)}`;
  return `Turn on ${name}`;
}

/** What a step did, for a sample's past runs: "Greenhouse misters ran 2 minutes". */
function stepDone(s: AutomationStep, d: Device | undefined): string {
  const name = d?.name ?? s.device;
  const run = runOf(s);
  return s.state === "off" ? `${name} off` : run ? `${name} ran ${duration(run)}` : `${name} on`;
}
