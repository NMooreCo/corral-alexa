import { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import type { Device, DeviceLimits, DeviceRun, DeviceSource, Reading, SwitchRequest } from "./types.ts";
import { clockAt, duration } from "./words.ts";

/**
 * Every device on the place, from every source, behind one switch that
 * enforces each device's own limits. What a device is, what it reads and how
 * far it may be pushed are all its data; this file never asks which device
 * it's looking at.
 */

/** A timed run that ends `secondsLeft` from now. */
export function runOf(secondsLeft: number, now: Temporal.Instant, timeZone: string): DeviceRun | null {
  if (!(secondsLeft > 0)) return null;
  const ends = now.add({ seconds: Math.round(secondsLeft) });
  return { secondsLeft: Math.round(secondsLeft), endsAt: ends.toString(), endsLabel: clockAt(ends, timeZone) };
}

/** What a device does on its own if it can't be reached, in words. */
export function failsafeWords(limits: DeviceLimits): string {
  return limits.failsafe === "on" ? "If it loses its connection, it stays on." : "If it loses its connection, it switches itself off.";
}

/** What needs attention on a device, from its readings and whether it answered. */
export function attentionOf(readings: Reading[], reachable: boolean, limits: DeviceLimits, sourceName: string): string[] {
  const out: string[] = [];
  if (!reachable) out.push(`The ${sourceName.toLowerCase()} isn't answering. ${failsafeWords(limits)}`);
  for (const r of readings) {
    if (r.fault) out.push(`${r.label}: ${r.fault}`);
    else if (r.low) out.push(`${r.label} is low: ${r.text}`);
    else if (r.high) out.push(`${r.label} is high: ${r.text}`);
  }
  return out;
}

const STOP = new Set(["the", "a", "an", "in", "at", "on", "of", "for", "my", "our", "to"]);
/** "The tank heaters" and "tank heater" say the same words. */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 ? w.replace(/(?<!s)s$/, "") : w));

/** What the model hears about a device: the essentials, in words. */
export function spoken(d: Device) {
  return {
    id: d.id,
    name: d.name,
    place: d.place,
    kind: d.kind,
    switchable: d.switchable,
    state: d.reachable ? d.state : "unknown",
    ...(d.run ? { run: `${duration(d.run.secondsLeft)} left, until ${d.run.endsLabel}` } : {}),
    ...(d.readings.length ? { readings: Object.fromEntries(d.readings.map((r) => [r.label, r.fault ? `${r.text} (${r.fault})` : r.text])) } : {}),
    ...(d.switchable && d.limits.maxRunS ? { maxRun: duration(d.limits.maxRunS) } : {}),
    ...(d.switchable && d.limits.defaultRunS ? { defaultRun: duration(d.limits.defaultRunS) } : {}),
    ...(d.switchable ? { ifUnreachable: d.limits.failsafe === "on" ? "stays on" : "switches itself off" } : {}),
    attention: d.attention,
    ...(d.note ? { note: d.note } : {}),
    live: d.live,
  };
}

export interface SwitchArgs {
  device?: unknown;
  state?: unknown;
  seconds?: unknown;
  minutes?: unknown;
}

export interface SwitchAnswer {
  status: "done";
  summary: string;
  note?: string;
  device: ReturnType<typeof spoken>;
}

export class DeviceHub {
  readonly #sources: DeviceSource[];

  constructor(sources: DeviceSource[]) {
    this.#sources = sources;
  }

  async all(): Promise<Device[]> {
    return (await Promise.all(this.#sources.map((s) => s.list()))).flat();
  }

  /** Devices at a place, or one device by name, or everything. */
  async list(filter: { place?: unknown; device?: unknown } = {}): Promise<Device[]> {
    const all = await this.all();
    if (typeof filter.device === "string" && filter.device.trim()) return [this.match(all, filter.device)];
    if (typeof filter.place === "string" && filter.place.trim()) {
      const want = words(filter.place).join(" ");
      const here = all.filter((d) => words(d.place).join(" ") === want || words(d.place).join(" ").includes(want));
      if (!here.length) throw new ToolError(`There are no devices at "${filter.place}". Places: ${[...new Set(all.map((d) => d.place))].join(", ")}.`);
      return here;
    }
    return all;
  }

  /** One device by its id or however someone says its name; a name that fits several says which. */
  match(all: Device[], said: string): Device {
    const exact = all.find((d) => d.id === said);
    if (exact) return exact;
    const want = words(said);
    if (!want.length) throw new ToolError("Say which device.");
    const named = all.filter((d) => words(d.name).join(" ") === want.join(" "));
    if (named.length === 1) return named[0]!;
    const fits = all.filter((d) => {
      const have = new Set([...words(d.name), ...words(d.place)]);
      return want.every((w) => have.has(w));
    });
    if (fits.length === 1) return fits[0]!;
    if (fits.length > 1) throw new ToolError(`"${said}" could be ${fits.map((d) => d.name).join(", ")}. Say which one, or switch each of them.`);
    throw new ToolError(`There's no device called "${said}". Devices: ${all.map((d) => d.name).join(", ")}.`);
  }

  /** Switches a device on (for a run, or with no end when it may stay on) or off, inside its limits. */
  async set(args: SwitchArgs): Promise<SwitchAnswer> {
    const all = await this.all();
    const d = this.match(all, String(args.device ?? ""));
    if (args.state !== "on" && args.state !== "off") throw new ToolError('The state is "on" or "off".');
    if (!d.switchable) throw new ToolError(`The ${d.name} only reports readings; there's nothing to switch.`);
    const request = this.#request(d, args.state, args.seconds, args.minutes);
    const source = this.#sources.find((s) => d.id.startsWith(`${s.id}.`));
    if (!source) throw new ToolError(`Nothing controls the ${d.name} right now.`);
    const after = await source.set(d.id, request);
    return this.#answer(after, request);
  }

  #request(d: Device, state: "on" | "off", seconds: unknown, minutes: unknown): SwitchRequest {
    if (state === "off") return { state: "off" };
    const parts = [seconds, minutes].map((v, i) => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ToolError("A run length is a number of seconds or minutes, 0 or more.");
      return i === 0 ? n : n * 60;
    });
    let run = parts.every((p) => p === null) ? null : Math.round((parts[0] ?? 0) + (parts[1] ?? 0));
    if (run !== null && run < 1) throw new ToolError("A run needs to be at least a second.");
    const { maxRunS, defaultRunS } = d.limits;
    if (maxRunS) {
      // Every run on a device with a cap has an end.
      if (run === null) {
        if (!defaultRunS) throw new ToolError(`Say how long: the ${d.name} runs at most ${duration(maxRunS)} at a time.`);
        run = defaultRunS;
      }
      if (run > maxRunS) throw new ToolError(`The ${d.name} runs at most ${duration(maxRunS)} at a time. Offer ${duration(maxRunS)} or less.`);
    }
    return { state: "on", seconds: run };
  }

  #answer(d: Device, request: SwitchRequest): SwitchAnswer {
    let summary: string;
    let note: string | undefined;
    if (request.state === "off") {
      summary = `${d.name} off`;
      if (d.limits.failsafe === "on") note = `${failsafeWords(d.limits)} It also comes back on if its controller restarts.`;
    } else if (d.run) {
      summary = `${d.name} on for ${duration(d.run.secondsLeft)}, until ${d.run.endsLabel}`;
      if (request.seconds && d.run.secondsLeft < request.seconds - 2) note = `It's running ${duration(d.run.secondsLeft)}, less than asked: its controller capped it.`;
    } else if (d.state === "on") {
      summary = request.seconds ? `${d.name} on` : `${d.name} on, with no set end`;
    } else {
      summary = `${d.name} didn't switch on`;
      note = "Its controller answered but it's still off.";
    }
    return { status: "done", summary, ...(note ? { note } : {}), device: spoken(d) };
  }
}
