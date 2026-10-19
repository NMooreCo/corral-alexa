import type { HouseholdAction } from "../household.ts";
import type { SamplePerson, SampleState } from "./seed.ts";

/**
 * Who may see and change what in the sample household, as data, the way a
 * Corral role is: which calendars it sees, whose chores and whereabouts,
 * whether it changes anything at all, which changes wait for someone who
 * approves them, and whether it approves. People hold roles by name; the
 * code reads these fields and never a person's name.
 */

/** The header the simulated Echo Show sends to say who Alexa recognized. Only the sample household reads it. */
export const SPEAKER_HEADER = "x-demo-person";

/** What the simulator sends for a voice Alexa doesn't recognize. Any name nobody here has means the same. */
export const GUEST_SPEAKER = "guest";

/** The speaker the header names. It's URI-encoded, since a header can't carry every name as it's written. */
export function speakerOf(header: string | null): string | null {
  if (header === null) return null;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * Changes to the household's plans, which can wait for someone to approve
 * them. Doing what's planned (checking off, taking a chore, counting
 * supplies) is never one of these, so it never waits.
 */
export const PLAN_CHANGES = ["add_event", "add_task", "add_list_item", "skip_task"] as const;
export type PlanChange = (typeof PLAN_CHANGES)[number];

/** What a request can hold: a plan change, or an order that waits for a yes (from someone whose role doesn't order, or over the household's limit). */
export type RequestChange = PlanChange | "place_order";

export interface SampleRole {
  /** As people's roles name it, like "Parent". */
  name: string;
  /** The calendars it sees; "*" is every one. Events on any other calendar aren't there for it. */
  calendars: "*" | string[];
  /** Whose chores it hears about: everyone's, or only its own and ones up for grabs. */
  tasks: "everyone" | "own";
  /** Whose whereabouts: everyone's, or only its own (none, for someone who isn't anyone here). */
  whereabouts: "everyone" | "own";
  /** False when it only reads: no change at all, check-offs included. */
  changes: boolean;
  /** Changes that wait for someone who approves: every time, or only when it's for someone else. */
  approval: Partial<Record<PlanChange, "always" | "for_others">>;
  /** Approves or declines other people's requests. */
  approves: boolean;
  /** Switches the ranch's devices (heaters, valves, lamps), by voice or on the Ranch screen. */
  devices: boolean;
  /** Orders supplies from the household's stores. Without it, an order waits for someone who approves. */
  orders: boolean;
}

/** The role for a voice Alexa doesn't recognize. */
export const GUEST_ROLE = "Guest";
/** The role for no one in particular: the household's shared kitchen screen, which is what a call that names no speaker is. */
export const SCREEN_ROLE = "Shared screen";

export function sampleRoles(): SampleRole[] {
  return [
    { name: "Parent", calendars: "*", tasks: "everyone", whereabouts: "everyone", changes: true, approval: {}, approves: true, devices: true, orders: true },
    {
      name: "Kid",
      calendars: "*",
      tasks: "everyone",
      whereabouts: "everyone",
      changes: true,
      // Anything that changes plans for others waits for a parent; a reminder for themselves doesn't.
      approval: { add_event: "always", add_task: "for_others", add_list_item: "always", skip_task: "always" },
      approves: false,
      // The ranch's heaters and valves are a grown-up's to switch.
      devices: false,
      // Kids ask, parents decide: a kid's order waits for a parent.
      orders: false,
    },
    // From outside the family: the ranch's calendar, their own chores and ones up for grabs, and where they are. Spending the family's money waits for a parent.
    { name: "Farm hand", calendars: ["Ranch"], tasks: "own", whereabouts: "own", changes: true, approval: {}, approves: false, devices: true, orders: false },
    // Someone Alexa doesn't recognize: they can hear what the day holds, and change nothing.
    { name: GUEST_ROLE, calendars: "*", tasks: "everyone", whereabouts: "own", changes: false, approval: {}, approves: false, devices: false, orders: false },
    // The kitchen screen itself: what the sample always was before it knew voices. It's no one, so its orders wait for a parent.
    { name: SCREEN_ROLE, calendars: "*", tasks: "everyone", whereabouts: "everyone", changes: true, approval: { add_event: "always" }, approves: false, devices: true, orders: false },
  ];
}

/** Who a call comes from: someone in the household, a guest, or the shared screen. */
export interface SampleActor {
  /** Null for a guest or the shared screen. */
  person: SamplePerson | null;
  role: SampleRole;
}

function roleNamed(state: SampleState, name: string): SampleRole {
  const role = state.roles.find((r) => r.name === name);
  if (!role) throw new Error(`The sample household has no "${name}" role.`);
  return role;
}

/** Someone in the household by their full or short name, said any way. */
export function personNamed(state: SampleState, said: string): SamplePerson | undefined {
  const s = said.trim().toLowerCase();
  if (!s) return undefined;
  return state.people.find((p) => p.name.toLowerCase() === s || p.shortName.toLowerCase() === s);
}

/** A person as an actor, with the first of their roles the household defines; a role it doesn't define gets a guest's. */
export function actorOf(state: SampleState, person: SamplePerson): SampleActor {
  const role = state.roles.find((r) => person.roles.includes(r.name)) ?? roleNamed(state, GUEST_ROLE);
  return { person, role };
}

/**
 * The actor for what the speaker header says. Nothing said is the shared
 * screen; a name in the household is that person; "guest", or a name
 * nobody here has, is a guest, so a mistake never gets more than a guest may.
 */
export function actorFor(state: SampleState, said: string | null | undefined): SampleActor {
  if (said === null || said === undefined || !said.trim()) return { person: null, role: roleNamed(state, SCREEN_ROLE) };
  const person = personNamed(state, said);
  return person ? actorOf(state, person) : { person: null, role: roleNamed(state, GUEST_ROLE) };
}

/** The people whose role approves requests. */
export function approversOf(state: SampleState): SamplePerson[] {
  return state.people.filter((p) => actorOf(state, p).role.approves);
}

/** "Nick", "Nick or Holly", "Nick, Holly or Pat". */
export function either(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "someone who approves requests";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** Why an actor may not do something beyond the household's own tools, naming who can, or null when they may. */
export function refusalFor(state: SampleState, actor: SampleActor, action: HouseholdAction): string | null {
  if (action !== "switch_device" || actor.role.devices) return null;
  const can = state.people.filter((p) => actorOf(state, p).role.devices).map((p) => p.shortName);
  const who = can.length > 1 ? `${can.slice(0, -1).join(", ")} or ${can.at(-1)}` : (can[0] ?? "someone who looks after the ranch");
  return actor.person ? `${actor.person.shortName} can't switch the ranch's devices. ${who} can.` : `Only people in ${state.name} who look after the ranch can switch its devices, and this voice isn't one of them. ${who} can.`;
}
