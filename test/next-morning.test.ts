import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { HouseholdClock } from "../src/clock.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { todayView } from "../src/today.ts";
import type { CorralTask } from "../src/household.ts";

// Friday, October 16, 2026, at 8:15 PM in Denver, and the next morning.
const EVENING = Temporal.Instant.from("2026-10-17T02:15:00Z");
const MORNING = Temporal.Instant.from("2026-10-17T12:45:00Z");

/** A sample household on a clock the test moves. */
function householdAt(start: Temporal.Instant) {
  let now = start;
  const household = new SampleHousehold({ now: () => now, timeZone: "America/Denver" });
  return { household, move: (to: Temporal.Instant) => (now = to) };
}

const tasks = async (h: SampleHousehold) => (await h.as("Nick").call("tasks", { include_done: true })) as CorralTask[];
const idOf = (h: SampleHousehold, title: string) => h.state.tasks.find((t) => t.title === title && t.status === "open")!.id;

describe("the next morning", () => {
  it("finds the next morning on the household's own clock", () => {
    // From Friday evening, the next 6:45 AM is Saturday's: 10.5 hours on.
    expect(HouseholdClock.offsetToNext("06:45", "America/Denver", EVENING, EVENING)).toBe(630);
    // From 6:45 that morning, it's the one after.
    expect(HouseholdClock.offsetToNext("06:45", "America/Denver", MORNING, MORNING)).toBe(24 * 60);
    // The offset is from the real time, wherever the household's clock is.
    expect(HouseholdClock.offsetToNext("06:45", "America/Denver", EVENING, EVENING.subtract({ hours: 3 }))).toBe(630 + 180);
  });

  it("starts each daily chore again and closes yesterday's missed ones, once", async () => {
    const { household, move } = householdAt(EVENING);
    move(MORNING);
    household.nextDay();
    household.nextDay();
    const all = household.state.tasks;
    // One of each daily chore today, open.
    const todays = all.filter((t) => t.repeats === "daily" && t.due.startsWith("2026-10-17"));
    expect(todays.map((t) => t.title).sort()).toEqual(["Collect eggs", "Empty the dishwasher", "Feed the horses (evening)", "Feed the horses (morning)", "Give Leia the allergy pill", "Take out the trash", "Water the garden"]);
    expect(todays.every((t) => t.status === "open" && t.doneBy === null && !t.captured)).toBe(true);
    // Yesterday's missed ones are closed, and what was done stays done.
    expect(all.find((t) => t.title === "Take out the trash" && t.due.startsWith("2026-10-16"))?.status).toBe("skipped");
    expect(all.find((t) => t.title === "Feed the horses (morning)" && t.due.startsWith("2026-10-16"))?.status).toBe("done");
    // A one-off isn't repeated.
    expect(all.filter((t) => t.title === "Clean the chicken coop")).toHaveLength(1);
    // So the morning has nothing late, and today's chores ahead.
    const now = await tasks(household);
    expect(now.some((t) => t.status === "overdue")).toBe(false);
    expect(now.find((t) => t.title === "Feed the horses (morning)")?.status).toBe("open");
  });

  it("keeps a history of chores done, orders and requests decided, for the people who approve and the shared screen", async () => {
    const { household } = householdAt(EVENING);
    await household.as("Nick").call("complete_task", { task: idOf(household, "Take out the trash"), by: "Jak" });
    const asked = (await household.as("Jon").call("place_order", { items: [{ supply: "Hay" }] })) as { status: string; requestId: string };
    expect(asked.status).toBe("waiting_for_approval");
    await household.as("Nick").call("decide_approval", { request: asked.requestId, decision: "approve" });
    const since = EVENING.subtract({ minutes: 1 });
    const texts = async (who: string | null) => (await household.as(who).history!(since)).map((h) => `${h.who ?? "screen"}: ${h.text}`);
    const told = await texts("Holly");
    expect(told).toHaveLength(2);
    expect(told[0]).toBe("Jak: Take out the trash: done by Jak");
    expect(told[1]).toMatch(/^Nick: Nick approved Jon's request: Order 20 bales of hay from Valley Feed & Propane, \$290\.00, arriving /);
    expect(await texts(null)).toEqual(told);
    // A kid, the farm hand and a guest hear none of it.
    for (const who of ["Eli", "Jon", "guest"]) expect(await texts(who)).toEqual([]);
    // Only what came after `since`.
    expect(await household.as("Nick").history!(EVENING.add({ minutes: 1 }))).toEqual([]);
  });

  it("shows a parent what's waiting for them on the Today screen", async () => {
    const { household } = householdAt(EVENING);
    await household.as("Jon").call("place_order", { items: [{ supply: "Hay" }] });
    const nick = await todayView(household.as("Nick"));
    expect(nick.toDecide?.map((r) => r.from)).toEqual(["Jak", "Jon"]);
    expect(nick.toDecide?.[1]?.asks).toBe("Order 20 bales of hay from Valley Feed & Propane, $290.00");
    // A kid's Today screen has nothing to decide, and says nothing about it.
    expect((await todayView(household.as("Eli"))).toDecide).toBeUndefined();
  });
});
