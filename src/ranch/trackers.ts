import type { Temporal } from "temporal-polyfill";
import { ToolError } from "../household.ts";
import { propertyPlane } from "./geo.ts";
import type { LatLon, RanchConfig, TrackerFeed, TrackerFix } from "./types.ts";
import { ago, clockAt, num } from "./words.ts";

/**
 * Where each collared animal is, from any collar feed, placed on the
 * household's own property map: inside the fence or not, which zone, how far
 * out and which way, with the collar's battery and signal.
 */

export interface AnimalReport {
  animal: string;
  species: string;
  collar: string;
  battery: string;
  batteryValue: number;
  batteryLow: boolean;
  signal: TrackerFix["signal"];
  lastSeen: string;
  lastSeenAt: string;
  /** Its last fix is older than the household's limit, so where it is now is a guess. */
  stale: boolean;
  insideFence: boolean;
  zone: string | null;
  /** Outside the fence: "about 260 ft northeast of the fence, nearest the North pasture". */
  outside?: { distance: string; meters: number; direction: string; nearestZone: string | null; words: string };
  position: LatLon;
}

export interface TrackerReport {
  feed: string;
  live: boolean;
  animals: AnimalReport[];
  /** Names, for a quick answer. */
  outsideFence: string[];
  lowBattery: string[];
  stale: string[];
}

function distanceWords(meters: number, units: RanchConfig["units"]): string {
  if (units === "us") {
    const feet = meters * 3.28084;
    return feet >= 1000 ? `about ${num(Math.round((feet / 5280) * 10) / 10)} miles` : `about ${num(Math.max(10, Math.round(feet / 10) * 10))} ft`;
  }
  return meters >= 1000 ? `about ${num(Math.round(meters / 100) / 10)} km` : `about ${num(Math.max(5, Math.round(meters / 5) * 5))} m`;
}

export async function trackerReport(feed: TrackerFeed, config: RanchConfig, now: Temporal.Instant, animal?: unknown): Promise<TrackerReport> {
  const plane = propertyPlane(config.property);
  let fixes = await feed.fixes();
  if (typeof animal === "string" && animal.trim()) {
    const said = animal.trim().toLowerCase();
    const singular = said.replace(/(?<!s)s$/, "");
    const named = fixes.filter((f) => f.animal.toLowerCase() === said);
    const kind = fixes.filter((f) => f.species.toLowerCase() === said || f.species.toLowerCase() === singular);
    fixes = named.length ? named : kind;
    if (!fixes.length) throw new ToolError(`No collar is on an animal called "${animal}". Collared: ${(await feed.fixes()).map((f) => f.animal).join(", ")}.`);
  }
  const animals = fixes.map((f): AnimalReport => {
    const age = now.since(f.at).total("seconds");
    const where = plane.place(f.position);
    return {
      animal: f.animal,
      species: f.species,
      collar: f.collar,
      battery: `${Math.round(f.battery)}%`,
      batteryValue: Math.round(f.battery),
      batteryLow: f.battery <= config.lowBatteryAt,
      signal: f.signal,
      lastSeen: ago(age),
      lastSeenAt: clockAt(f.at, config.timeZone),
      stale: age > config.staleFixMinutes * 60,
      insideFence: where.insideFence,
      zone: where.zone,
      ...(where.outside
        ? {
            outside: {
              distance: distanceWords(where.outside.meters, config.units),
              meters: where.outside.meters,
              direction: where.outside.direction,
              nearestZone: where.outside.nearestZone,
              words: `${distanceWords(where.outside.meters, config.units)} outside the fence to the ${where.outside.direction}${where.outside.nearestZone ? `, nearest the ${where.outside.nearestZone}` : ""}`,
            },
          }
        : {}),
      position: f.position,
    };
  });
  return {
    feed: feed.name,
    live: feed.live,
    animals,
    outsideFence: animals.filter((a) => !a.insideFence).map((a) => a.animal),
    lowBattery: animals.filter((a) => a.batteryLow).map((a) => a.animal),
    stale: animals.filter((a) => a.stale).map((a) => a.animal),
  };
}
