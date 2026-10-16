import { Temporal } from "temporal-polyfill";
import type { CorralAsk } from "../household.ts";

/**
 * The sample household: a made-up family ranch with two parents, two kids and
 * a farm hand. Everything is laid out around today, so it always looks
 * current. None of it is a real family.
 */

export interface SamplePerson {
  id: string;
  name: string;
  shortName: string;
  roles: string[];
}

export interface SampleEvent {
  id: string;
  title: string;
  /** Zoned, or a date for all day. */
  start: string;
  end: string;
  people: string[];
  drivers: string[];
  location: string | null;
  calendar: string;
  /** Kept private by its owner: everyone else sees only that the time is taken. */
  private?: boolean;
}

export interface SampleTask {
  id: string;
  title: string;
  /** Zoned, or a date when it's due any time that day. */
  due: string;
  /** Person ids, or "anyone" when it's up for grabs. */
  assignees: string[] | "anyone";
  status: "open" | "done" | "skipped";
  doneBy: string | null;
  asks?: CorralAsk[];
  captured?: Record<string, unknown>;
}

export interface SampleListItem {
  text: string;
  quantity: string | null;
  done: boolean;
  /** False while it waits for a parent to say yes. */
  approved: boolean;
}

export interface SampleList {
  name: string;
  items: SampleListItem[];
}

export interface SampleSupply {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  /** How much goes in a day, for when it runs out. */
  perDay: number;
  /** At or below this, it's low. */
  lowAt: number;
  onList: string | null;
}

/** Where someone is from one instant to the next. */
export interface SampleStay {
  person: string;
  location: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
}

export interface SampleBalance {
  person: string;
  points: number;
  allowanceCents: number;
}

export interface SampleState {
  name: string;
  timeZone: string;
  /** Who this sample acts as: a shared screen in the kitchen, which sees what the household's adults see. */
  actingAs: string;
  /** Who approves a change made from a shared screen. */
  approvers: string[];
  people: SamplePerson[];
  events: SampleEvent[];
  tasks: SampleTask[];
  lists: SampleList[];
  supplies: SampleSupply[];
  stays: SampleStay[];
  balances: SampleBalance[];
  /** "100 points make $5.00 of allowance". */
  pointsPerFiveDollars: number;
  /** Changes waiting for a parent, by request id. */
  requests: { id: string; summary: string }[];
}

export function seed(now: Temporal.Instant, timeZone = "America/Denver"): SampleState {
  const id = () => crypto.randomUUID();
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  const weekday = today.dayOfWeek <= 5;
  const date = (day: number) => today.add({ days: day }).toString();
  const at = (day: number, time: string) => today.add({ days: day }).toZonedDateTime({ timeZone, plainTime: Temporal.PlainTime.from(time) }).toString();
  const instant = (day: number, time: string) => Temporal.ZonedDateTime.from(at(day, time)).toInstant();

  const sam = { id: id(), name: "Sam Rivera", shortName: "Sam", roles: ["Parent"] };
  const alex = { id: id(), name: "Alex Rivera", shortName: "Alex", roles: ["Parent"] };
  const maya = { id: id(), name: "Maya Rivera", shortName: "Maya", roles: ["Kid"] };
  const leo = { id: id(), name: "Leo Rivera", shortName: "Leo", roles: ["Kid"] };
  const jordan = { id: id(), name: "Jordan Blake", shortName: "Jordan", roles: ["Farm hand"] };

  const events: SampleEvent[] = [
    ...(weekday ? [{ id: id(), title: "School drop-off", start: at(0, "07:40"), end: at(0, "08:00"), people: [maya.id, leo.id], drivers: [alex.id], location: "Juniper Elementary", calendar: "School" }] : []),
    { id: id(), title: "Farrier visit", start: at(0, "10:00"), end: at(0, "11:00"), people: [jordan.id], drivers: [], location: "Barn", calendar: "Ranch" },
    { id: id(), title: "Birthday gift shopping", start: at(0, "12:00"), end: at(0, "13:00"), people: [sam.id], drivers: [], location: "Downtown", calendar: "Family", private: true },
    { id: id(), title: "Soccer practice", start: at(0, "15:30"), end: at(0, "16:45"), people: [maya.id], drivers: [sam.id], location: "Riverside Fields", calendar: "Family" },
    { id: id(), title: "Family movie night", start: at(0, "18:30"), end: at(0, "20:30"), people: [], drivers: [], location: "Home", calendar: "Family" },
    { id: id(), title: "Biscuit's vet checkup", start: at(1, "09:00"), end: at(1, "09:30"), people: [alex.id], drivers: [alex.id], location: "Valley Vet", calendar: "Family" },
    { id: id(), title: "Piano lesson", start: at(1, "16:00"), end: at(1, "16:45"), people: [leo.id], drivers: [sam.id], location: "Ms. Okafor's", calendar: "Family" },
    { id: id(), title: "Hay delivery", start: date(2), end: date(2), people: [jordan.id], drivers: [], location: "Barn", calendar: "Ranch" },
    { id: id(), title: "Science fair", start: at(3, "18:00"), end: at(3, "19:30"), people: [maya.id, sam.id, alex.id], drivers: [alex.id], location: "Juniper Elementary", calendar: "School" },
  ];

  const tasks: SampleTask[] = [
    { id: id(), title: "Feed the horses (morning)", due: at(0, "07:00"), assignees: [jordan.id], status: "done", doneBy: jordan.id, asks: [{ key: "fed", label: "Amount fed", type: "quantity", unit: "lb" }] },
    { id: id(), title: "Give Biscuit her allergy pill", due: at(0, "08:00"), assignees: [maya.id], status: "open", doneBy: null },
    { id: id(), title: "Collect eggs", due: at(0, "09:00"), assignees: "anyone", status: "open", doneBy: null, asks: [{ key: "eggs", label: "Eggs", type: "number" }] },
    { id: id(), title: "Water the garden", due: date(0), assignees: "anyone", status: "open", doneBy: null },
    { id: id(), title: "Empty the dishwasher", due: at(0, "17:00"), assignees: [leo.id], status: "open", doneBy: null },
    { id: id(), title: "Feed the horses (evening)", due: at(0, "17:30"), assignees: [jordan.id], status: "open", doneBy: null, asks: [{ key: "fed", label: "Amount fed", type: "quantity", unit: "lb" }] },
    { id: id(), title: "Take out the trash", due: at(0, "19:00"), assignees: [leo.id, maya.id], status: "open", doneBy: null },
    { id: id(), title: "Clean the chicken coop", due: at(1, "10:00"), assignees: [jordan.id], status: "open", doneBy: null },
  ];

  const lists: SampleList[] = [
    {
      name: "Groceries",
      items: [
        { text: "Milk", quantity: "2 gallons", done: false, approved: true },
        { text: "Tortillas", quantity: null, done: false, approved: true },
        { text: "Bananas", quantity: null, done: false, approved: true },
        { text: "Coffee", quantity: null, done: false, approved: true },
        { text: "Ice cream", quantity: null, done: false, approved: false },
      ],
    },
    {
      name: "Feed store",
      items: [
        { text: "Mineral block", quantity: "2", done: false, approved: true },
        { text: "Layer pellets", quantity: "1 bag", done: false, approved: true },
        { text: "Fly spray", quantity: null, done: false, approved: true },
      ],
    },
    { name: "Hardware", items: [{ text: "Fence staples", quantity: null, done: false, approved: true }] },
  ];

  const supplies: SampleSupply[] = [
    { id: id(), name: "Horse feed", quantity: 6, unit: "bag", perDay: 0.66, lowAt: 2, onList: null },
    { id: id(), name: "Hay", quantity: 46, unit: "bale", perDay: 2, lowAt: 10, onList: null },
    { id: id(), name: "Dog food", quantity: 4, unit: "lb", perDay: 1.25, lowAt: 5, onList: null },
    { id: id(), name: "Layer pellets", quantity: 1, unit: "bag", perDay: 0.2, lowAt: 1, onList: "Feed store" },
  ];

  // Today and tomorrow, back to back for each person; staying put over midnight is one stay.
  const stays: SampleStay[] = [];
  const day = (person: string, d: number, parts: [string, string][]) => {
    for (let i = 0; i < parts.length; i++) {
      const [location, from] = parts[i]!;
      const next = parts[i + 1];
      const start = instant(d, from);
      const end = next ? instant(d, next[1]) : instant(d + 1, "00:00");
      const last = stays.findLast((s) => s.person === person);
      if (last && last.location === location && last.end.equals(start)) last.end = end;
      else stays.push({ person, location, start, end });
    }
  };
  for (const d of [0, 1]) {
    const school = today.add({ days: d }).dayOfWeek <= 5;
    day(sam.id, d, [["Home", "00:00"]]);
    day(alex.id, d, school ? [["Home", "00:00"], ["Work", "08:00"], ["Home", "17:30"]] : [["Home", "00:00"]]);
    day(maya.id, d, school ? [["Home", "00:00"], ["School", "07:45"], ["Riverside Fields", "15:20"], ["Home", "16:50"]] : [["Home", "00:00"]]);
    day(leo.id, d, school ? [["Home", "00:00"], ["School", "07:45"], ["Home", "15:15"]] : [["Home", "00:00"]]);
    day(jordan.id, d, school ? [["Off the ranch", "00:00"], ["Barn", "07:00"], ["Off the ranch", "16:00"]] : [["Off the ranch", "00:00"]]);
  }

  return {
    name: "Juniper Hollow",
    timeZone,
    actingAs: "the kitchen screen",
    approvers: [sam.shortName, alex.shortName],
    people: [sam, alex, maya, leo, jordan],
    events,
    tasks,
    lists,
    supplies,
    stays,
    balances: [
      { person: maya.id, points: 140, allowanceCents: 1250 },
      { person: leo.id, points: 85, allowanceCents: 400 },
    ],
    pointsPerFiveDollars: 100,
    requests: [],
  };
}
