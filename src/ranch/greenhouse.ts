import { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import { attentionOf, runOf } from "./devices.ts";
import type { Device, DeviceLimits, DeviceSource, Reading, SwitchRequest, Units } from "./types.ts";
import { ago, fromCelsius, readingText, tempUnit } from "./words.ts";
import { now as clockNow } from "../clock.ts";

/**
 * A connector for an ESP32 greenhouse controller running the v0.1 valve
 * firmware's REST API:
 *
 *   GET  /status    -> {"valve":"on|off","remaining_s":N,"uptime_s":N,"rssi":N,
 *                       "climate":{"temp_c","humidity","pressure_hpa","age_s","ok"},   (once the air sensor has read)
 *                       "soil":{"age_s":N,"beds":[{"id":"s1","mv":N},...]}}             (once the soil probes have read)
 *   POST /on?sec=N  -> the same, with the X-Api-Key header; the firmware clamps N to its 1800 s cap
 *   POST /off       -> the same, with the X-Api-Key header
 *   errors          -> {"error":"..."} with 400, 401 or 404
 *
 * The valve is normally closed and the firmware closes it when a run ends, on
 * any fault and if Wi-Fi drops, so its safe failure is off. The firmware
 * reports raw soil millivolts on purpose (higher is drier): a percentage needs
 * dry and wet points measured in each bed, which this takes as configuration
 * when there are some and otherwise leaves alone.
 */

/** The firmware's own hard cap on a run (MAX_RUN_S); no configuration goes past it. */
export const FIRMWARE_MAX_RUN_S = 1800;
/** The id v0.1 gives its one valve. */
export const VALVE_ID = "valve1";

export interface GreenhouseConfig {
  /** Prefix for its devices' ids, like "greenhouse". */
  id: string;
  /** Where the controller is, like "Greenhouse". */
  place: string;
  /** What this household calls the valve, the air sensor, the soil probes and each bed. */
  names: { valve: string; valveKind: string; climate: string; soil: string; beds: Record<string, string> };
  limits: Omit<DeviceLimits, "failsafe">;
  /** Dry and wet millivolts measured in each bed. Beds without them read raw millivolts. */
  calibration?: Record<string, { dryMv: number; wetMv: number }>;
  /** Air below or above these (Celsius) needs attention; a calibrated bed below this percent is dry. */
  thresholds?: { airLowC?: number; airHighC?: number; soilDryPct?: number };
  /** A reading older than this many seconds is stale: a frozen number looks just like a working sensor. */
  staleAfterS?: { climate: number; soil: number };
}

export interface GreenhouseOptions {
  /** Its address: "192.0.2.72", "greenhouse.local" or a full URL. */
  url: string;
  /** The controller's API key, sent as X-Api-Key on switching calls only. Never logged or said. */
  key: string;
  config: GreenhouseConfig;
  units: Units;
  timeZone: string;
  /** True for real hardware, false for a simulation speaking the same API. */
  live: boolean;
  fetch?: typeof fetch;
  now?: () => Temporal.Instant;
  timeoutMs?: number;
  /** How long one /status answer serves every read (the screen's refresh and several tool calls in a turn). */
  cacheMs?: number;
  /**
   * After a /status read times out, how long reads say the controller isn't
   * answering straight away instead of each waiting out the timeout again
   * (Alexa+ wants an answer in under 500 ms). Switching still always tries.
   */
  quietMs?: number;
}

interface V0Status {
  valve?: string;
  remaining_s?: number;
  uptime_s?: number;
  rssi?: number;
  climate?: { temp_c?: number; humidity?: number; pressure_hpa?: number; age_s?: number; ok?: boolean };
  soil?: { age_s?: number; beds?: { id?: string; mv?: number }[] };
  error?: string;
}

/** Accepts "192.0.2.72", "greenhouse.local", or a full URL. */
export function controllerBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** What a capacitive probe's millivolts say about the probe itself, from the controller's bench tests. */
export function probeFault(mv: number): string | undefined {
  if (mv <= 10) return "wiring fault: its input reads ground";
  if (mv >= 200 && mv <= 400) return "no probe connected";
  if (mv < 900) return "out of a working probe's range";
  return undefined;
}

export class GreenhouseController implements DeviceSource {
  readonly id: string;
  readonly #o: Required<Omit<GreenhouseOptions, "fetch" | "now">> & { fetch: typeof fetch; now: () => Temporal.Instant };
  readonly #base: string;
  #cached: { at: number; status: V0Status } | null = null;
  /** A /status request on its way, which every read that comes meanwhile shares: a small controller on weak Wi-Fi answers one request at a time. */
  #asking: Promise<V0Status> | null = null;
  /** The last good answer, to say what it last read when it stops answering. */
  #lastGood: { at: Temporal.Instant; status: V0Status } | null = null;
  /** Until when reads take the controller's silence as given (see quietMs). */
  #quietUntil = 0;

  constructor(opts: GreenhouseOptions) {
    this.id = opts.config.id;
    this.#o = {
      timeoutMs: 4000,
      cacheMs: 2000,
      quietMs: 30_000,
      ...opts,
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
      now: opts.now ?? clockNow,
    };
    this.#base = controllerBase(opts.url);
  }

  get #limits(): DeviceLimits {
    const l = this.#o.config.limits;
    const max = Math.min(l.maxRunS ?? FIRMWARE_MAX_RUN_S, FIRMWARE_MAX_RUN_S);
    return { ...l, maxRunS: max, defaultRunS: Math.min(l.defaultRunS ?? 300, max), failsafe: "off" };
  }

  get #sourceName(): string {
    return "Greenhouse controller";
  }

  async #request(method: "GET" | "POST", path: string): Promise<V0Status> {
    let res: Response;
    try {
      res = await this.#o.fetch(this.#base + path, {
        method,
        headers: method === "POST" ? { "X-Api-Key": this.#o.key } : {},
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      throw new Unreachable();
    }
    const text = await res.text();
    let body: V0Status | null = null;
    try {
      body = text ? (JSON.parse(text) as V0Status) : null;
    } catch {
      // A non-JSON answer is its own problem, said below.
    }
    if (res.status === 401) {
      console.warn(`greenhouse: ${new URL(this.#base).host} refused the API key (401)`);
      throw new ToolError("The greenhouse controller didn't accept this connection's key, so nothing was switched.");
    }
    if (res.status === 400) throw new ToolError(`The greenhouse controller turned that down: ${body?.error ?? "a bad request"}.`);
    if (!res.ok) throw new ToolError(`The greenhouse controller answered with an error (${res.status}${body?.error ? `: ${body.error}` : ""}).`);
    if (!body || typeof body.valve !== "string") throw new ToolError("Something answered at the greenhouse controller's address, but not the way the controller does.");
    this.#lastGood = { at: this.#o.now(), status: body };
    this.#cached = { at: this.#o.now().epochMilliseconds, status: body };
    this.#quietUntil = 0;
    return body;
  }

  async #status(): Promise<V0Status> {
    const now = this.#o.now().epochMilliseconds;
    if (this.#cached && now - this.#cached.at < this.#o.cacheMs) return this.#cached.status;
    if (now < this.#quietUntil) throw new Unreachable();
    // Reads that come together (a screen's devices and its automations, an automation's check) wait on one answer, and on one timeout.
    if (!this.#asking) {
      this.#asking = this.#request("GET", "/status")
        .catch((err: unknown) => {
          if (err instanceof Unreachable) this.#quietUntil = this.#o.now().epochMilliseconds + this.#o.quietMs;
          throw err;
        })
        .finally(() => (this.#asking = null));
    }
    return this.#asking;
  }

  async list(): Promise<Device[]> {
    try {
      return this.#devices(await this.#status(), true);
    } catch (err) {
      if (!(err instanceof Unreachable) && !(err instanceof ToolError)) throw err;
      // Not answering, or answering wrongly: say what it last read, and that the valve looks after itself.
      return this.#devices(this.#lastGood?.status ?? { valve: "off" }, false, err instanceof ToolError ? err.message : undefined);
    }
  }

  async set(deviceId: string, request: SwitchRequest): Promise<Device> {
    const valveId = `${this.id}.${VALVE_ID}`;
    if (deviceId !== valveId) throw new ToolError("Only the greenhouse controller's valve can be switched; its sensors only report.");
    const name = this.#o.config.names.valve;
    let status: V0Status;
    try {
      if (request.state === "on") {
        const sec = Math.max(1, Math.floor(request.seconds ?? this.#limits.defaultRunS!));
        status = await this.#request("POST", `/on?sec=${sec}`);
      } else {
        status = await this.#request("POST", "/off");
      }
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
      throw new ToolError(
        request.state === "on"
          ? `The greenhouse controller didn't answer, so I can't tell whether the ${name} started. If it did, the valve closes on its own when the run ends, or if it loses Wi-Fi.`
          : `The greenhouse controller didn't answer, so I couldn't close the ${name}. The valve closes on its own when its run ends, or if it loses Wi-Fi.`,
      );
    }
    return this.#devices(status, true).find((d) => d.id === valveId)!;
  }

  #devices(s: V0Status, reachable: boolean, problem?: string): Device[] {
    const { config, units, timeZone, live } = this.#o;
    const now = this.#o.now();
    const since = reachable || !this.#lastGood ? 0 : Math.round(now.since(this.#lastGood.at).total("seconds"));
    const stale = config.staleAfterS ?? { climate: 30, soil: 60 };
    const base = { place: config.place, source: this.#sourceName, live, reachable };
    const sensorLimits: DeviceLimits = { failsafe: "off" };
    const out: Device[] = [];

    const valveLimits = this.#limits;
    const on = reachable && s.valve === "on";
    out.push({
      ...base,
      id: `${this.id}.${VALVE_ID}`,
      name: config.names.valve,
      kind: config.names.valveKind,
      switchable: true,
      state: reachable ? (on ? "on" : "off") : null,
      run: on ? runOf(s.remaining_s ?? 0, now, timeZone) : null,
      limits: valveLimits,
      readings: [],
      attention: problem ? [problem, ...attentionOf([], true, valveLimits, this.#sourceName)] : attentionOf([], reachable, valveLimits, this.#sourceName),
    });

    const c = s.climate;
    if (c && typeof c.temp_c === "number" && typeof c.humidity === "number" && typeof c.pressure_hpa === "number") {
      const age = (c.age_s ?? 0) + since;
      const fault = c.ok === false ? `the sensor stopped answering; last read ${ago(age)}` : age > stale.climate ? `last read ${ago(age)}` : undefined;
      const t = config.thresholds ?? {};
      const temp = fromCelsius(c.temp_c, units);
      const readings: Reading[] = [
        {
          key: "air_temp",
          label: "Air temperature",
          value: temp,
          unit: tempUnit(units),
          text: readingText(temp, tempUnit(units)),
          ...(t.airLowC !== undefined && c.temp_c < t.airLowC ? { low: true } : {}),
          ...(t.airHighC !== undefined && c.temp_c > t.airHighC ? { high: true } : {}),
          ...(fault ? { fault } : {}),
        },
        { key: "humidity", label: "Humidity", value: Math.round(c.humidity), unit: "%", text: readingText(Math.round(c.humidity), "%") },
        // Station pressure: at altitude it reads far below a sea-level weather report, and that's correct.
        { key: "pressure", label: "Station pressure", value: c.pressure_hpa, unit: "hPa", text: readingText(c.pressure_hpa, "hPa") },
      ];
      out.push({ ...base, id: `${this.id}.climate`, name: config.names.climate, kind: "sensor", switchable: false, state: null, run: null, limits: sensorLimits, readings, attention: attentionOf(readings, reachable, sensorLimits, this.#sourceName) });
    }

    const soil = s.soil;
    if (soil && Array.isArray(soil.beds)) {
      const age = (soil.age_s ?? 0) + since;
      const t = config.thresholds ?? {};
      const calibrated = config.calibration ?? {};
      const readings: Reading[] = soil.beds
        .filter((b): b is { id: string; mv: number } => typeof b?.id === "string" && typeof b.mv === "number")
        .map((b) => {
          const label = config.names.beds[b.id] ?? b.id;
          const fault = probeFault(b.mv) ?? (age > stale.soil ? `last read ${ago(age)}` : undefined);
          const cal = calibrated[b.id];
          if (cal && !probeFault(b.mv) && cal.dryMv > cal.wetMv) {
            const pct = Math.round(Math.max(0, Math.min(100, ((cal.dryMv - b.mv) / (cal.dryMv - cal.wetMv)) * 100)));
            return { key: b.id, label, value: pct, unit: "%", text: readingText(pct, "%"), ...(t.soilDryPct !== undefined && pct < t.soilDryPct ? { low: true } : {}), ...(fault ? { fault } : {}) };
          }
          return { key: b.id, label, value: b.mv, unit: "mV", text: readingText(b.mv, "mV"), ...(fault ? { fault } : {}) };
        });
      const raw = readings.some((r) => r.unit === "mV");
      out.push({
        ...base,
        id: `${this.id}.soil`,
        name: config.names.soil,
        kind: "soil",
        switchable: false,
        state: null,
        run: null,
        limits: sensorLimits,
        readings,
        attention: attentionOf(readings, reachable, sensorLimits, this.#sourceName),
        ...(raw ? { note: "Soil moisture as the probes' raw millivolts: higher is drier. Beds read as percentages once they're calibrated." } : {}),
      });
    }
    return out;
  }
}

class Unreachable extends Error {}

/** True for a host on this machine or the local network, never a public name. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
