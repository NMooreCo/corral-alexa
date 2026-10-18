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

/** What the server's instructions add when the household has a ranch. */
export const RANCH_INSTRUCTIONS =
  "It also runs the ranch: devices (switch one only after the person says yes; each device's own limits are enforced), the forecast for the household's location, and the animals' GPS collars. show_ranch puts the property map and devices on the screen, and show_briefing the morning briefing.";
