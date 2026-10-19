import { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import { attentionOf, runOf } from "../ranch/devices.ts";
import { inside, labelPoint, localPlane, type Point } from "../ranch/geo.ts";
import { GreenhouseController, type GreenhouseConfig } from "../ranch/greenhouse.ts";
import { Ranch, localGreenhouse, type GreenhouseEnv } from "../ranch/index.ts";
import type { Device, DeviceLimits, DeviceSource, LatLon, RanchConfig, Reading, SwitchRequest, SwitchState, TrackerFeed, TrackerFix, Units, Zone } from "../ranch/types.ts";
import { fromCelsius, readingText, tempUnit } from "../ranch/words.ts";
import { now as clockNow } from "../clock.ts";

/**
 * Juniper Hollow's ranch, made up for the demo: a fenced property in the
 * grasslands, laid out like a real one (a road along its
 * west side, the barn and coop on the north fence line, the house in the
 * middle with a big pasture between it and the road, woods rising to the
 * east) but placed nowhere real, a heated greenhouse whose controller speaks the
 * same API as a real ESP32 valve controller, animal-care devices in the barn
 * and pastures, and nine dogs in GPS collars. Everything specific lives
 * here, as data; the ranch tools only read it.
 */

// ---------- The place ----------

const ORIGIN: LatLon = { latitude: 43.44, longitude: -105.21 };
const plane = localPlane(ORIGIN);
/** A rectangle given in meters east and north of the property's middle. */
const rect = (west: number, south: number, east: number, north: number): LatLon[] =>
  [
    { x: west, y: south },
    { x: east, y: south },
    { x: east, y: north },
    { x: west, y: north },
  ].map(plane.toLatLon);

/** A shape given as points in meters east and north of the property's middle. */
const shape = (...points: [number, number][]): LatLon[] => points.map(([x, y]) => plane.toLatLon({ x, y }));

/** A strip `width` meters wide along a line of points: a road or a drive, drawn as a shape. */
function strip(width: number, ...line: [number, number][]): LatLon[] {
  const side = (sign: number) =>
    line.map(([x, y], i) => {
      const [ax, ay] = line[Math.max(0, i - 1)]!;
      const [bx, by] = line[Math.min(line.length - 1, i + 1)]!;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      return [x + (sign * width * (by - ay)) / (2 * len), y - (sign * width * (bx - ax)) / (2 * len)] as [number, number];
    });
  return shape(...side(1), ...side(-1).reverse());
}

/** The road along the property's west side; the fence follows it, a few meters in. */
const ROAD: [number, number][] = [
  [-252, 215],
  [-205, 90],
  [-164, 14],
  [-124, -68],
  [-97, -215],
];

// Drawn in this order: woods and roads first, so everything else sits on top.
const ZONES: Zone[] = [
  { id: "woods", name: "Woods", style: "woods", polygon: shape([62, 200], [150, 200], [150, -200], [42, -200], [72, -42], [72, 40], [92, 118]) },
  { id: "road", name: "", style: "road", polygon: strip(9, ...ROAD) },
  { id: "drive", name: "", style: "road", polygon: strip(5, [-13, -16], [-24, -60], [-34, -108], [-82, -146], [-103, -152]) },
  { id: "north-pasture", name: "North pasture", style: "field", polygon: shape([-198, 114], [138, 114], [138, 192], [-230, 192]) },
  // The big pasture between the road and the house, down to the drive; a barnyard lane north of it holds the barn and coop.
  { id: "south-pasture", name: "South pasture", style: "field", polygon: shape([-166, 72], [10, 78], [-14, 30], [-26, -14], [-30, -60], [-40, -104], [-84, -138], [-92, -138], [-104, -62], [-144, 8]) },
  { id: "barn", name: "Barn", style: "structure", polygon: rect(-155, 90, -129, 110) },
  { id: "coop", name: "Coop", style: "structure", polygon: rect(-26, 97, -12, 110) },
  { id: "house", name: "House", style: "yard", polygon: rect(-20, -14, 24, 14) },
  { id: "garden", name: "Garden", style: "yard", polygon: rect(40, -26, 68, -6) },
  { id: "greenhouse", name: "Greenhouse", style: "structure", polygon: rect(40, 30, 68, 46) },
];

/** The fence: along the road on the west, a few meters in, and around the woods to the east. */
const FENCE: LatLon[] = shape([-236, 200], [150, 200], [150, -200], [-82, -200], [-109, -68], [-149, 14], [-190, 88]);

export function sampleRanchConfig(timeZone = "America/Denver"): RanchConfig {
  return {
    location: { name: "Juniper Hollow", ...ORIGIN, elevationM: 1469 },
    timeZone,
    units: "us",
    property: { fence: FENCE, zones: ZONES },
    lowBatteryAt: 20,
    staleFixMinutes: 30,
    briefingPlaces: ["Greenhouse"],
    // Heat when a freeze is coming (off until someone turns it on), water on a schedule, and a tank that never freezes over.
    automations: [
      {
        id: "freeze-protection",
        name: "Freeze protection",
        enabled: false,
        when: { kind: "freeze", below: 25, at: "17:00" },
        then: [
          { device: "sample.tank-heater-horses", state: "on" },
          { device: "sample.tank-heater-goats", state: "on" },
          { device: "sample.barn-heater", state: "on" },
          { device: "sample.coop-lamp", state: "on" },
        ],
      },
      { id: "greenhouse-misting", name: "Greenhouse misting", enabled: true, when: { kind: "schedule", times: ["07:00", "15:00"] }, then: [{ device: "greenhouse.valve1", state: "on", minutes: 2 }] },
      { id: "garden-watering", name: "Garden watering", enabled: true, when: { kind: "schedule", times: ["06:00"] }, then: [{ device: "sample.drip", state: "on", minutes: 20 }] },
      { id: "horse-tank", name: "Keep the horse tank thawed", enabled: true, when: { kind: "reading", device: "sample.tank-heater-horses", reading: "water", below: 34 }, then: [{ device: "sample.tank-heater-horses", state: "on" }] },
    ],
  };
}

/** What this household calls its greenhouse controller's parts, and how far its valve may run. */
export const SAMPLE_GREENHOUSE: GreenhouseConfig = {
  id: "greenhouse",
  place: "Greenhouse",
  names: { valve: "Greenhouse misters", valveKind: "valve", climate: "Greenhouse air", soil: "Greenhouse beds", beds: { s1: "Bed 1", s2: "Bed 2", s3: "Bed 3", s4: "Bed 4", s5: "Bed 5" } },
  // Shorter than the firmware's 30 minute cap on purpose: a misheard "thirty minutes" stays a small mistake.
  limits: { maxRunS: 600, defaultRunS: 120, presetsS: [30, 60, 300] },
  // Made-up dry and wet points for the simulated beds. A real controller's beds need their own, measured in the bed.
  calibration: Object.fromEntries(["s1", "s2", "s3", "s4", "s5"].map((id) => [id, { dryMv: 2650, wetMv: 1250 }])),
  thresholds: { airLowC: 4.5, airHighC: 35, soilDryPct: 30 },
  staleAfterS: { climate: 30, soil: 60 },
};

// ---------- Simulated devices ----------

/** A reading that follows the day: base, plus a swing peaking at peakHour, plus a lift while the device is on. Temperatures are in Celsius. */
interface ReadingSpec {
  key: string;
  label: string;
  measure: "temperature" | "percent";
  base: number;
  swing?: number;
  peakHour?: number;
  whenOn?: number;
  lowAt?: number;
  highAt?: number;
}

interface DeviceSpec {
  key: string;
  name: string;
  kind: string;
  place: string;
  switchable: boolean;
  state: SwitchState | null;
  limits: DeviceLimits;
  readings: ReadingSpec[];
}

const HOUR = 3600;
const DEVICES: DeviceSpec[] = [
  { key: "greenhouse-heater", name: "Greenhouse heater", kind: "heater", place: "Greenhouse", switchable: true, state: "on", limits: { failsafe: "on" }, readings: [{ key: "setpoint", label: "Thermostat", measure: "temperature", base: 7.2 }] },
  {
    key: "tank-heater-horses",
    name: "Horse tank heater",
    kind: "tank heater",
    place: "North pasture",
    switchable: true,
    state: "off",
    limits: { failsafe: "on" },
    readings: [{ key: "water", label: "Water temperature", measure: "temperature", base: 4.5, swing: 3, peakHour: 15, whenOn: 4, lowAt: 1.5 }],
  },
  {
    key: "tank-heater-goats",
    name: "Goat tank heater",
    kind: "tank heater",
    place: "South pasture",
    switchable: true,
    state: "off",
    limits: { failsafe: "on" },
    readings: [{ key: "water", label: "Water temperature", measure: "temperature", base: 3.5, swing: 3, peakHour: 15, whenOn: 4, lowAt: 1.5 }],
  },
  {
    key: "waterer",
    name: "Barn waterer",
    kind: "waterer",
    place: "Barn",
    switchable: false,
    state: null,
    limits: { failsafe: "on" },
    readings: [
      { key: "level", label: "Water level", measure: "percent", base: 58, lowAt: 25 },
      { key: "water", label: "Water temperature", measure: "temperature", base: 6, swing: 1.5, peakHour: 15, lowAt: 1.5 },
    ],
  },
  {
    key: "coop-lamp",
    name: "Coop heat lamp",
    kind: "lamp",
    place: "Coop",
    switchable: true,
    state: "off",
    // A heat lamp is a fire risk left on for days, so every night's run has an end, and it fails off.
    limits: { maxRunS: 14 * HOUR, defaultRunS: 12 * HOUR, presetsS: [4 * HOUR, 8 * HOUR, 12 * HOUR], failsafe: "off" },
    readings: [{ key: "air", label: "Coop temperature", measure: "temperature", base: 4, swing: 6, peakHour: 15, whenOn: 7, lowAt: 0 }],
  },
  { key: "barn-heater", name: "Barn heater", kind: "heater", place: "Barn", switchable: true, state: "off", limits: { failsafe: "on" }, readings: [{ key: "air", label: "Barn temperature", measure: "temperature", base: 5, swing: 5, peakHour: 15, whenOn: 8, lowAt: 0 }] },
  { key: "propane", name: "Propane tank", kind: "tank", place: "Barn", switchable: false, state: null, limits: { failsafe: "off" }, readings: [{ key: "level", label: "Propane", measure: "percent", base: 18, lowAt: 20 }] },
  { key: "drip", name: "Garden drip line", kind: "valve", place: "Garden", switchable: true, state: "off", limits: { maxRunS: HOUR, defaultRunS: 15 * 60, presetsS: [5 * 60, 15 * 60, 30 * 60], failsafe: "off" }, readings: [] },
];

/** The sample's own devices, simulated: they switch, run on timers, and read what the day and their state would make them read. */
export class SampleDevices implements DeviceSource {
  readonly id = "sample";
  readonly #now: () => Temporal.Instant;
  readonly #timeZone: string;
  readonly #units: Units;
  readonly #state = new Map<string, { state: SwitchState | null; endsAt: Temporal.Instant | null }>();

  constructor(opts: { now: () => Temporal.Instant; timeZone: string; units: Units }) {
    this.#now = opts.now;
    this.#timeZone = opts.timeZone;
    this.#units = opts.units;
    for (const d of DEVICES) this.#state.set(d.key, { state: d.state, endsAt: null });
  }

  async list(): Promise<Device[]> {
    return DEVICES.map((d) => this.#device(d));
  }

  async set(deviceId: string, request: SwitchRequest): Promise<Device> {
    const spec = DEVICES.find((d) => `${this.id}.${d.key}` === deviceId);
    if (!spec?.switchable) throw new ToolError("That device can't be switched.");
    const s = this.#state.get(spec.key)!;
    s.state = request.state;
    s.endsAt = request.state === "on" && request.seconds ? this.#now().add({ seconds: request.seconds }) : null;
    return this.#device(spec);
  }

  #device(d: DeviceSpec): Device {
    const now = this.#now();
    const s = this.#state.get(d.key)!;
    if (s.state === "on" && s.endsAt && Temporal.Instant.compare(now, s.endsAt) >= 0) {
      s.state = "off";
      s.endsAt = null;
    }
    const hour = now.toZonedDateTimeISO(this.#timeZone);
    const h = hour.hour + hour.minute / 60;
    const readings = d.readings.map((r): Reading => {
      const raw = r.base + (r.swing ?? 0) * Math.cos((2 * Math.PI * (h - (r.peakHour ?? 15))) / 24) + (s.state === "on" ? (r.whenOn ?? 0) : 0);
      const low = r.lowAt !== undefined && raw <= r.lowAt;
      const high = r.highAt !== undefined && raw >= r.highAt;
      const [value, unit] = r.measure === "temperature" ? [fromCelsius(raw, this.#units), tempUnit(this.#units)] : [Math.round(raw), "%"];
      return { key: r.key, label: r.label, value, unit, text: readingText(value, unit), ...(low ? { low } : {}), ...(high ? { high } : {}) };
    });
    return {
      id: `${this.id}.${d.key}`,
      name: d.name,
      kind: d.kind,
      place: d.place,
      source: "Sample",
      live: false,
      switchable: d.switchable,
      state: s.state,
      run: s.state === "on" && s.endsAt ? runOf(s.endsAt.since(now).total("seconds"), now, this.#timeZone) : null,
      limits: d.limits,
      readings,
      attention: attentionOf(readings, true, d.limits, "Sample"),
      reachable: true,
    };
  }
}

// ---------- A simulated greenhouse controller ----------

/**
 * The sample greenhouse's controller, simulated in-process behind the same
 * routes and JSON as the real firmware (GET /status, POST /on?sec=N, POST
 * /off, X-Api-Key, a 1800 s cap), so the sample runs through the very
 * connector that talks to real hardware.
 */
export function simulatedController(opts: { now: () => Temporal.Instant; timeZone: string; key: string }): typeof fetch {
  const boot = opts.now();
  let valveOn = false;
  let offAt = boot;
  let lastMist: Temporal.Instant | null = null;
  const MAX_RUN_S = 1800;

  const status = () => {
    const now = opts.now();
    if (valveOn && Temporal.Instant.compare(now, offAt) >= 0) {
      valveOn = false;
      lastMist = offAt;
    }
    const local = now.toZonedDateTimeISO(opts.timeZone);
    const h = local.hour + local.minute / 60;
    // Heated: the heater holds it above 7 C overnight; the sun pushes it into the high 20s.
    const temp = Math.max(7.4, 16 + 10 * Math.cos((2 * Math.PI * (h - 14)) / 24));
    const sinceMist = valveOn ? 0 : lastMist ? now.since(lastMist).total("minutes") : Infinity;
    const humidity = Math.min(96, 34 - 8 * Math.cos((2 * Math.PI * (h - 14)) / 24) + (sinceMist < 15 ? 50 * (1 - sinceMist / 15) : 0));
    return {
      valve: valveOn ? "on" : "off",
      remaining_s: valveOn ? Math.ceil(offAt.since(now).total("seconds")) : 0,
      uptime_s: Math.floor(now.since(boot).total("seconds")),
      rssi: -61,
      climate: { temp_c: Math.round(temp * 100) / 100, humidity: Math.round(humidity * 10) / 10, pressure_hpa: 852.5, age_s: 2, ok: true },
      soil: {
        age_s: 6,
        beds: [
          { id: "s1", mv: 1640 },
          { id: "s2", mv: 1830 },
          { id: "s3", mv: 2390 },
          { id: "s4", mv: 1520 },
          { id: "s5", mv: 1700 },
        ],
      },
    };
  };
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/status" && req.method === "GET") return json(200, status());
    if ((url.pathname === "/on" || url.pathname === "/off") && req.method === "POST") {
      if (req.headers.get("x-api-key") !== opts.key) return json(401, { error: "unauthorized" });
      if (url.pathname === "/off") {
        if (valveOn) lastMist = opts.now();
        valveOn = false;
        return json(200, status());
      }
      let sec = 300;
      if (url.searchParams.has("sec")) {
        const n = Number.parseInt(url.searchParams.get("sec") ?? "", 10) || 0;
        if (n <= 0) return json(400, { error: "sec must be a positive integer" });
        sec = Math.min(n, MAX_RUN_S);
      }
      valveOn = true;
      offAt = opts.now().add({ seconds: sec });
      return json(200, status());
    }
    return json(404, { error: "not found" });
  };
}

// ---------- Simulated collars ----------

interface CollarSpec {
  collar: string;
  animal: string;
  species: string;
  home: string;
  battery: number;
  signal: TrackerFix["signal"];
  /** Where it wanders off to at night, in meters from the property's middle, for the demo. */
  night?: { x: number; y: number; signal: TrackerFix["signal"] };
}

const COLLARS: CollarSpec[] = [
  { collar: "Collar 1", animal: "Hunter", species: "dog", home: "barn", battery: 64, signal: "strong", night: { x: 255, y: 228, signal: "fair" } },
  { collar: "Collar 2", animal: "Chewy", species: "dog", home: "house", battery: 82, signal: "strong" },
  { collar: "Collar 3", animal: "Leia", species: "dog", home: "house", battery: 77, signal: "strong" },
  { collar: "Collar 4", animal: "Billie", species: "dog", home: "barn", battery: 69, signal: "strong" },
  { collar: "Collar 5", animal: "Wren", species: "dog", home: "garden", battery: 58, signal: "strong" },
  { collar: "Collar 6", animal: "Pepper", species: "dog", home: "south-pasture", battery: 55, signal: "strong", night: { x: -178, y: -74, signal: "weak" } },
  { collar: "Collar 7", animal: "Melon", species: "dog", home: "north-pasture", battery: 71, signal: "strong" },
  { collar: "Collar 8", animal: "Matilda", species: "dog", home: "house", battery: 14, signal: "fair" },
  { collar: "Collar 9", animal: "Luke", species: "dog", home: "south-pasture", battery: 47, signal: "strong" },
];

/** Night, for the demo's runaways: from 6 PM to 7 AM in the household's time zone. */
const NIGHT = { from: 18, to: 7 };

/** A repeatable number in [0, 1) for a name and a time slot. */
function noise(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Nine dogs' collars that report every couple of minutes and wander their home zones; at night two dogs are out past the fence. */
export class SampleCollars implements TrackerFeed {
  readonly name = "Sample collars (simulated)";
  readonly live = false;
  readonly #now: () => Temporal.Instant;
  readonly #timeZone: string;

  constructor(opts: { now: () => Temporal.Instant; timeZone: string }) {
    this.#now = opts.now;
    this.#timeZone = opts.timeZone;
  }

  async fixes(): Promise<TrackerFix[]> {
    const now = this.#now();
    const hour = now.toZonedDateTimeISO(this.#timeZone).hour;
    const night = hour >= NIGHT.from || hour < NIGHT.to;
    const seconds = now.epochMilliseconds / 1000;
    return COLLARS.map((c, i) => {
      const out = night && c.night;
      // Each collar reports on its own two-minute beat (ten when the signal's weak).
      const every = out && c.night!.signal === "weak" ? 600 : 120;
      const offset = i * 17;
      const at = Math.floor((seconds - offset) / every) * every + offset;
      const position = out ? this.#near({ x: c.night!.x, y: c.night!.y }, `${c.animal}:${Math.floor(at / 600)}`, 8) : this.#wander(c, at);
      // Batteries drain a little through the day.
      const day = now.toZonedDateTimeISO(this.#timeZone);
      const battery = Math.max(1, c.battery - (day.hour + day.minute / 60) * 0.15);
      return { collar: c.collar, animal: c.animal, species: c.species, battery: Math.round(battery), signal: out ? c.night!.signal : c.signal, at: Temporal.Instant.fromEpochMilliseconds(at * 1000), position };
    });
  }

  #near(p: Point, seed: string, spread: number): LatLon {
    return plane.toLatLon({ x: p.x + (noise(`${seed}x`) - 0.5) * spread, y: p.y + (noise(`${seed}y`) - 0.5) * spread });
  }

  /** Somewhere in its home zone, drifting smoothly from one five-minute spot to the next. */
  #wander(c: CollarSpec, at: number): LatLon {
    const zone = ZONES.find((z) => z.id === c.home)!.polygon.map(plane.toPoint);
    const xs = zone.map((p) => p.x);
    const ys = zone.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs) + 6, Math.max(...xs) - 6, Math.min(...ys) + 6, Math.max(...ys) - 6];
    // A zone needn't be a rectangle, so a spot in its bounding box is drawn in toward its middle until it's inside.
    const middle = labelPoint(zone);
    const within = (p: Point): Point => {
      for (let i = 0; i < 12 && !inside(p, zone); i++) p = { x: (p.x + middle.x) / 2, y: (p.y + middle.y) / 2 };
      return p;
    };
    const spot = (slot: number) => within({ x: x0 + noise(`${c.animal}:${slot}:x`) * (x1 - x0), y: y0 + noise(`${c.animal}:${slot}:y`) * (y1 - y0) });
    const slot = Math.floor(at / 300);
    const t = (at % 300) / 300;
    const a = spot(slot);
    const b = spot(slot + 1);
    return plane.toLatLon(within({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
  }
}

// ---------- The whole sample ranch ----------

export interface SampleRanchOptions {
  timeZone?: string;
  now?: () => Temporal.Instant;
  /** A real greenhouse controller on the LAN, when it's allowed; otherwise the simulated one. */
  greenhouse?: { url: string; key: string; maxRunS?: number; fetch?: typeof fetch };
  /** For the forecast. */
  fetch?: typeof fetch;
}

export function sampleRanch(opts: SampleRanchOptions = {}): Ranch {
  const config = sampleRanchConfig(opts.timeZone);
  const now = opts.now ?? clockNow;
  const real = opts.greenhouse;
  const key = real?.key ?? "sample-greenhouse";
  const greenhouse = new GreenhouseController({
    url: real?.url ?? "http://greenhouse.sample",
    key,
    // A real controller's beds aren't calibrated yet, so they read raw millivolts rather than made-up percentages.
    config: real ? { ...SAMPLE_GREENHOUSE, calibration: undefined, limits: { ...SAMPLE_GREENHOUSE.limits, ...(real.maxRunS ? { maxRunS: real.maxRunS } : {}) } } : SAMPLE_GREENHOUSE,
    units: config.units,
    timeZone: config.timeZone,
    live: Boolean(real),
    fetch: real ? real.fetch : simulatedController({ now, timeZone: config.timeZone, key }),
    now,
  });
  return new Ranch({
    config,
    sources: [greenhouse, new SampleDevices({ now, timeZone: config.timeZone, units: config.units })],
    trackers: new SampleCollars({ now, timeZone: config.timeZone }),
    now,
    fetch: opts.fetch,
    history: true,
  });
}

/**
 * One sample ranch per holder (a household's Durable Object, or this isolate),
 * kept so a run started on the misters is still counting down on the next call,
 * from either Echo Show. It's built again when the time zone or the local
 * greenhouse connector changes: under `pnpm dev:lan` the greenhouse is a real
 * controller on the LAN instead of the simulated one.
 */
export class SampleRanchHolder {
  #held: { key: string; ranch: Ranch } | undefined;

  /** The ranch, on the household's clock when it has its own. */
  ranchFor(env: GreenhouseEnv, requestUrl: string, timeZone: string | undefined, now?: () => Temporal.Instant): Ranch {
    const greenhouse = localGreenhouse(env, requestUrl);
    const key = JSON.stringify([timeZone, greenhouse]);
    if (!this.#held || this.#held.key !== key) this.#held = { key, ranch: sampleRanch({ timeZone, ...(greenhouse ? { greenhouse } : {}), ...(now ? { now } : {}) }) };
    return this.#held.ranch;
  }

  /** Starts the ranch over with the household: every device back to how the day began. */
  reset() {
    this.#held = undefined;
  }
}
