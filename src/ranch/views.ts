import { Temporal } from "temporal-polyfill";
import { ToolError, type CorralEvent, type CorralSupply, type CorralTask, type CorralWhere, type Household } from "../household.ts";
import { labelPoint, mapFrame, pathOf, propertyPlane } from "./geo.ts";
import type { Ranch } from "./index.ts";
import type { AnimalReport, TrackerReport } from "./trackers.ts";
import type { Device } from "./types.ts";
import type { Forecast } from "./weather.ts";
import { duration, num } from "./words.ts";
import type { AutomationView } from "./automations.ts";

/** The Ranch screen and the morning briefing: what each shows, made from the same tools the assistant uses. */

export const RANCH_URI = "ui://corral/ranch.html";
export const BRIEFING_URI = "ui://corral/briefing.html";

export interface MapPin {
  animal: string;
  species: string;
  x: number;
  y: number;
  battery: number;
  batteryLow: boolean;
  outside: boolean;
  zone: string | null;
  lastSeen: string;
  stale: boolean;
  /** Too far out to draw where it is, so it's pinned at the map's edge in its direction. */
  atEdge: boolean;
  where: string;
}

export interface RanchView {
  household: string | null;
  /** When this was made, so the screen counts runs down from the same moment. */
  at: string;
  weather: { now: string; conditions: string; tonight: string; freeze: boolean } | null;
  map: {
    width: number;
    height: number;
    fence: string;
    zones: { name: string; style: string; d: string; x: number; y: number }[];
    pins: MapPin[];
    scale: { label: string; length: number };
  };
  places: { name: string; devices: Device[] }[];
  animals: { feed: string; live: boolean; outside: string[]; lowBattery: string[] };
  /** How many things need attention, across devices and animals. */
  attention: number;
  automations: AutomationView[];
  /** Which part of the screen to open on, when the tool that showed it says. */
  tab?: RanchTab;
}

/** The ranch's parts, each a tab on the screen. */
export type RanchTab = "ranch" | "animals" | "automations";

/** A part a screen can do without (the forecast, say) is left out rather than failing the screen. */
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ToolError) return null;
    throw err;
  }
}

/** A screen waits this long for a cold forecast, then goes up without it; the fetch still fills the cache for next time. */
const WEATHER_WAIT_MS = 2500;
/** Devices switched together, said once: "Horse tank heater, goat tank heater and barn heater on; coop heat lamp on for 12 hours, until 8:17 AM". */
function switchedTogether(texts: string[]): string {
  const plain = (state: string) => texts.filter((t) => t.endsWith(` ${state}`)).map((t) => t.slice(0, -state.length - 1));
  const names = (list: string[]) => list.map((n, i) => (i ? n.charAt(0).toLowerCase() + n.slice(1) : n));
  const together = (list: string[]) => (list.length > 1 ? `${names(list).slice(0, -1).join(", ")} and ${names(list).at(-1)}` : list[0]!);
  const on = plain("on");
  const off = plain("off");
  const rest = texts.filter((t) => !t.endsWith(" on") && !t.endsWith(" off"));
  const parts = [...(on.length ? [`${together(on)} on`] : []), ...(off.length ? [`${together(off)} off`] : []), ...rest.map((t, i) => (on.length || off.length || i ? t.charAt(0).toLowerCase() + t.slice(1) : t))];
  return parts.join("; ");
}

/** The morning briefing's "since last night" starts at this hour the evening before. */
const OVERNIGHT_FROM = "18:00";
const MAX_OVERNIGHT_LINES = 6;

/**
 * `p`, or "Not yet." once `ms` pass without it. The timer goes as soon as
 * either comes, so it never holds a Worker's request open after its answer.
 */
export function soon<T>(p: Promise<T>, ms = WEATHER_WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError("Not yet.")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Places in a stable order: the ones the household puts first, then as their devices come. */
function byPlace(devices: Device[], first: string[]): { name: string; devices: Device[] }[] {
  const names = [...new Set([...first.filter((p) => devices.some((d) => d.place === p)), ...devices.map((d) => d.place)])];
  return names.map((name) => ({ name, devices: devices.filter((d) => d.place === name) }));
}

/** A round scale-bar length that's about a fifth of the map across. */
function scaleBar(widthUnits: number, metersPerUnit: number, units: "us" | "metric"): { label: string; length: number } {
  const target = (widthUnits * metersPerUnit) / 5;
  if (units === "us") {
    const feet = [50, 100, 200, 300, 500, 1000, 2000].reduce((best, f) => (Math.abs(f / 3.28084 - target) < Math.abs(best / 3.28084 - target) ? f : best));
    return { label: `${num(feet)} ft`, length: Math.round(feet / 3.28084 / metersPerUnit) };
  }
  const m = [20, 50, 100, 200, 500, 1000].reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best));
  return { label: `${num(m)} m`, length: Math.round(m / metersPerUnit) };
}

export function drawMap(ranch: Ranch, report: TrackerReport | null): RanchView["map"] {
  const { property, units } = ranch.config;
  const animals = report?.animals ?? [];
  const frame = mapFrame(property, animals.map((a) => a.position));
  const plane = propertyPlane(property);
  // Each zone's name sits along its top edge, where it's least likely to sit under a pin.
  const zones = plane.zones.map((z) => {
    const corners = z.polygon.map((p) => frame.draw(p));
    const mid = frame.draw(plane.plane.toLatLon(labelPoint(z.polygon.map(plane.plane.toPoint))));
    return { name: z.name, style: z.style, d: pathOf(frame, z.polygon), x: mid.x, y: Math.min(...corners.map((c) => c.y)) + 22 };
  });
  const pins = animals.map((a: AnimalReport): MapPin => {
    const p = frame.draw(a.position);
    const atEdge = !frame.covers(a.position);
    return {
      animal: a.animal,
      species: a.species,
      x: Math.max(12, Math.min(frame.width - 12, p.x)),
      y: Math.max(12, Math.min(frame.height - 12, p.y)),
      battery: a.batteryValue,
      batteryLow: a.batteryLow,
      outside: !a.insideFence,
      zone: a.zone,
      lastSeen: a.lastSeen,
      stale: a.stale,
      atEdge,
      where: a.outside ? a.outside.words : (a.zone ?? "Inside the fence"),
    };
  });
  return { width: frame.width, height: frame.height, fence: pathOf(frame, property.fence), zones, pins, scale: scaleBar(frame.width, frame.metersPerUnit, units) };
}

export async function ranchView(ranch: Ranch, household: Household, tab?: RanchTab): Promise<RanchView> {
  // Every source is read at once: the devices and automations alongside anything due (and again if it ran, so the screen shows what it did), the rest without waiting on it.
  const [about, [devices, automations], report, weather] = await Promise.all([
    household.about(),
    ranch.look(() => Promise.all([ranch.devices.all(), ranch.automations.list()])),
    optional(ranch.animals()),
    optional(soon(ranch.weather())),
  ]);
  const attention = devices.filter((d) => d.attention.length).length + (report ? report.outsideFence.length + report.lowBattery.length : 0);
  return {
    household: about.name ?? null,
    at: ranch.now().toString(),
    weather: weather?.now
      ? { now: weather.now.temperature, conditions: weather.now.conditions, tonight: `Low ${weather.tonight.low} tonight`, freeze: weather.tonight.freeze }
      : weather
        ? { now: weather.today.high, conditions: weather.today.conditions, tonight: `Low ${weather.tonight.low} tonight`, freeze: weather.tonight.freeze }
        : null,
    map: drawMap(ranch, report),
    places: byPlace(devices, ranch.config.briefingPlaces),
    animals: report ? { feed: report.feed, live: report.live, outside: report.outsideFence, lowBattery: report.lowBattery } : { feed: "No collar feed", live: false, outside: [], lowBattery: [] },
    attention,
    automations,
    ...(tab ? { tab } : {}),
  };
}

/** What the assistant hears when the Ranch screen goes up: the gist, not the drawing. */
export function ranchSummary(view: RanchView) {
  const all = view.places.flatMap((p) => p.devices);
  return {
    shown:
      view.tab === "automations"
        ? "The Ranch screen, on its Automations tab: each automation, on or off, with what it does and when it next runs."
        : view.tab === "animals"
          ? "The Ranch screen, on its Animals tab: the property map large, and each collar with where it is and its battery."
          : "The Ranch screen: every device by place, and how the animals are. Its tabs also show the animals on the property map, and the automations.",
    weather: view.weather,
    outsideFence: view.animals.outside,
    lowCollarBattery: view.animals.lowBattery,
    running: all.filter((d) => d.run).map((d) => `${d.name}: ${duration(d.run!.secondsLeft)} left, until ${d.run!.endsLabel}`),
    on: all.filter((d) => d.state === "on" && !d.run).map((d) => d.name),
    needsAttention: all.flatMap((d) => d.attention.map((a) => `${d.name}: ${a}`)),
    automations: view.automations.map((a) => `${a.name} (${a.enabled ? "on" : "off"}): ${a.when}`),
  };
}

// ---------- The morning briefing ----------

export interface BriefingCard {
  id: string;
  title: string;
  headline: string;
  lines: { text: string; warn?: boolean }[];
  warn: boolean;
}

export interface BriefingView {
  household: string | null;
  greeting: string;
  date: string;
  cards: BriefingCard[];
}

/** "Good morning" before noon, and so on, in the household's own time. */
function greeting(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

const list = <T>(p: Promise<unknown>) => optional(p).then((v) => (Array.isArray(v) ? (v as T[]) : []));

/** A day as people say it from `today`: "today", "tomorrow", "Tuesday" within the week, else "Mon, Nov 2". */
function dayName(date: string, today: Temporal.PlainDate): string {
  const day = Temporal.PlainDate.from(date);
  const days = today.until(day).days;
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return day.toLocaleString("en-US", days < 7 ? { weekday: "long" } : { weekday: "short", month: "short", day: "numeric" });
}

/** Today's label prefix ("Sat, Oct 17, ") off a Corral time, leaving "10:00 AM to 11:00 AM". */
function timeOf(when: string, today: string): string {
  if (when.endsWith("(all day)")) return "All day";
  return when.startsWith(`${today}, `) ? when.slice(today.length + 2) : when;
}

export async function briefingView(household: Household, ranch: Ranch): Promise<BriefingView> {
  const tz = ranch.config.timeZone;
  const local = ranch.now().toZonedDateTimeISO(tz);
  const todayLabel = local.toPlainDate().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
  // In the morning, the briefing starts with what happened since 6 PM yesterday.
  const since = local.hour < 12 ? local.toPlainDate().subtract({ days: 1 }).toZonedDateTime({ timeZone: tz, plainTime: Temporal.PlainTime.from(OVERNIGHT_FROM) }).toInstant() : null;
  const [about, events, tasks, where, supplies, weather, devices, report, history] = await Promise.all([
    household.about(),
    list<CorralEvent>(household.call("calendar", {})),
    list<CorralTask>(household.call("tasks", {})),
    list<CorralWhere>(household.call("whereabouts", {})),
    list<CorralSupply>(household.call("supplies", {})),
    optional<Forecast>(soon(ranch.weather())),
    ranch.devices.all(),
    optional(ranch.animals()),
    since ? optional(household.history?.(since) ?? Promise.resolve([])) : Promise.resolve(null),
  ]);

  const cards: BriefingCard[] = [];

  // In the morning, what happened since 6 PM yesterday: devices switched, automations, orders, chores, requests decided.
  if (since) {
    const told = history ?? [];
    const happened = [
      ...told.map((h) => ({ at: Temporal.ZonedDateTime.from(h.at).toInstant(), texts: [h.text], device: false })),
      ...ranch.history(since).map((h) => ({ at: h.at, texts: [h.text], device: h.kind === "device" })),
    ].sort((a, b) => Temporal.Instant.compare(a.at, b.at));
    // Devices switched within a minute of each other (heaters turned on together, say) share a line.
    const groups: typeof happened = [];
    for (const h of happened) {
      const last = groups.at(-1);
      if (last?.device && h.device && h.at.since(last.at).total("seconds") < 60) last.texts.push(...h.texts);
      else groups.push({ ...h, texts: [...h.texts] });
    }
    const lines = groups.map((g) => ({ at: g.at, text: g.device ? switchedTogether(g.texts) : g.texts.join("; ") }));
    if (lines.length) {
      const clock = (at: Temporal.Instant) => at.toZonedDateTimeISO(tz).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
      cards.push({
        id: "overnight",
        title: "Since last night",
        headline: `${happened.length} thing${happened.length === 1 ? "" : "s"} since ${clock(since)} yesterday`,
        lines: lines.slice(-MAX_OVERNIGHT_LINES).map((l) => ({ text: `${clock(l.at)}: ${l.text}` })),
        warn: false,
      });
    }
  }

  // Today at a glance.
  const away = where.filter((w) => w.location !== "Home");
  cards.push({
    id: "today",
    title: "Today",
    headline: events.length ? `${events.length} on the calendar${events[0] ? `, first ${timeOf(events[0].when, todayLabel).split(" to ")[0]}` : ""}` : "Nothing on the calendar",
    lines: [
      ...events.slice(0, 4).map((e) => ({ text: `${timeOf(e.when, todayLabel).split(" to ")[0]}: ${e.event ? e.title : "Busy"}${e.drivers.length ? ` (${e.drivers.map((d) => d.split(" ")[0]).join(" and ")} drives)` : ""}` })),
      ...(events.length > 4 ? [{ text: `And ${events.length - 4} more` }] : []),
      ...(away.length ? [{ text: `Away: ${away.map((w) => `${w.name.split(" ")[0]} (${w.location})`).join(", ")}` }] : []),
    ],
    warn: false,
  });

  // Weather.
  if (weather) {
    const t = weather.tonight;
    cards.push({
      id: "weather",
      title: "Weather",
      headline: `${weather.today.conditions}, high ${weather.today.high}. Low ${t.low} tonight${t.hardFreeze ? ": hard freeze" : t.freeze ? ": freezing" : ""}.`,
      lines: [
        ...(weather.now ? [{ text: `Now ${weather.now.temperature}, feels like ${weather.now.feelsLike}. Wind ${weather.now.wind}.` }] : []),
        ...(t.freeze ? [{ text: `Freeze tonight: down to ${t.low}${t.lowestAround ? ` around ${t.lowestAround}` : ""}.`, warn: true }] : []),
        { text: `Precipitation: ${weather.today.precipitation}${weather.today.snow ? `, ${weather.today.snow} of snow` : ""}.` },
        ...weather.days.slice(0, 3).map((d) => ({ text: `${d.label.split(",")[0]}: ${d.conditions.toLowerCase()}, ${d.high} and ${d.low}${d.snow ? `, ${d.snow} snow` : ""}`, ...(d.freeze ? { warn: true } : {}) })),
        ...(weather.stale ? [{ text: weather.stale }] : []),
      ],
      warn: t.freeze,
    });
  } else {
    cards.push({ id: "weather", title: "Weather", headline: "The forecast isn't reachable right now.", lines: [], warn: false });
  }

  // Late chores.
  const late = tasks.filter((t) => t.status === "overdue");
  const open = tasks.filter((t) => t.status === "open");
  cards.push({
    id: "chores",
    title: "Chores",
    headline: late.length ? `${late.length} late` : "Nothing late",
    lines: [
      ...late.slice(0, 4).map((t) => ({ text: `${t.title}: ${t.assignees[0] === "anyone" ? "anyone" : t.assignees.map((a) => a.split(" ")[0]).join(" and ")}, due ${timeOf(t.due, todayLabel)}`, warn: true })),
      ...(open.length ? [{ text: `${open.length} more still to do today` }] : []),
    ],
    warn: late.length > 0,
  });

  // Low supplies. One that's on order, or on a list, is taken care of.
  const low = supplies.filter((s) => s.low);
  const handled = (s: CorralSupply) => Boolean(s.onList || s.onOrder?.arrivesOn);
  const status = (s: CorralSupply) =>
    s.onOrder?.arrivesOn ? ` (on order, arrives ${dayName(s.onOrder.arrivesOn, local.toPlainDate())})` : s.onOrder ? ` (ordered, waiting for ${s.onOrder.waitingFor ?? "a yes"})` : s.onList ? ` (on ${s.onList})` : " (not on a list)";
  cards.push({
    id: "supplies",
    title: "Supplies",
    headline: low.length ? `${low.length} running low` : "Nothing running low",
    lines: low.map((s) => ({ text: `${s.name}: ${s.onHand}${s.daysLeft !== undefined ? `, about ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"}` : ""}${status(s)}`, warn: !handled(s) })),
    warn: low.some((s) => !handled(s)),
  });

  // Animals.
  if (report) {
    const outside = report.animals.filter((a) => !a.insideFence);
    const lowBattery = report.animals.filter((a) => a.batteryLow);
    cards.push({
      id: "animals",
      title: "Animals",
      headline: outside.length ? `${outside.map((a) => a.animal).join(" and ")} ${outside.length === 1 ? "is" : "are"} outside the fence` : `All ${report.animals.length} inside the fence`,
      lines: [
        ...outside.map((a) => ({ text: `${a.animal}: ${a.outside?.words ?? "outside the fence"}, seen ${a.lastSeen}`, warn: true })),
        ...lowBattery.map((a) => ({ text: `${a.animal}'s collar battery is at ${a.battery}`, warn: true })),
        ...report.animals.filter((a) => a.stale).map((a) => ({ text: `${a.animal}'s collar last reported ${a.lastSeen}`, warn: true })),
        ...(outside.length || lowBattery.length ? [] : [{ text: "Every collar is reporting and charged." }]),
      ],
      warn: outside.length > 0 || lowBattery.length > 0,
    });
  }

  // A card for each place the household wants in its briefing (its greenhouse, say).
  for (const place of ranch.config.briefingPlaces) {
    const here = devices.filter((d) => d.place === place);
    if (!here.length) continue;
    const lines = here.flatMap((d) => {
      if (!d.reachable) return [{ text: `${d.name}: not answering`, warn: true }];
      if (d.switchable) return [{ text: `${d.name}: ${d.run ? `running, ${duration(d.run.secondsLeft)} left` : d.state}${d.readings.length ? ` (${d.readings.map((r) => `${r.label.toLowerCase()} ${r.text}`).join(", ")})` : ""}` }];
      const flagged = d.readings.filter((r) => r.low || r.high || r.fault);
      if (d.readings.length > 3) return [{ text: `${d.name}: ${flagged.length ? flagged.map((r) => `${r.label} ${r.fault ? r.fault : `${r.low ? "low" : "high"} at ${r.text}`}`).join(", ") : "all within range"}`, ...(flagged.length ? { warn: true } : {}) }];
      return [{ text: `${d.name}: ${d.readings.map((r) => `${r.label.toLowerCase()} ${r.text}`).join(", ")}`, ...(flagged.length ? { warn: true } : {}) }];
    });
    cards.push({
      id: `place:${place}`,
      title: place,
      headline: here.some((d) => d.attention.length) ? `${here.filter((d) => d.attention.length).length} thing${here.filter((d) => d.attention.length).length === 1 ? "" : "s"} to look at` : "All good",
      lines,
      warn: here.some((d) => d.attention.length > 0),
    });
  }

  // Everything else that needs attention.
  const flagged = devices.filter((d) => d.attention.length && !ranch.config.briefingPlaces.includes(d.place));
  cards.push({
    id: "devices",
    title: "Devices",
    headline: flagged.length ? `${flagged.length} need${flagged.length === 1 ? "s" : ""} attention` : "Nothing needs attention",
    lines: [
      ...flagged.flatMap((d) => d.attention.map((a) => ({ text: `${d.name}: ${a}`, warn: true }))),
      ...devices.filter((d) => d.run && !ranch.config.briefingPlaces.includes(d.place)).map((d) => ({ text: `${d.name} running, ${duration(d.run!.secondsLeft)} left` })),
    ],
    warn: flagged.length > 0,
  });

  return {
    household: about.name ?? null,
    greeting: greeting(local.hour),
    date: local.toPlainDate().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    cards,
  };
}
