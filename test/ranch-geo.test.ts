import { describe, expect, it } from "vitest";
import { area, direction, distanceToEdge, inside, localPlane, mapFrame, pathOf, propertyPlane, type Point } from "../src/ranch/geo.ts";
import type { PropertyMap } from "../src/ranch/types.ts";
import { sampleRanchConfig } from "../src/sample/ranch.ts";

// An L: a 100 by 100 square with its north-east quarter cut out.
const L: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
  { x: 50, y: 50 },
  { x: 50, y: 100 },
  { x: 0, y: 100 },
];

/** A small repeatable random source, so the property checks below are the same every run. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe("fence geometry", () => {
  it("tells inside from outside on a concave fence", () => {
    expect(inside({ x: 25, y: 25 }, L)).toBe(true);
    expect(inside({ x: 75, y: 25 }, L)).toBe(true);
    expect(inside({ x: 25, y: 75 }, L)).toBe(true);
    // The cut-out corner is outside, though it's inside the bounding box.
    expect(inside({ x: 75, y: 75 }, L)).toBe(false);
    expect(inside({ x: -1, y: 50 }, L)).toBe(false);
    expect(inside({ x: 50, y: 101 }, L)).toBe(false);
  });

  it("counts a point on the fence line, or a corner, as inside", () => {
    expect(inside({ x: 0, y: 50 }, L)).toBe(true);
    expect(inside({ x: 75, y: 50 }, L)).toBe(true);
    expect(inside({ x: 50, y: 50 }, L)).toBe(true);
    expect(inside({ x: 100, y: 0 }, L)).toBe(true);
  });

  it("agrees with a plain box test on random points (property)", () => {
    const next = random(7);
    for (let i = 0; i < 2000; i++) {
      const p = { x: next() * 140 - 20, y: next() * 140 - 20 };
      const inBox = (x0: number, y0: number, x1: number, y1: number) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      const expected = inBox(0, 0, 100, 50) || inBox(0, 0, 50, 100);
      // Within a few centimeters of the line counts as on it, which a box test can't say.
      if (distanceToEdge(p, L) < 0.1) continue;
      expect(inside(p, L), `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).toBe(expected);
    }
  });

  it("measures the distance to the fence, from either side (property: zero only on the line)", () => {
    expect(distanceToEdge({ x: -30, y: 25 }, L)).toBeCloseTo(30);
    // In the cut-out corner, the nearest fence is the inside corner's two sides.
    expect(distanceToEdge({ x: 80, y: 80 }, L)).toBeCloseTo(30);
    expect(distanceToEdge({ x: 130, y: 90 }, L)).toBeCloseTo(Math.hypot(30, 40));
    expect(distanceToEdge({ x: 25, y: 25 }, L)).toBeCloseTo(25);
    const next = random(11);
    for (let i = 0; i < 500; i++) {
      const p = { x: next() * 200 - 50, y: next() * 200 - 50 };
      const d = distanceToEdge(p, L);
      expect(d).toBeGreaterThanOrEqual(0);
      // Moving a point by some distance changes its distance to the fence by at most that much.
      const q = { x: p.x + 3, y: p.y - 4 };
      expect(Math.abs(distanceToEdge(q, L) - d)).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it("works out areas and compass directions", () => {
    expect(area(L)).toBe(7500);
    expect(direction({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe("north");
    expect(direction({ x: 0, y: 0 }, { x: 10, y: 10 })).toBe("north-east");
    expect(direction({ x: 0, y: 0 }, { x: -10, y: -1 })).toBe("west");
    expect(direction({ x: 0, y: 0 }, { x: 1, y: -10 })).toBe("south");
  });

  it("projects lat/lon onto a flat local plane and back, to within centimeters", () => {
    const plane = localPlane({ latitude: 43.44, longitude: -105.21 });
    const p = plane.toPoint({ latitude: 43.441, longitude: -105.209 });
    // About 111 m north and 81 m east at this latitude.
    expect(p.y).toBeCloseTo(110.6, 0);
    expect(p.x).toBeCloseTo(80.8, 0);
    const back = plane.toLatLon(p);
    expect(back.latitude).toBeCloseTo(43.441, 9);
    expect(back.longitude).toBeCloseTo(-105.209, 9);
  });
});

describe("placing points on a property", () => {
  const { property } = sampleRanchConfig();
  const plane = propertyPlane(property);
  const at = (x: number, y: number) => localPlane({ latitude: 43.44, longitude: -105.21 }).toLatLon({ x, y });

  it("finds the smallest zone a point is in", () => {
    expect(plane.place(at(-60, 150))).toEqual({ insideFence: true, zone: "North pasture" });
    expect(plane.place(at(-142, 100))).toEqual({ insideFence: true, zone: "Barn" });
    expect(plane.place(at(54, 38))).toEqual({ insideFence: true, zone: "Greenhouse" });
    // Inside the fence but in no zone.
    expect(plane.place(at(10, 60))).toEqual({ insideFence: true, zone: null });
    // On the drive: a road is drawn, but it isn't a place.
    expect(plane.place(at(-24, -60))).toEqual({ insideFence: true, zone: null });
  });

  it("says how far outside the fence a point is, which way, and what it's nearest", () => {
    const north = plane.place(at(0, 250));
    expect(north).toMatchObject({ insideFence: false, zone: null, outside: { direction: "north", nearestZone: "North pasture" } });
    expect(north.outside!.meters).toBeGreaterThanOrEqual(49);
    expect(north.outside!.meters).toBeLessThanOrEqual(51);
    // Across the road, south-west of the property's middle, and never "near" the road itself.
    const west = plane.place(at(-200, -60));
    expect(west).toMatchObject({ insideFence: false, outside: { direction: "south-west", nearestZone: "South pasture" } });
    expect(west.outside!.meters).toBeGreaterThanOrEqual(76);
    expect(west.outside!.meters).toBeLessThanOrEqual(80);
  });

  it("nests zones by size, whatever order the data lists them in", () => {
    const square = (x0: number, y0: number, x1: number, y1: number) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
    const map: PropertyMap = {
      fence: square(-100, -100, 100, 100),
      zones: [
        { id: "small", name: "Pen", style: "structure", polygon: square(-5, -5, 5, 5) },
        { id: "big", name: "Field", style: "field", polygon: square(-50, -50, 50, 50) },
      ],
    };
    const p = propertyPlane(map);
    expect(p.place(at(0, 0)).zone).toBe("Pen");
    expect(p.place(at(20, 20)).zone).toBe("Field");
    expect(propertyPlane({ ...map, zones: [...map.zones].reverse() }).place(at(0, 0)).zone).toBe("Pen");
  });

  it("frames a north-up drawing around the fence and anyone outside it, with far runaways kept on the map", () => {
    const frame = mapFrame(property, [at(255, 228)]);
    expect(frame.width).toBe(1000);
    const nw = frame.draw(at(-236, 200));
    const se = frame.draw(at(150, -200));
    // North is up and west is left.
    expect(nw.y).toBeLessThan(se.y);
    expect(nw.x).toBeLessThan(se.x);
    expect(frame.covers(at(255, 228))).toBe(true);
    // Something two kilometers away doesn't shrink the property to a dot.
    const far = mapFrame(property, [at(2000, 0)]);
    expect(far.metersPerUnit).toBeLessThan(1.3);
    expect(far.covers(at(2000, 0))).toBe(false);
    expect(pathOf(frame, property.fence)).toMatch(/^M[\d.]+ [\d.]+ (L[\d.]+ [\d.]+ ){6}Z$/);
  });
});
