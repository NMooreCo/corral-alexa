import { Temporal } from "temporal-polyfill";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/household.ts";
import { clearWeatherCache } from "../src/ranch/weather.ts";
import { sampleRanch } from "../src/sample/ranch.ts";
import { openMeteo, openMeteoFetch } from "./ranch-fixtures.ts";

// Friday, October 16, 2026, in Denver.
const at = (time: string) => Temporal.ZonedDateTime.from(`2026-10-16T${time}:00-06:00[America/Denver]`).toInstant();

/** A sample ranch on a clock the test moves, with tonight's low set to `low`. */
function ranchAt(start: string, low = 40) {
  let now = at(start);
  const stub = openMeteoFetch(openMeteo("2026-10-16", { lows: [low, low, low, low, low] }));
  const ranch = sampleRanch({ now: () => now, fetch: stub.fetch });
  return { ranch, move: (time: string) => (now = at(time)) };
}

const named = async (ranch: ReturnType<typeof sampleRanch>, name: string) => (await ranch.automations.list()).find((a) => a.name === name)!;
const device = async (ranch: ReturnType<typeof sampleRanch>, name: string) => (await ranch.devices.all()).find((d) => d.name === name)!;

beforeEach(() => clearWeatherCache());

describe("the ranch's automations", () => {
  it("says each one in words: when, what it switches, when it runs next and what it did last", async () => {
    const { ranch } = ranchAt("21:00");
    const list = await ranch.automations.list();
    expect(list.map((a) => [a.name, a.enabled])).toEqual([
      ["Freeze protection", false],
      ["Greenhouse misting", true],
      ["Garden watering", true],
      ["Keep the horse tank thawed", true],
    ]);
    expect(list[0]).toMatchObject({
      when: "At 5:00 PM, when tonight's low is 25°F or colder",
      then: ["Turn on the horse tank heater", "Turn on the goat tank heater", "Turn on the barn heater", "Turn on the coop heat lamp for its usual 12 hours"],
      next: null,
    });
    expect(list[1]).toMatchObject({
      when: "Every day at 7:00 AM and 3:00 PM",
      then: ["Run the greenhouse misters for 2 minutes"],
      next: "Tomorrow at 7:00 AM",
      lastRun: { at: "Today at 3:00 PM", did: ["Greenhouse misters ran 2 minutes"], failed: [] },
    });
    expect(list[3]!.when).toBe("Whenever the horse tank heater's water temperature is below 34°F");
  });

  it("runs a schedule when its time comes, through the devices' own limits", async () => {
    const { ranch, move } = ranchAt("06:58");
    await ranch.tick(); // the first look only starts the clock
    expect((await device(ranch, "Greenhouse misters")).state).toBe("off");
    move("07:01");
    await ranch.tick();
    const misters = await device(ranch, "Greenhouse misters");
    expect(misters.state).toBe("on");
    expect(misters.run?.secondsLeft).toBeGreaterThan(55);
    expect((await named(ranch, "Greenhouse misting")).lastRun).toMatchObject({ at: "Today at 7:01 AM", failed: [] });
    // Looking again doesn't run it twice.
    move("07:02");
    await ranch.tick();
    expect((await named(ranch, "Greenhouse misting")).lastRun?.at).toBe("Today at 7:01 AM");
  });

  it("turns the heat on before a freeze only when it's on and the forecast says so", async () => {
    const cold = ranchAt("16:58", 12);
    await cold.ranch.tick();
    cold.move("17:01");
    await cold.ranch.tick();
    expect((await device(cold.ranch, "Barn heater")).state).toBe("off"); // it's off until someone turns it on

    const on = ranchAt("16:58", 12);
    const turned = await on.ranch.automations.set("freeze", true);
    expect(turned).toMatchObject({ enabled: true, next: "Today at 5:00 PM, if it's 25°F or colder tonight" });
    await on.ranch.tick();
    on.move("17:01");
    await on.ranch.tick();
    for (const name of ["Horse tank heater", "Goat tank heater", "Barn heater", "Coop heat lamp"]) expect((await device(on.ranch, name)).state).toBe("on");

    clearWeatherCache(); // the forecast is cached by place, and this is a different night
    const mild = ranchAt("16:58", 40);
    await mild.ranch.automations.set("Freeze protection", true);
    await mild.ranch.tick();
    mild.move("17:01");
    await mild.ranch.tick();
    expect((await device(mild.ranch, "Barn heater")).state).toBe("off");
  });

  it("adds a new one after checking its devices and runs against their limits", async () => {
    const { ranch } = ranchAt("12:00");
    await expect(ranch.automations.add({ name: "Mist a lot", when: { kind: "schedule", times: ["12:30"] }, then: [{ device: "greenhouse misters", state: "on", minutes: 20 }] })).rejects.toThrow(/at most 10 minutes/);
    await expect(ranch.automations.add({ name: "Moose", when: { kind: "schedule", times: ["12:30"] }, then: [{ device: "moose feeder", state: "on" }] })).rejects.toThrow(ToolError);
    await expect(ranch.automations.add({ name: "Greenhouse misting", when: { kind: "schedule", times: ["12:30"] }, then: [{ device: "greenhouse misters", state: "on" }] })).rejects.toThrow(/already/);
    await expect(ranch.automations.add({ name: "Late", when: { kind: "schedule", times: ["25:00"] }, then: [{ device: "greenhouse misters", state: "on" }] })).rejects.toThrow(/like "07:00"/);
    const added = await ranch.automations.add({ name: "Warm the barn", when: { kind: "reading", device: "barn heater", reading: "Barn temperature", below: 35 }, then: [{ device: "barn heater", state: "on" }] });
    expect(added).toMatchObject({ id: "warm-the-barn", enabled: true, when: "Whenever the barn heater's barn temperature is below 35°F", then: ["Turn on the barn heater"] });
  });

  it("finds one by name, and says which when a name could be several", async () => {
    const { ranch } = ranchAt("12:00");
    expect((await ranch.automations.set("garden", false)).enabled).toBe(false);
    await expect(ranch.automations.set("moose", true)).rejects.toThrow(/no automation called/);
    await expect(ranch.automations.set("g", true)).rejects.toThrow(/could be/);
  });

  it("keeps what they do for the ranch's history: turned on or off, added, and each run", async () => {
    const { ranch, move } = ranchAt("05:55");
    await ranch.tick(); // the first look only starts the clock
    await ranch.automations.set("freeze protection", true);
    await ranch.automations.set("freeze protection", true); // already on: nothing new to say
    move("06:01");
    await ranch.tick();
    const told = ranch.history(at("00:00")).map((h) => h.text);
    expect(told[0]).toBe("Freeze protection turned on");
    expect(told[1]).toMatch(/^Garden watering ran: Garden drip line on/);
    expect(told).toHaveLength(2);
    expect(ranch.history(at("06:30"))).toEqual([]);
  });

  it("says when an animal leaves the fence, once, from the second look on", async () => {
    const { ranch, move } = ranchAt("20:10");
    await ranch.tick(); // Pepper's been out since dusk: the first look only learns that
    move("20:16");
    await ranch.tick();
    expect(ranch.history(at("00:00")).filter((h) => h.kind === "animal")).toEqual([]);
    move("20:18");
    await ranch.tick();
    await ranch.tick();
    const left = ranch.history(at("00:00")).filter((h) => h.kind === "animal");
    expect(left.map((h) => h.text)).toEqual([expect.stringMatching(/^Hunter just left the fence, about \d+ ft out to the north-east, near the Woods$/)]);
  });

  it("keeps an automation's run as something to say out loud, and its switch as just history", async () => {
    const { ranch, move } = ranchAt("05:55");
    await ranch.tick();
    await ranch.automations.set("freeze protection", true);
    move("06:01");
    await ranch.tick();
    expect(ranch.history(at("00:00")).map((h) => h.kind)).toEqual(["automation", "run"]);
  });
});
