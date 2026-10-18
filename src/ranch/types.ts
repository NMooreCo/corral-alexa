import type { Temporal } from "temporal-polyfill";

/**
 * The ranch's generic shapes. Devices, readings, limits, trackers and the
 * property map are all data: a household's configuration says what its
 * devices are called, what they read and how far they may be pushed, and the
 * code below never has a path for one building or one animal.
 */

/** "us" says °F, mph and inches; "metric" says °C, km/h and millimeters. */
export type Units = "us" | "metric";

export type SwitchState = "on" | "off";

/** One thing a device measures, said both as a number and in words. */
export interface Reading {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  /** For people: "38°F", "18%", "2,720 mV". */
  text: string;
  low?: boolean;
  high?: boolean;
  /** The reading itself is suspect: a wiring fault, a sensor that stopped answering. */
  fault?: string;
}

/** How far a device may be pushed. Every number here is configuration, never code. */
export interface DeviceLimits {
  /** A run can't be longer than this, and switching it on always sets a run: it never stays on without an end. */
  maxRunS?: number;
  /** How long it runs when switched on without a length. */
  defaultRunS?: number;
  /** Run lengths the screen offers as one-tap buttons. */
  presetsS?: number[];
  /**
   * What it does on its own if its controller fails or loses its connection:
   * "off" (a valve closes) or "on" (a heater keeps heating, so water and
   * animals don't freeze).
   */
  failsafe: SwitchState;
}

/** A timed run in progress. */
export interface DeviceRun {
  secondsLeft: number;
  /** When it ends, as an instant, so a screen can count down on its own. */
  endsAt: string;
  /** "6:42 PM". */
  endsLabel: string;
}

export interface Device {
  /** Stable, like "greenhouse.valve1" or "sample.tank-heater-horses". */
  id: string;
  name: string;
  /** A word for what it is ("valve", "heater", "lamp", "sensor", "tank"). Screens use it for an icon; nothing branches on it. */
  kind: string;
  /** Where it is, like "Greenhouse" or "Barn". */
  place: string;
  /** Who reports it, like "Greenhouse controller" or "Sample". */
  source: string;
  /** True when it's real hardware answering right now, false when it's simulated. */
  live: boolean;
  switchable: boolean;
  /** Null for a sensor, or when its controller can't be reached. */
  state: SwitchState | null;
  run: DeviceRun | null;
  limits: DeviceLimits;
  readings: Reading[];
  /** What needs a person's attention, in words. Empty when all's well. */
  attention: string[];
  reachable: boolean;
  /** Anything else worth knowing about how to read it. */
  note?: string;
}

/** A switch request after its limits are checked: on for a set run, on with no end, or off. */
export type SwitchRequest = { state: "on"; seconds: number | null } | { state: "off" };

/** Where devices come from: a simulation, or a connector to real hardware. */
export interface DeviceSource {
  readonly id: string;
  /** Every device this source has, reachable or not. Never throws for an unreachable controller: its devices say so. */
  list(): Promise<Device[]>;
  /** Switches one device and answers its new state. Throws ToolError with a sentence for people when it can't. */
  set(deviceId: string, request: SwitchRequest): Promise<Device>;
}

// ---------- The property map ----------

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface Zone {
  id: string;
  name: string;
  /** A hint for how a map draws it: "field", "structure" or "yard". */
  style: string;
  polygon: LatLon[];
}

export interface PropertyMap {
  /** The fence line, as a closed polygon (the last point joins the first). */
  fence: LatLon[];
  zones: Zone[];
}

// ---------- Trackers (GPS collars) ----------

/** One collar's latest fix, as a feed reports it. */
export interface TrackerFix {
  collar: string;
  animal: string;
  species: string;
  /** Percent. */
  battery: number;
  signal: "strong" | "fair" | "weak" | "none";
  at: Temporal.Instant;
  position: LatLon;
}

/** Where collar fixes come from: a simulation now, a real collar feed later. */
export interface TrackerFeed {
  /** Like "Sample collars" or a vendor's name. */
  readonly name: string;
  readonly live: boolean;
  fixes(): Promise<TrackerFix[]>;
}

// ---------- The ranch's configuration ----------

export interface RanchLocation extends LatLon {
  name: string;
  /** For the forecast's downscaling; a mountain ranch is colder than the valley grid cell. */
  elevationM: number;
}

export interface RanchConfig {
  location: RanchLocation;
  timeZone: string;
  units: Units;
  property: PropertyMap;
  /** At or below this collar battery percent, it's low. */
  lowBatteryAt: number;
  /** A collar fix older than this many minutes is stale. */
  staleFixMinutes: number;
  /** Places that get their own card in the morning briefing, like "Greenhouse". */
  briefingPlaces: string[];
}
