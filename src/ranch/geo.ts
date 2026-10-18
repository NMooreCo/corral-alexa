import type { LatLon, PropertyMap, Zone } from "./types.ts";

/**
 * Geometry for a property map: a fence, zones inside it, and where a collar
 * is relative to both. A ranch is small enough that a flat local projection
 * (meters east and north of a point on it) is accurate to well under a meter,
 * so everything is worked out on that plane.
 */

export interface Point {
  /** Meters east of the origin. */
  x: number;
  /** Meters north of the origin. */
  y: number;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQUATOR = 111_320;

/** A flat projection around `origin`: lat/lon to meters east and north, and back. */
export function localPlane(origin: LatLon) {
  const kx = M_PER_DEG_LON_EQUATOR * Math.cos((origin.latitude * Math.PI) / 180);
  return {
    toPoint: (p: LatLon): Point => ({ x: (p.longitude - origin.longitude) * kx, y: (p.latitude - origin.latitude) * M_PER_DEG_LAT }),
    toLatLon: (p: Point): LatLon => ({ latitude: origin.latitude + p.y / M_PER_DEG_LAT, longitude: origin.longitude + p.x / kx }),
  };
}

/** The middle of a polygon's bounding box, as a projection origin. */
export function centerOf(points: LatLon[]): LatLon {
  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  return { latitude: (Math.min(...lats) + Math.max(...lats)) / 2, longitude: (Math.min(...lons) + Math.max(...lons)) / 2 };
}

/** Distance from p to the segment a-b. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to the polygon's edge (its outline, not its inside). */
export function distanceToEdge(p: Point, polygon: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) best = Math.min(best, toSegment(p, polygon[i]!, polygon[(i + 1) % polygon.length]!));
  return best;
}

/** Inside the polygon, or on its edge (within a few centimeters). Works for concave polygons. */
export function inside(p: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  if (distanceToEdge(p, polygon) < 0.05) return true;
  let crossings = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) crossings = !crossings;
  }
  return crossings;
}

/** A polygon's area in square meters (always positive). */
export function area(polygon: Point[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** The average of a polygon's corners: good enough to hang a label on a simple zone. */
export function labelPoint(polygon: Point[]): Point {
  const n = polygon.length || 1;
  return { x: polygon.reduce((s, p) => s + p.x, 0) / n, y: polygon.reduce((s, p) => s + p.y, 0) / n };
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Which way `to` lies from `from`, in eight compass words. */
export function direction(from: Point, to: Point): string {
  const bearing = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8]!;
}

/** Where a point is on the property: inside the fence or not, which zone, and if outside, how far and which way. */
export interface Placement {
  insideFence: boolean;
  /** The smallest zone it's in, when it's in one. */
  zone: string | null;
  /** When it's outside the fence. */
  outside?: { meters: number; direction: string; nearestZone: string | null };
}

/** A property projected once, for placing many points on it. */
export function propertyPlane(property: PropertyMap) {
  const plane = localPlane(centerOf(property.fence));
  const fence = property.fence.map(plane.toPoint);
  // Smallest first, so a coop inside a pasture is the coop.
  const zones = property.zones
    .map((z) => ({ zone: z, polygon: z.polygon.map(plane.toPoint) }))
    .sort((a, b) => area(a.polygon) - area(b.polygon));

  function place(at: LatLon): Placement {
    const p = plane.toPoint(at);
    const insideFence = inside(p, fence);
    const zone = zones.find((z) => inside(p, z.polygon))?.zone.name ?? null;
    if (insideFence) return { insideFence, zone };
    const nearest = zones.length ? zones.reduce((best, z) => (distanceToEdge(p, z.polygon) < distanceToEdge(p, best.polygon) ? z : best)) : null;
    // Which way it is from the property: from the middle of the fence, so "north" reads the way a person would say it.
    return { insideFence, zone, outside: { meters: Math.round(distanceToEdge(p, fence)), direction: direction(labelPoint(fence), p), nearestZone: nearest?.zone.name ?? null } };
  }

  return { plane, fence, zones: zones.map((z) => z.zone) as Zone[], place };
}

// ---------- Drawing ----------

export interface MapFrame {
  /** SVG viewBox width and height, in drawing units (one per meter times scale). */
  width: number;
  height: number;
  /** Projects a lat/lon onto the drawing: x right, y down, north up. */
  draw(p: LatLon): { x: number; y: number };
  /** Whether a lat/lon lies within the drawing. */
  covers(p: LatLon): boolean;
  /** Meters per drawing unit. */
  metersPerUnit: number;
}

/**
 * A north-up drawing frame around the fence plus `extra` points (animals
 * outside it), padded, at most `maxMeters` across so one runaway doesn't
 * shrink the whole property to a dot.
 */
export function mapFrame(property: PropertyMap, extra: LatLon[] = [], opts: { width?: number; padM?: number; maxMeters?: number } = {}): MapFrame {
  const width = opts.width ?? 1000;
  const pad = opts.padM ?? 40;
  const max = opts.maxMeters ?? 1200;
  const plane = localPlane(centerOf(property.fence));
  const fence = property.fence.map(plane.toPoint);
  const clamp = (v: number) => Math.max(-max / 2, Math.min(max / 2, v));
  const all = [...fence, ...extra.map(plane.toPoint).map((p) => ({ x: clamp(p.x), y: clamp(p.y) }))];
  const minX = Math.min(...all.map((p) => p.x)) - pad;
  const maxX = Math.max(...all.map((p) => p.x)) + pad;
  const minY = Math.min(...all.map((p) => p.y)) - pad;
  const maxY = Math.max(...all.map((p) => p.y)) + pad;
  const scale = width / (maxX - minX);
  const height = Math.round((maxY - minY) * scale);
  return {
    width,
    height,
    metersPerUnit: 1 / scale,
    draw(p) {
      const q = plane.toPoint(p);
      return { x: Math.round((q.x - minX) * scale * 10) / 10, y: Math.round((maxY - q.y) * scale * 10) / 10 };
    },
    covers(p) {
      const q = plane.toPoint(p);
      return q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY;
    },
  };
}

/** An SVG path for a closed polygon in a frame. */
export function pathOf(frame: MapFrame, polygon: LatLon[]): string {
  return `${polygon.map((p, i) => `${i ? "L" : "M"}${frame.draw(p).x} ${frame.draw(p).y}`).join(" ")} Z`;
}
