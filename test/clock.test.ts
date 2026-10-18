import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it } from "vitest";
import { now, shiftClock, todayIn } from "../src/clock.ts";
import { sampleRanch } from "../src/sample/ranch.ts";

afterEach(() => shiftClock(0));

describe("the clock", () => {
  it("is the real time unless local development shifts it", () => {
    const real = Temporal.Now.instant();
    expect(Math.abs(now().since(real).total("seconds"))).toBeLessThan(2);
    shiftClock("90");
    expect(Math.round(now().since(Temporal.Now.instant()).total("minutes"))).toBe(90);
    shiftClock("nonsense");
    expect(Math.abs(now().since(Temporal.Now.instant()).total("seconds"))).toBeLessThan(2);
  });

  it("moves the sample ranch to the shifted hour: at 9 PM two dogs are outside the fence", async () => {
    const zone = "America/Denver";
    const ninePm = todayIn(zone).toZonedDateTime({ timeZone: zone, plainTime: "21:00" }).toInstant();
    shiftClock(ninePm.since(Temporal.Now.instant()).total("minutes"));
    expect(now().toZonedDateTimeISO(zone).hour).toBe(21);
    expect((await sampleRanch({}).animals()).outsideFence).toEqual(["Hunter", "Pepper"]);
  });
});
