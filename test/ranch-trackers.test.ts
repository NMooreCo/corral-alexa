import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { ToolError } from "../src/household.ts";
import { trackerReport } from "../src/ranch/trackers.ts";
import type { TrackerFeed } from "../src/ranch/types.ts";
import { localPlane } from "../src/ranch/geo.ts";
import { SampleCollars, sampleRanch, sampleRanchConfig } from "../src/sample/ranch.ts";

// Friday, October 16, 2026, in Denver.
const MORNING = Temporal.Instant.from("2026-10-16T16:30:00Z"); // 10:30 AM
const NIGHT = Temporal.Instant.from("2026-10-17T03:15:00Z"); // 9:15 PM

const ranch = (at: Temporal.Instant) => sampleRanch({ now: () => at });

describe("the trackers tool", () => {
  it("has every animal inside the fence, in its home zone, during the day", async () => {
    const r = await ranch(MORNING).animals();
    expect(r.feed).toBe("Sample collars (simulated)");
    expect(r.live).toBe(false);
    expect(r.outsideFence).toEqual([]);
    expect(Object.fromEntries(r.animals.map((a) => [a.animal, a.zone]))).toEqual({ Biscuit: "House", Scout: "Barn", Maple: "North pasture", Dusty: "North pasture", Pepper: "South pasture", Clover: "South pasture" });
  });

  it("at night, has two animals outside the fence, saying how far, which way and what they're near", async () => {
    const r = await ranch(NIGHT).animals();
    expect(r.outsideFence).toEqual(["Scout", "Pepper"]);
    const scout = r.animals.find((a) => a.animal === "Scout")!;
    expect(scout).toMatchObject({ insideFence: false, zone: null, outside: { direction: "north-east", nearestZone: "North pasture" } });
    expect(scout.outside!.words).toMatch(/^about \d+ ft outside the fence to the north-east, nearest the North pasture$/);
    const pepper = r.animals.find((a) => a.animal === "Pepper")!;
    expect(pepper).toMatchObject({ signal: "weak", outside: { direction: "west", nearestZone: "South pasture" } });
  });

  it("flags a low collar battery, and says when each collar last reported", async () => {
    const r = await ranch(MORNING).animals();
    expect(r.lowBattery).toEqual(["Dusty"]);
    const dusty = r.animals.find((a) => a.animal === "Dusty")!;
    expect(dusty).toMatchObject({ batteryLow: true, stale: false });
    expect(dusty.lastSeen).toMatch(/just now|minute/);
    expect(dusty.lastSeenAt).toMatch(/^10:\d\d AM$/);
  });

  it("answers for one animal, or one kind of animal", async () => {
    const r = ranch(NIGHT);
    expect((await r.animals("scout")).animals.map((a) => a.animal)).toEqual(["Scout"]);
    expect((await r.animals("goats")).animals.map((a) => a.animal)).toEqual(["Pepper", "Clover"]);
    await expect(r.animals("Moose")).rejects.toThrow(ToolError);
  });

  it("wanders smoothly: a minute later, an animal has moved only a little", async () => {
    const plane = localPlane({ latitude: 43.44, longitude: -105.21 });
    const a = (await new SampleCollars({ now: () => MORNING, timeZone: "America/Denver" }).fixes())[2]!;
    const b = (await new SampleCollars({ now: () => MORNING.add({ minutes: 2 }), timeZone: "America/Denver" }).fixes())[2]!;
    const pa = plane.toPoint(a.position);
    const pb = plane.toPoint(b.position);
    expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeLessThan(150);
  });

  it("works from any feed in the generic shape, calling an old fix stale", async () => {
    const config = sampleRanchConfig();
    const plane = localPlane({ latitude: 43.44, longitude: -105.21 });
    const feed: TrackerFeed = {
      name: "A real collar feed",
      live: true,
      fixes: async () => [{ collar: "C9", animal: "Juniper", species: "donkey", battery: 90, signal: "none", at: MORNING.subtract({ hours: 2 }), position: plane.toLatLon({ x: 0, y: 100 }) }],
    };
    const r = await trackerReport(feed, config, MORNING);
    expect(r).toMatchObject({ feed: "A real collar feed", live: true, stale: ["Juniper"], outsideFence: [], animals: [{ animal: "Juniper", zone: "North pasture", lastSeen: "2 hours ago", stale: true }] });
  });
});
