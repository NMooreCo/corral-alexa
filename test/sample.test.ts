import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { ToolError, type CorralEvent, type CorralTask, type CorralWhere, type HouseholdTool } from "../src/household.ts";
import { SampleHousehold } from "../src/sample/index.ts";

// Friday, October 16, 2026, 10:30 AM in Denver.
const FRIDAY = Temporal.Instant.from("2026-10-16T16:30:00Z");
// Saturday, October 17, 2026, 10:30 AM in Denver.
const SATURDAY = Temporal.Instant.from("2026-10-17T16:30:00Z");

function household(at = FRIDAY) {
  return new SampleHousehold({ now: () => at });
}

async function taskId(h: SampleHousehold, title: string): Promise<string> {
  const tasks = (await h.call("tasks", { include_done: true })) as CorralTask[];
  return tasks.find((t) => t.title === title)!.id;
}

describe("the sample household's calendar", () => {
  it("says today's events in order, in Corral's words", async () => {
    const events = (await household().call("calendar", {})) as CorralEvent[];
    expect(events.map((e) => e.title)).toEqual(["School drop-off", "Farrier visit", "Busy (private, no details)", "Soccer practice", "Family movie night"]);
    expect(events[3]).toMatchObject({ when: "Fri, Oct 16, 3:30 PM to 4:45 PM", people: ["Eli Rivera"], drivers: ["Nick Rivera"], location: "Riverside Fields", calendar: "Family" });
    expect(events[3]!.event).toEqual(expect.any(String));
  });

  it("keeps a private event to Busy: no id, no title, nobody named", async () => {
    const busy = ((await household().call("calendar", {})) as CorralEvent[])[2]!;
    expect(busy).toEqual({ when: "Fri, Oct 16, 12:00 PM to 1:00 PM", title: "Busy (private, no details)", people: [], drivers: [], location: null, calendar: "Family" });
  });

  it("finds a private event by neither its title nor its owner's search", async () => {
    expect(await household().call("calendar", { search: "gift" })).toEqual([]);
    const found = (await household().call("calendar", { search: "movie" })) as CorralEvent[];
    expect(found.map((e) => e.title)).toEqual(["Family movie night"]);
  });

  it("gives one person's day with what's for everyone", async () => {
    const eli = (await household().call("calendar", { person: "eli" })) as CorralEvent[];
    expect(eli.map((e) => e.title)).toEqual(["School drop-off", "Soccer practice", "Family movie night"]);
  });

  it("says an all-day event as all day", async () => {
    const events = (await household().call("calendar", { from: "2026-10-18", to: "2026-10-18" })) as CorralEvent[];
    expect(events).toEqual([expect.objectContaining({ title: "Hay delivery", when: "Sun, Oct 18 (all day)" })]);
  });

  it("refuses a name nobody here has and a date that isn't one", async () => {
    await expect(household().call("calendar", { person: "Pat" })).rejects.toThrow(new ToolError('No one named "Pat" lives here.'));
    await expect(household().call("calendar", { from: "next friday" })).rejects.toThrow(ToolError);
  });

  it("has no school run on a weekend", async () => {
    const events = (await household(SATURDAY).call("calendar", {})) as CorralEvent[];
    expect(events.map((e) => e.title)).not.toContain("School drop-off");
  });
});

describe("the sample household's chores", () => {
  it("marks what's past due as overdue and leaves done ones out unless asked", async () => {
    const open = (await household().call("tasks", {})) as CorralTask[];
    expect(open.find((t) => t.title === "Give Leia the allergy pill")).toMatchObject({ status: "overdue", assignees: ["Eli Rivera"], due: "Fri, Oct 16, 8:00 AM" });
    expect(open.find((t) => t.title === "Collect eggs")).toMatchObject({ status: "overdue", assignees: ["anyone"], asks: [{ key: "eggs", label: "Eggs", type: "number" }] });
    expect(open.find((t) => t.title === "Empty the dishwasher")?.status).toBe("open");
    expect(open.some((t) => t.status === "done")).toBe(false);
    const all = (await household().call("tasks", { include_done: true })) as CorralTask[];
    expect(all.find((t) => t.title === "Feed the horses (morning)")).toMatchObject({ status: "done", doneBy: "Jon Blake" });
  });

  it("checks a chore off with credit to whoever did it, and undoes it", async () => {
    const h = household();
    const id = await taskId(h, "Collect eggs");
    expect(await h.call("complete_task", { task: id, by: "Jak", values: { eggs: 7 } })).toEqual({ status: "done", summary: "Collect eggs: done by Jak" });
    expect(((await h.call("tasks", { include_done: true })) as CorralTask[]).find((t) => t.id === id)).toMatchObject({ status: "done", doneBy: "Jak Rivera" });
    await h.call("undo_task", { task: id });
    expect(((await h.call("tasks", {})) as CorralTask[]).find((t) => t.id === id)).toMatchObject({ status: "overdue", doneBy: null });
  });

  it("credits a chore for one person to them when nobody's named", async () => {
    const h = household();
    const id = await taskId(h, "Empty the dishwasher");
    expect(await h.call("complete_task", { task: id })).toMatchObject({ summary: "Empty the dishwasher: done by Jak" });
  });

  it("needs someone named to take a chore, since a shared screen is nobody", async () => {
    const h = household();
    const id = await taskId(h, "Water the garden");
    await expect(h.call("claim_task", { task: id })).rejects.toThrow("Say who's taking it.");
    expect(await h.call("claim_task", { task: id, by: "Eli" })).toMatchObject({ summary: "Eli is taking Water the garden" });
  });

  it("refuses a task id it doesn't have", async () => {
    await expect(household().call("complete_task", { task: "nope" })).rejects.toThrow("Use the task's id from the tasks tool.");
  });
});

describe("changes from the sample's shared screen", () => {
  it("sends a new event to a parent to approve, leaving the calendar as it was", async () => {
    const h = household();
    const before = await h.call("calendar", { from: "2026-10-22", to: "2026-10-22" });
    const res = await h.call("add_event", { title: "dentist", start: "2026-10-22T15:30:00-06:00[America/Denver]", people: ["Jak", "Grandma"] });
    expect(res).toEqual({ status: "waiting_for_approval", summary: "Dentist with Grandma, Thu, Oct 22, 3:30 PM", approvers: ["Nick", "Holly"], requestId: expect.any(String) });
    expect(await h.call("calendar", { from: "2026-10-22", to: "2026-10-22" })).toEqual(before);
  });

  it("reads a local time without a zone as the household's", async () => {
    const res = await household().call("add_event", { title: "Call the vet", start: "2026-10-19T09:00" });
    expect(res).toMatchObject({ summary: "Call the vet, Mon, Oct 19, 9:00 AM" });
  });

  it("adds a task right away", async () => {
    const h = household();
    expect(await h.call("add_task", { title: "buy a birthday card", assignees: ["Holly"] })).toEqual({ status: "done", summary: "Buy a birthday card, due Fri, Oct 16" });
    const tasks = (await h.call("tasks", {})) as CorralTask[];
    expect(tasks.find((t) => t.title === "Buy a birthday card")).toMatchObject({ assignees: ["Holly Rivera"], status: "open" });
  });
});

describe("the sample household's lists and supplies", () => {
  it("lists the lists, and what's on one, with what waits for a parent", async () => {
    const h = household();
    expect(await h.call("lists", {})).toEqual(["Groceries", "Feed store", "Hardware"]);
    const groceries = (await h.call("lists", { list: "groceries" })) as { items: { text: string; waitingForApproval: boolean }[] };
    expect(groceries.items.find((i) => i.text === "Ice cream")?.waitingForApproval).toBe(true);
  });

  it("knows a list however it's said", async () => {
    const h = household();
    for (const said of ["grocery", "the grocery list", "Groceries", "groceries list"]) {
      expect(await h.call("lists", { list: said })).toMatchObject({ list: "Groceries" });
    }
    expect(await h.call("lists", { list: "feed" })).toMatchObject({ list: "Feed store" });
    await expect(h.call("lists", { list: "camping" })).rejects.toThrow(/no list called "camping"/);
  });

  it("adds to a list and checks an item off by its words", async () => {
    const h = household();
    expect(await h.call("add_list_item", { list: "Groceries", text: "eggs", quantity: "a dozen" })).toEqual({ status: "done", summary: "Added eggs to Groceries" });
    expect(await h.call("check_list_item", { text: "milk" })).toEqual({ status: "done", summary: "Checked off Milk on Groceries" });
    const items = ((await h.call("lists", { list: "Groceries" })) as { items: { text: string }[] }).items.map((i) => i.text);
    expect(items).toContain("Eggs");
    expect(items).not.toContain("Milk");
    await expect(h.call("check_list_item", { text: "caviar" })).rejects.toThrow('"caviar" isn\'t on any list.');
  });

  it("counts supplies used and says when they run out", async () => {
    const h = household();
    const before = ((await h.call("supplies", {})) as { name: string; onHand: string; daysLeft: number; low: boolean }[]).find((s) => s.name === "Horse feed")!;
    expect(before).toMatchObject({ onHand: "6 bags", daysLeft: 9, low: false });
    expect(await h.call("update_supply", { supply: "horse feed", change: "used", amount: 4 })).toEqual({ status: "done", summary: "Horse feed: 2 bags left" });
    const after = ((await h.call("supplies", {})) as { name: string; onHand: string; low: boolean; runsOut: string }[]).find((s) => s.name === "Horse feed")!;
    expect(after).toMatchObject({ onHand: "2 bags", low: true, runsOut: "2026-10-19" });
  });

  it("says points and what they turn into", async () => {
    expect(await household().call("points", {})).toEqual({
      balances: [
        { name: "Eli", has: ["140 points", "$12.50 of allowance"] },
        { name: "Jak", has: ["85 points", "$4.00 of allowance"] },
      ],
      turnsInto: ["100 points make $5.00 of allowance"],
    });
  });
});

describe("what the sample household takes and keeps", () => {
  it("refuses text longer than it keeps, too many names and oversized answers, in words, and changes nothing", async () => {
    const h = household();
    const nick = h.as("Nick");
    const eggs = await taskId(h, "Collect eggs");
    const before = JSON.stringify(h.state);
    const long = "x".repeat(201);
    const refusals: [string, Record<string, unknown>, string][] = [
      ["add_event", { title: long, start: "2026-10-17" }, "That title is too long: say it in 200 characters or fewer."],
      ["add_event", { title: "Picnic", start: "2026-10-17", location: long }, "That place is too long: say it in 200 characters or fewer."],
      ["add_event", { title: "Picnic", start: "2026-10-17", people: Array.from({ length: 11 }, (_, i) => `Guest ${i}`) }, "Name at most 10 people for one event."],
      ["add_event", { title: "Picnic", start: "2026-10-17", people: ["y".repeat(61)] }, "A name is at most 60 characters."],
      ["add_task", { title: long }, "That title is too long: say it in 200 characters or fewer."],
      ["add_list_item", { list: "Groceries", text: long }, "That item is too long: say it in 200 characters or fewer."],
      ["add_list_item", { list: "Groceries", text: "Salsa", quantity: "z".repeat(41) }, 'Say how much in 40 characters or fewer, like "2 gallons".'],
      ["complete_task", { task: eggs, values: { note: "e".repeat(1000) } }, 'What a task asks for goes in values by key, like {"eggs": 9}: at most 12 answers, in under 1,000 characters.'],
      ["complete_task", { task: eggs, values: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])) }, "at most 12 answers"],
      ["update_supply", { supply: "hay", change: "added", amount: 1e308 }, "Give an amount from 0 to 100,000."],
    ];
    for (const [tool, args, said] of refusals) await expect(nick.call(tool as HouseholdTool, args), tool).rejects.toThrow(said);
    expect(JSON.stringify(h.state)).toBe(before);
    // Within the limits, it all goes in, and someone named three ways is named once.
    await nick.call("complete_task", { task: eggs, values: { eggs: 9 } });
    expect(await nick.call("add_task", { title: "y".repeat(200), assignees: ["Jak", "jak", "Jak Rivera"] })).toMatchObject({ status: "done" });
    expect(h.state.tasks.at(-1)!.assignees).toEqual([h.state.people.find((p) => p.shortName === "Jak")!.id]);
  });

  it("holds as many events, tasks and list items as it keeps, and only the latest checked-off ones", async () => {
    const h = household();
    const nick = h.as("Nick");
    h.state.events.push(...Array.from({ length: 200 - h.state.events.length }, (_, i) => ({ ...h.state.events[0]!, id: `filler-${i}` })));
    await expect(nick.call("add_event", { title: "Picnic", start: "2026-10-17" })).rejects.toThrow("The calendar here holds at most 200 events, so nothing was added.");
    h.state.tasks.push(...Array.from({ length: 200 - h.state.tasks.length }, (_, i) => ({ ...h.state.tasks[7]!, id: `filler-${i}` })));
    await expect(nick.call("add_task", { title: "Fix the gate" })).rejects.toThrow("The task list here holds at most 200 tasks, so nothing was added.");

    const groceries = h.state.lists[0]!;
    for (let i = groceries.items.filter((it) => !it.done).length; i < 50; i++) await nick.call("add_list_item", { list: "Groceries", text: `Thing ${i}` });
    await expect(nick.call("add_list_item", { list: "Groceries", text: "One more thing" })).rejects.toThrow("Groceries already has 50 things on it. Check some off before adding more.");
    // Saying something that's already there still works, and checking things off makes room.
    expect(await nick.call("add_list_item", { list: "Groceries", text: "milk" })).toMatchObject({ summary: "Milk is already on Groceries" });
    for (let i = 10; i < 40; i++) await nick.call("check_list_item", { list: "Groceries", text: `Thing ${i}` });
    expect(h.state.lists[0]!.items.filter((it) => it.done).map((it) => it.text)).toEqual(Array.from({ length: 20 }, (_, i) => `Thing ${i + 20}`));
    expect(await nick.call("add_list_item", { list: "Groceries", text: "One more thing" })).toMatchObject({ status: "done" });
  });

  it("lets only so many requests wait, keeps only the latest decided ones, and asks nothing it can't keep", async () => {
    const h = household();
    const waiting = h.state.requests[0]!;
    h.state.requests.push(...Array.from({ length: 29 }, (_, i) => ({ ...waiting, id: `waiting-${i}` })));
    const listBefore = JSON.stringify(h.state.lists);
    // Jak's asks wait for a parent: the 31st isn't sent, and nothing goes on the list for it.
    await expect(h.as("Jak").call("add_list_item", { list: "Groceries", text: "Candy" })).rejects.toThrow("30 requests are already waiting to be decided, so this one wasn't sent. Decide some of those first.");
    expect(JSON.stringify(h.state.lists)).toBe(listBefore);
    h.state.requests.push(...Array.from({ length: 35 }, (_, i) => ({ ...waiting, id: `decided-${i}`, status: "declined" as const, decidedBy: h.state.people[0]!.id })));
    await h.as("Holly").call("decide_approval", { request: "waiting-0", decision: "decline" });
    // The one just decided stays, with the latest asked of the rest.
    expect(h.state.requests.filter((r) => r.status !== "pending").map((r) => r.id)).toEqual(["waiting-0", ...Array.from({ length: 29 }, (_, i) => `decided-${i + 6}`)]);
    expect(await h.as("Jak").call("add_list_item", { list: "Groceries", text: "Candy" })).toMatchObject({ status: "waiting_for_approval" });
  });

  it("lets only so many orders be open, and keeps only the latest delivered ones", async () => {
    const h = household();
    const order = (id: string, deliveryDate: string) => ({
      id,
      supplier: { id: "sample.valley-feed", name: "Valley Feed & Propane", live: false },
      lines: [{ supply: "Hay", product: "hay-bale", unit: "bale", quantity: 20, unitPriceCents: 1450 }],
      totalCents: 29_000,
      by: null,
      at: "2026-10-15T09:00:00-06:00[America/Denver]",
      status: "placed" as const,
      deliveryDate,
      reference: null,
      request: null,
    });
    h.state.orders.push(...Array.from({ length: 25 }, (_, i) => order(`delivered-${i}`, "2026-10-15")));
    h.state.orders.push(...Array.from({ length: 20 }, (_, i) => order(`coming-${i}`, "2026-10-18")));
    await expect(h.as("Nick").call("place_order", { items: [{ supply: "hay" }] })).rejects.toThrow("20 orders are already on their way or waiting for a yes, so nothing was ordered.");
    h.state.orders = h.state.orders.filter((o) => o.id !== "coming-0");
    expect(await h.as("Nick").call("place_order", { items: [{ supply: "hay" }] })).toMatchObject({ status: "done" });
    expect(h.state.orders.filter((o) => o.id.startsWith("delivered-")).map((o) => o.id)).toEqual(Array.from({ length: 20 }, (_, i) => `delivered-${i + 5}`));
    expect(h.state.orders).toHaveLength(20 + 20);
  });
});

describe("the sample household's whereabouts", () => {
  it("says where each person is, until when, and where they go next", async () => {
    const where = (await household().call("whereabouts", {})) as CorralWhere[];
    expect(where.find((w) => w.name === "Eli Rivera")).toEqual({ name: "Eli Rivera", location: "School", until: "Fri, Oct 16, 3:20 PM", then: "Riverside Fields" });
    expect(where.find((w) => w.name === "Jon Blake")).toMatchObject({ location: "Barn", until: "Fri, Oct 16, 4:00 PM", then: "Off the ranch" });
  });

  it("treats staying put over midnight as one stay", async () => {
    const where = (await household().call("whereabouts", { person: "Nick" })) as CorralWhere[];
    expect(where).toEqual([{ name: "Nick Rivera", location: "Home", until: null }]);
  });

  it("answers for another time", async () => {
    const [jak] = (await household().call("whereabouts", { person: "Jak", at: "2026-10-16T18:00" })) as CorralWhere[];
    expect(jak).toMatchObject({ location: "Home" });
  });

  it("follows the calendar, so a weekend practice puts Eli at the field", async () => {
    const [eli] = (await household(SATURDAY).call("whereabouts", { person: "Eli", at: "2026-10-17T16:35" })) as CorralWhere[];
    expect(eli).toEqual({ name: "Eli Rivera", location: "Riverside Fields", until: "Sat, Oct 17, 4:45 PM", then: "Home" });
  });

  it("never says where a private event is", async () => {
    const [nick] = (await household().call("whereabouts", { person: "Nick", at: "2026-10-16T12:30" })) as CorralWhere[];
    expect(nick).toMatchObject({ location: "Home" });
  });

  it("puts someone at an event's place on a day their usual schedule has them elsewhere", async () => {
    const [jon] = (await household(SATURDAY).call("whereabouts", { person: "Jon" })) as CorralWhere[];
    expect(jon).toEqual({ name: "Jon Blake", location: "Barn", until: "Sat, Oct 17, 11:00 AM", then: "Off the ranch" });
  });
});
