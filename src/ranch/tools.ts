import * as z from "zod/v4";
import { spoken } from "./devices.ts";
import type { Ranch } from "./index.ts";

/**
 * The ranch's tools as the assistant sees them. They're generic: what a
 * device is called, what it reads and how far it runs come from the
 * household's configuration, and the descriptions only say what to expect.
 */

export interface RanchTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** Reaches past this server (real hardware, or a forecast service). */
  openWorld: boolean;
  run(ranch: Ranch, args: Record<string, unknown>): Promise<unknown>;
}

export const RANCH_TOOLS: RanchTool[] = [
  {
    name: "devices",
    title: "Ranch devices",
    description:
      "The ranch's devices and sensors (valves like the greenhouse misters, heaters, heat lamps, waterers, tanks, the greenhouse air and soil), optionally for one place or one device. Each says on or off, any run in progress and when it ends, its readings, how long it may run, what it does if it loses its connection, and anything needing attention. When the person speaking may not switch devices, it says so and who can.",
    input: z.object({ place: z.string().describe('A place, like "Greenhouse" or "Barn"').optional(), device: z.string().describe("One device's name or id").optional() }),
    openWorld: true,
    run: async (ranch, a) => (await ranch.devices.list({ place: a.place, device: a.device })).map(spoken),
  },
  {
    name: "weather",
    title: "Weather",
    description: "The forecast for the household's own location: now, today, tonight's low with a plain freeze flag, wind, precipitation and snow, and the next few days.",
    input: z.object({}),
    openWorld: true,
    run: (ranch) => ranch.weather(),
  },
  {
    name: "trackers",
    title: "Animal trackers",
    description:
      "Where each animal in a GPS collar is: inside the fence or not, which zone (a pasture, the barn), and if it's outside, how far and which way. Also collar battery and signal, and when it was last seen. Optionally one animal by name, or one kind (\"the goats\").",
    input: z.object({ animal: z.string().describe("An animal's name, or a kind like goats").optional() }),
    openWorld: false,
    run: async (ranch, a) => {
      const r = await ranch.animals(a.animal);
      // The assistant doesn't need coordinates to say where an animal is.
      return { ...r, animals: r.animals.map(({ position: _p, batteryValue: _b, ...rest }) => rest) };
    },
  },
];

export const SET_DEVICE = {
  name: "set_device",
  title: "Switch a ranch device",
  description:
    "Switch a ranch device on or off, or run it for some seconds or minutes. A device with a run limit always runs for a set time (its default when none is said) and anything over its limit is refused. Confirm with the person first. Shows the Ranch screen, with a run counting down.",
  input: z.object({
    device: z.string().describe("The device's name or id from the devices tool"),
    state: z.enum(["on", "off"]),
    seconds: z.number().describe("Run for this many seconds").optional(),
    minutes: z.number().describe("Run for this many minutes").optional(),
  }),
};

export const AUTOMATIONS = {
  name: "automations",
  title: "Ranch automations",
  description:
    "The ranch's automations: each one's name, whether it's on, when it runs (a daily schedule, a freeze in tonight's forecast, or a device's reading dropping), what it switches, when it next runs, and what it did last time.",
  input: z.object({}),
};

export const SET_AUTOMATION = {
  name: "set_automation",
  title: "Turn an automation on or off",
  description: "Turn one of the ranch's automations on or off. Confirm with the person first, saying what it does. Shows the Ranch screen on its Automations tab.",
  input: z.object({
    automation: z.string().describe("The automation's name or id from the automations tool"),
    enabled: z.boolean().describe("true to turn it on, false to turn it off"),
  }),
};

const WHEN = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), times: z.array(z.string()).describe(`Times each day in the household's time zone, like ["07:00", "15:00"]`) }),
  z.object({
    kind: z.literal("freeze"),
    below: z.number().describe("Act when tonight's forecast low is at or below this, in the household's units"),
    at: z.string().describe('When each day to check the forecast and act, like "17:00" (the default)').optional(),
  }),
  z.object({
    kind: z.literal("reading"),
    device: z.string().describe("The device whose reading to watch"),
    reading: z.string().describe('The reading, like "Water temperature"'),
    below: z.number().describe("Act whenever the reading is below this"),
  }),
]);

export const ADD_AUTOMATION = {
  name: "add_automation",
  title: "Add an automation",
  description:
    "Add an automation that switches ranch devices on its own: every day at set times, when tonight's forecast low is at or below a temperature, or whenever a device's reading drops below a value. Each device's limits apply: a device with a run limit needs a run inside it, or gets its default. Confirm the whole rule with the person first. It starts on, and shows the Ranch screen on its Automations tab.",
  input: z.object({
    name: z.string().describe('A short name, like "Freeze protection"'),
    when: WHEN,
    then: z
      .array(
        z.object({
          device: z.string().describe("The device's name or id"),
          state: z.enum(["on", "off"]),
          seconds: z.number().describe("Run for this many seconds").optional(),
          minutes: z.number().describe("Run for this many minutes").optional(),
        }),
      )
      .describe("The devices to switch, in order"),
  }),
};

/** What the server's instructions add when the household has a ranch. */
export const RANCH_INSTRUCTIONS =
  "It also runs the ranch: devices (switch one only after the person says yes; each device's own limits are enforced), automations that switch devices on their own (on a schedule, before a freeze, or when a reading drops), the forecast for the household's location, and the animals' GPS collars. show_ranch puts the property map and devices on the screen (with tabs for the animals and the automations), and show_briefing the morning briefing.";
