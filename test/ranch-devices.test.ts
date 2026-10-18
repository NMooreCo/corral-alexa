import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/household.ts";
import { sampleRanch } from "../src/sample/ranch.ts";

// Friday, October 16, 2026, 7:30 PM in Denver.
const EVENING = Temporal.Instant.from("2026-10-17T01:30:00Z");

function ranchAt(start = EVENING) {
  let now = start;
  const ranch = sampleRanch({ now: () => now, fetch: (async () => Response.json({ error: true, reason: "offline in tests" })) as unknown as typeof fetch });
  return { ranch, advance: (seconds: number) => (now = now.add({ seconds })) };
}

describe("the devices tool", () => {
  it("lists every device by place, live or simulated, with readings, limits and what it does if it loses its connection", async () => {
    const { ranch } = ranchAt();
    const all = await ranch.devices.all();
    expect([...new Set(all.map((d) => d.place))]).toEqual(["Greenhouse", "North pasture", "South pasture", "Barn", "Coop", "Garden"]);
    expect(all.map((d) => d.name)).toEqual([
      "Greenhouse misters",
      "Greenhouse air",
      "Greenhouse beds",
      "Greenhouse heater",
      "Horse tank heater",
      "Goat tank heater",
      "Barn waterer",
      "Coop heat lamp",
      "Barn heater",
      "Propane tank",
      "Garden drip line",
    ]);
    const heater = all.find((d) => d.name === "Greenhouse heater")!;
    expect(heater).toMatchObject({ state: "on", switchable: true, live: false, limits: { failsafe: "on" } });
    const propane = all.find((d) => d.name === "Propane tank")!;
    expect(propane).toMatchObject({ switchable: false, state: null, attention: ["Propane is low: 18%"] });
  });

  it("filters to a place or one device, however it's said", async () => {
    const { ranch } = ranchAt();
    expect((await ranch.devices.list({ place: "the barn" })).map((d) => d.name)).toEqual(["Barn waterer", "Barn heater", "Propane tank"]);
    expect((await ranch.devices.list({ device: "coop lamp" })).map((d) => d.name)).toEqual(["Coop heat lamp"]);
    await expect(ranch.devices.list({ place: "the moon" })).rejects.toThrow(/no devices at "the moon"\. Places: Greenhouse/);
  });

  it("asks which one when a name fits several", async () => {
    const { ranch } = ranchAt();
    await expect(ranch.devices.set({ device: "tank heaters", state: "on" })).rejects.toThrow('"tank heaters" could be Horse tank heater, Goat tank heater. Say which one, or switch each of them.');
    await expect(ranch.devices.set({ device: "hot tub", state: "on" })).rejects.toThrow(/no device called "hot tub"/);
  });
});

describe("set_device and each device's limits", () => {
  it("switches a heater on with no end, and back off with a reminder that it fails on", async () => {
    const { ranch } = ranchAt();
    const on = await ranch.devices.set({ device: "Horse tank heater", state: "on" });
    expect(on).toMatchObject({ status: "done", summary: "Horse tank heater on, with no set end", device: { state: "on", ifUnreachable: "stays on" } });
    // The water warms once it's on.
    expect(Number.parseInt(on.device.readings!["Water temperature"]!, 10)).toBeGreaterThan(40);
    const off = await ranch.devices.set({ device: "horse tank heater", state: "off" });
    expect(off.summary).toBe("Horse tank heater off");
    expect(off.note).toMatch(/If it loses its connection, it stays on/);
  });

  it("gives a capped device its default run when none is said, and refuses one past its cap", async () => {
    const { ranch } = ranchAt();
    const lamp = await ranch.devices.set({ device: "coop heat lamp", state: "on" });
    expect(lamp.summary).toBe("Coop heat lamp on for 12 hours, until 7:30 AM");
    await expect(ranch.devices.set({ device: "coop heat lamp", state: "on", minutes: 15 * 60 })).rejects.toThrow("The Coop heat lamp runs at most 14 hours at a time. Offer 14 hours or less.");
    await expect(ranch.devices.set({ device: "drip line", state: "on", minutes: 61 })).rejects.toThrow(/at most 1 hour/);
  });

  it("adds seconds and minutes, and turns down a negative or zero run", async () => {
    const { ranch } = ranchAt();
    expect((await ranch.devices.set({ device: "misters", state: "on", minutes: 1, seconds: 30 })).summary).toBe("Greenhouse misters on for 1 minute 30 seconds, until 7:31 PM");
    await expect(ranch.devices.set({ device: "misters", state: "on", seconds: -5 })).rejects.toThrow(ToolError);
    await expect(ranch.devices.set({ device: "misters", state: "on", seconds: 0 })).rejects.toThrow("A run needs to be at least a second.");
  });

  it("won't switch a sensor, or take a state it doesn't know", async () => {
    const { ranch } = ranchAt();
    await expect(ranch.devices.set({ device: "propane tank", state: "on" })).rejects.toThrow("The Propane tank only reports readings; there's nothing to switch.");
    await expect(ranch.devices.set({ device: "barn heater", state: "high" })).rejects.toThrow('The state is "on" or "off".');
  });

  it("ends a timed run on its own", async () => {
    const { ranch, advance } = ranchAt();
    await ranch.devices.set({ device: "drip line", state: "on", minutes: 5 });
    advance(120);
    expect((await ranch.devices.list({ device: "drip line" }))[0]!.run!.secondsLeft).toBe(180);
    advance(181);
    expect((await ranch.devices.list({ device: "drip line" }))[0]).toMatchObject({ state: "off", run: null });
  });

  it("runs the sample greenhouse's misters through the same connector as real hardware", async () => {
    const { ranch, advance } = ranchAt();
    const answer = await ranch.devices.set({ device: "greenhouse misters", state: "on", seconds: 30 });
    expect(answer).toMatchObject({ summary: "Greenhouse misters on for 30 seconds, until 7:30 PM", device: { live: false, run: "30 seconds left, until 7:30 PM" } });
    // Misting raises the greenhouse's humidity.
    const air = (await ranch.devices.list({ device: "greenhouse air" }))[0]!;
    expect(air.readings.find((r) => r.key === "humidity")!.value).toBeGreaterThan(70);
    advance(31);
    expect((await ranch.devices.list({ device: "misters" }))[0]!.state).toBe("off");
  });
});
