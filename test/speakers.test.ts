import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import type { CorralApprovals } from "../src/approvals.ts";
import { ToolError, type CorralEvent, type CorralTask, type CorralWhere, type HouseholdTool } from "../src/household.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { actorFor, approversOf, GUEST_ROLE, PLAN_CHANGES, SCREEN_ROLE, speakerOf } from "../src/sample/roles.ts";

// Friday, October 16, 2026, 10:30 AM in Denver.
const FRIDAY = Temporal.Instant.from("2026-10-16T16:30:00Z");
const NEXT_FRIDAY = "2026-10-23";
const SLEEPOVER = { title: "Sleepover at Ava's", start: `${NEXT_FRIDAY}T18:00:00-06:00[America/Denver]`, end: "2026-10-24T10:00:00-06:00[America/Denver]", people: ["Maya"], location: "Ava's house" };

function household() {
  return new SampleHousehold({ now: () => FRIDAY });
}

const titles = (events: unknown) => (events as CorralEvent[]).map((e) => e.title);

async function taskId(h: SampleHousehold, title: string): Promise<string> {
  const tasks = (await h.as("Sam").call("tasks", { include_done: true })) as CorralTask[];
  return tasks.find((t) => t.title === title)!.id;
}

describe("who's speaking", () => {
  it("knows each person by their full or short name, however it's typed", () => {
    const h = household();
    expect(actorFor(h.state, "maya")).toMatchObject({ person: { shortName: "Maya" }, role: { name: "Kid" } });
    expect(actorFor(h.state, " Sam Rivera ")).toMatchObject({ person: { shortName: "Sam" }, role: { name: "Parent" } });
    expect(actorFor(h.state, "Jordan")).toMatchObject({ role: { name: "Farm hand" } });
  });

  it("makes anyone it doesn't know a guest, so a mistake never gets more than a guest may", () => {
    const h = household();
    for (const said of ["guest", "Grandma", "Sam Riviera", "admin"]) expect(actorFor(h.state, said)).toMatchObject({ person: null, role: { name: GUEST_ROLE } });
  });

  it("is the shared kitchen screen when no one is named", () => {
    const h = household();
    for (const said of [null, undefined, "", "  "]) expect(actorFor(h.state, said)).toMatchObject({ person: null, role: { name: SCREEN_ROLE } });
  });

  it("reads a URI-encoded name from the header, and takes a bad encoding as it is", () => {
    expect(speakerOf(encodeURIComponent("José Núñez"))).toBe("José Núñez");
    expect(speakerOf("%E0%A4%A")).toBe("%E0%A4%A");
    expect(speakerOf(null)).toBeNull();
  });

  it("keeps roles as data: every person's role is defined, and the approvers are whoever's role approves", () => {
    const h = household();
    for (const p of h.state.people) expect(h.state.roles.map((r) => r.name)).toContain(p.roles[0]);
    expect(approversOf(h.state).map((p) => p.shortName)).toEqual(["Sam", "Alex"]);
    // Changing the data changes the rule, with no code naming anyone.
    h.state.roles.find((r) => r.name === "Kid")!.approves = true;
    expect(approversOf(h.state).map((p) => p.shortName)).toEqual(["Sam", "Alex", "Maya", "Leo"]);
  });
});

describe("private events", () => {
  it("are in full for their owner and Busy for everyone else", async () => {
    const h = household();
    const noon = (events: unknown) => (events as CorralEvent[]).find((e) => e.when.startsWith("Fri, Oct 16, 12:00 PM"));
    expect(noon(await h.as("Sam").call("calendar", {}))).toMatchObject({ title: "Birthday gift shopping", people: ["Sam Rivera"], location: "Downtown", event: expect.any(String) });
    for (const who of ["Alex", "Maya", "guest"]) {
      expect(noon(await h.as(who).call("calendar", {}))).toEqual({ when: "Fri, Oct 16, 12:00 PM to 1:00 PM", title: "Busy (private, no details)", people: [], drivers: [], location: null, calendar: "Family" });
    }
    expect(noon(await h.call("calendar", {}))).toMatchObject({ title: "Busy (private, no details)" });
  });

  it("turn up in a search only for their owner", async () => {
    const h = household();
    expect(titles(await h.as("Sam").call("calendar", { search: "gift" }))).toEqual(["Birthday gift shopping"]);
    expect(await h.as("Alex").call("calendar", { search: "gift" })).toEqual([]);
  });
});

describe("the farm hand", () => {
  it("sees only the ranch calendar", async () => {
    const h = household();
    expect(titles(await h.as("Jordan").call("calendar", { from: "2026-10-16", to: "2026-10-22" }))).toEqual(["Farrier visit", "Hay delivery"]);
    expect(titles(await h.as("Sam").call("calendar", {}))).toContain("Soccer practice");
  });

  it("hears their own chores and ones up for grabs, and only where they are", async () => {
    const h = household();
    const tasks = (await h.as("Jordan").call("tasks", { include_done: true })) as CorralTask[];
    expect(tasks.map((t) => t.title)).toEqual(["Feed the horses (morning)", "Collect eggs", "Feed the horses (evening)", "Water the garden"]);
    expect(((await h.as("Jordan").call("whereabouts", {})) as CorralWhere[]).map((w) => w.name)).toEqual(["Jordan Blake"]);
    await expect(h.as("Jordan").call("whereabouts", { person: "Maya" })).rejects.toThrow("Where others are isn't shared with Jordan.");
  });

  it("adds to the ranch calendar right away, and only there", async () => {
    const h = household();
    expect(await h.as("Jordan").call("add_event", { title: "Vet for the mare", start: "2026-10-19T09:00" })).toMatchObject({ status: "done", summary: "Vet for the mare, Mon, Oct 19, 9:00 AM" });
    expect(titles(await h.as("Jordan").call("calendar", { from: "2026-10-19", to: "2026-10-19" }))).toEqual(["Vet for the mare"]);
    await expect(h.as("Jordan").call("add_event", { title: "Pizza", start: "2026-10-19T18:00", calendar: "Family" })).rejects.toThrow("Events go on the Ranch calendar.");
  });

  it("can't check off a chore they can't see", async () => {
    const h = household();
    const dishes = await taskId(h, "Empty the dishwasher");
    await expect(h.as("Jordan").call("complete_task", { task: dishes })).rejects.toThrow("Use the task's id from the tasks tool.");
  });
});

describe("a guest", () => {
  it("can read the day", async () => {
    const h = household();
    expect(titles(await h.as("guest").call("calendar", {}))).toContain("Soccer practice");
    expect(((await h.as("guest").call("tasks", {})) as CorralTask[]).length).toBeGreaterThan(0);
    expect(await h.as("guest").call("lists", {})).toEqual(["Groceries", "Feed store", "Hardware"]);
  });

  it("hears nothing about where people are", async () => {
    await expect(household().as("guest").call("whereabouts", {})).rejects.toThrow("Where people are is only for people in Juniper Hollow.");
  });

  it("changes nothing at all, check-offs included", async () => {
    const h = household();
    const eggs = await taskId(h, "Collect eggs");
    const tries: [HouseholdTool, Record<string, unknown>][] = [
      ["complete_task", { task: eggs }],
      ["claim_task", { task: eggs, by: "Leo" }],
      ["add_list_item", { text: "Cake" }],
      ["check_list_item", { text: "milk" }],
      ["add_event", SLEEPOVER],
      ["add_task", { title: "Feed the cat" }],
      ["update_supply", { supply: "Hay", change: "count", amount: 3 }],
      ["decide_approval", { request: h.state.requests[0]!.id, decision: "approve" }],
    ];
    for (const [tool, args] of tries) {
      await expect(h.as("Stranger").call(tool, args)).rejects.toThrow(new ToolError("Only people in Juniper Hollow can change things here, and this voice isn't one of them."));
    }
    expect(((await h.as("Sam").call("tasks", {})) as CorralTask[]).find((t) => t.id === eggs)?.status).toBe("overdue");
  });

  it("sees no requests, only who decides them", async () => {
    expect(await household().as("guest").call("approvals", {})).toEqual({ toDecide: [], yoursWaiting: [], requests: "Only people in Juniper Hollow see its requests." });
  });
});

describe("a kid's changes", () => {
  it("send an event to the parents to approve, leaving the calendar as it was", async () => {
    const h = household();
    const res = await h.as("Maya").call("add_event", SLEEPOVER);
    expect(res).toEqual({ status: "waiting_for_approval", summary: "Sleepover at Ava's, Fri, Oct 23, 6:00 PM", approvers: ["Sam", "Alex"], requestId: expect.any(String) });
    expect(titles(await h.as("Sam").call("calendar", { from: NEXT_FRIDAY, to: NEXT_FRIDAY }))).not.toContain("Sleepover at Ava's");
  });

  it("check chores off right away, with credit to them when it's up for grabs", async () => {
    const h = household();
    const eggs = await taskId(h, "Collect eggs");
    expect(await h.as("Maya").call("complete_task", { task: eggs })).toEqual({ status: "done", summary: "Collect eggs: done by Maya" });
    expect(await h.as("Maya").call("claim_task", { task: await taskId(h, "Water the garden") })).toEqual({ status: "done", summary: "Maya is taking Water the garden" });
    expect(await h.as("Leo").call("check_list_item", { text: "milk" })).toMatchObject({ status: "done" });
    expect(await h.as("Leo").call("update_supply", { supply: "Dog food", change: "used", amount: 1 })).toMatchObject({ status: "done" });
  });

  it("add a reminder for themselves right away, and one for someone else as a request", async () => {
    const h = household();
    expect(await h.as("Leo").call("add_task", { title: "Practice piano", assignees: ["Leo"] })).toMatchObject({ status: "done" });
    expect(await h.as("Leo").call("add_task", { title: "Drive me to Max's", assignees: ["Alex"] })).toMatchObject({ status: "waiting_for_approval", approvers: ["Sam", "Alex"] });
    expect(await h.as("Leo").call("add_task", { title: "Bake cookies" })).toMatchObject({ status: "waiting_for_approval" });
  });

  it("put a list item on the list as waiting, and skip a chore only with a yes", async () => {
    const h = household();
    expect(await h.as("Maya").call("add_list_item", { text: "marshmallows" })).toMatchObject({ status: "waiting_for_approval", summary: "Marshmallows on Groceries" });
    const items = ((await h.as("Maya").call("lists", { list: "Groceries" })) as { items: { text: string; waitingForApproval: boolean }[] }).items;
    expect(items.find((i) => i.text === "Marshmallows")?.waitingForApproval).toBe(true);
    const trash = await taskId(h, "Take out the trash");
    expect(await h.as("Maya").call("skip_task", { task: trash })).toMatchObject({ status: "waiting_for_approval", summary: "Skip Take out the trash" });
    expect(((await h.as("Sam").call("tasks", {})) as CorralTask[]).find((t) => t.id === trash)?.status).toBe("open");
  });

  it("happen right away for a parent", async () => {
    const h = household();
    expect(await h.as("Alex").call("add_event", SLEEPOVER)).toEqual({ status: "done", summary: "Sleepover at Ava's, Fri, Oct 23, 6:00 PM", event: expect.any(String) });
    expect(await h.as("Alex").call("add_list_item", { text: "marshmallows" })).toEqual({ status: "done", summary: "Added marshmallows to Groceries" });
  });
});

describe("approvals", () => {
  it("shows a parent what's waiting, oldest first, and a kid their own", async () => {
    const h = household();
    const { requestId } = (await h.as("Maya").call("add_event", SLEEPOVER)) as { requestId: string };
    const sam = (await h.as("Sam").call("approvals", {})) as CorralApprovals;
    expect(sam).toEqual({
      toDecide: [
        { id: expect.any(String), from: "Leo", asks: "Ice cream on Groceries", since: "Fri, Oct 16, 9:00 AM" },
        { id: requestId, from: "Maya", asks: "Sleepover at Ava's, Fri, Oct 23, 6:00 PM", since: "Fri, Oct 16, 10:30 AM" },
      ],
      yoursWaiting: [],
    });
    expect(await h.as("Maya").call("approvals", {})).toEqual({
      toDecide: [],
      yoursWaiting: [{ id: requestId, asks: "Sleepover at Ava's, Fri, Oct 23, 6:00 PM", since: "Fri, Oct 16, 10:30 AM", decidedBy: "Sam or Alex" }],
      requests: "Only Sam or Alex approve requests.",
    });
  });

  it("puts the sleepover on the calendar when a parent approves it", async () => {
    const h = household();
    const { requestId } = (await h.as("Maya").call("add_event", SLEEPOVER)) as { requestId: string };
    expect(await h.as("Sam").call("decide_approval", { request: requestId, decision: "approve" })).toEqual({ status: "done", summary: "Approved Maya's request: Sleepover at Ava's, Fri, Oct 23, 6:00 PM" });
    const friday = (await h.as("Maya").call("calendar", { from: NEXT_FRIDAY, to: NEXT_FRIDAY })) as CorralEvent[];
    expect(friday.find((e) => e.title === "Sleepover at Ava's")).toMatchObject({ when: "Fri, Oct 23, 6:00 PM to Sat, Oct 24, 10:00 AM", people: ["Maya Rivera"], location: "Ava's house", calendar: "Family" });
    expect(((await h.as("Sam").call("approvals", {})) as CorralApprovals).toDecide.map((r) => r.id)).not.toContain(requestId);
    expect(((await h.as("Maya").call("approvals", {})) as CorralApprovals).yoursWaiting).toEqual([]);
  });

  it("leaves the calendar alone when a parent declines, and can't be decided twice", async () => {
    const h = household();
    const { requestId } = (await h.as("Maya").call("add_event", SLEEPOVER)) as { requestId: string };
    expect(await h.as("Alex").call("decide_approval", { request: requestId, decision: "decline" })).toMatchObject({ summary: "Declined Maya's request: Sleepover at Ava's, Fri, Oct 23, 6:00 PM" });
    expect(titles(await h.as("Sam").call("calendar", { from: NEXT_FRIDAY, to: NEXT_FRIDAY }))).not.toContain("Sleepover at Ava's");
    await expect(h.as("Sam").call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("That request was already declined by Alex.");
  });

  it("approves a list item where it is, and takes a declined one off the list", async () => {
    const h = household();
    const [iceCream] = h.state.requests;
    const items = async () => ((await h.as("Sam").call("lists", { list: "Groceries" })) as { items: { text: string; waitingForApproval: boolean }[] }).items;
    await h.as("Sam").call("decide_approval", { request: iceCream!.id, decision: "approve" });
    expect((await items()).find((i) => i.text === "Ice cream")?.waitingForApproval).toBe(false);
    const { requestId } = (await h.as("Leo").call("add_list_item", { text: "soda" })) as { requestId: string };
    await h.as("Alex").call("decide_approval", { request: requestId, decision: "decline" });
    expect((await items()).map((i) => i.text)).not.toContain("Soda");
  });

  it("makes a skip and a task for someone else when approved", async () => {
    const h = household();
    const trash = await taskId(h, "Take out the trash");
    const skip = (await h.as("Maya").call("skip_task", { task: trash })) as { requestId: string };
    const ride = (await h.as("Leo").call("add_task", { title: "Drive me to Max's", assignees: ["Alex"], due: "2026-10-17T13:00" })) as { requestId: string };
    await h.as("Sam").call("decide_approval", { request: skip.requestId, decision: "approve" });
    await h.as("Sam").call("decide_approval", { request: ride.requestId, decision: "approve" });
    const tasks = (await h.as("Sam").call("tasks", { from: "2026-10-16", to: "2026-10-17", include_done: true })) as CorralTask[];
    expect(tasks.find((t) => t.id === trash)?.status).toBe("skipped");
    expect(tasks.find((t) => t.title === "Drive me to Max's")).toMatchObject({ assignees: ["Alex Rivera"], due: "Sat, Oct 17, 1:00 PM" });
  });

  it("is decided only by someone whose role approves, never by the one who asked", async () => {
    const h = household();
    const { requestId } = (await h.as("Maya").call("add_event", SLEEPOVER)) as { requestId: string };
    await expect(h.as("Maya").call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("They can't approve or decline their own request, which waits for Sam or Alex.");
    for (const who of ["Leo", "Jordan"]) {
      await expect(h.as(who).call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("Only Sam or Alex can approve or decline requests.");
    }
    await expect(h.call("decide_approval", { request: requestId, decision: "approve" })).rejects.toThrow("Requests aren't decided on a shared screen: Sam or Alex decide them as themselves.");
    expect(((await h.as("Alex").call("approvals", {})) as CorralApprovals).toDecide.map((r) => r.id)).toContain(requestId);
  });

  it("needs a request's id and a decision it knows", async () => {
    const h = household();
    await expect(h.as("Sam").call("decide_approval", { request: "nope", decision: "approve" })).rejects.toThrow("Use the request's id from the approvals tool.");
    await expect(h.as("Sam").call("decide_approval", { request: h.state.requests[0]!.id, decision: "maybe" })).rejects.toThrow('The decision is "approve" or "decline".');
  });

  it("follows the data for every change that can wait: an approver's own changes never do", async () => {
    // Every kind of plan change, by every person: it waits exactly when their role says so.
    for (const person of household().state.people) {
      for (const change of PLAN_CHANGES) {
        const h = household();
        const role = actorFor(h.state, person.shortName).role;
        const args: Record<string, unknown> =
          change === "add_event" ? { title: "Picnic", start: "2026-10-18", calendar: role.calendars === "*" ? undefined : role.calendars[0] } : change === "add_task" ? { title: "Rake leaves", assignees: ["Sam"] } : change === "add_list_item" ? { text: "Pickles" } : { task: await taskId(h, "Collect eggs") };
        const res = (await h.as(person.shortName).call(change, args)) as { status: string };
        const expected = role.approval[change] === "always" || (role.approval[change] === "for_others" && person.shortName !== "Sam") ? "waiting_for_approval" : "done";
        expect([person.shortName, change, res.status]).toEqual([person.shortName, change, expected]);
        if (role.approves) expect(res.status).toBe("done");
      }
    }
  });

  it("keeps the shared screen as it was: its events wait, and it decides nothing", async () => {
    const h = household();
    expect(await h.call("add_event", { title: "Bake sale", start: "2026-10-20" })).toMatchObject({ status: "waiting_for_approval", approvers: ["Sam", "Alex"] });
    expect(await h.call("add_list_item", { text: "Flour" })).toMatchObject({ status: "done" });
    expect(await h.call("approvals", {})).toEqual({ toDecide: [], yoursWaiting: [], requests: "Requests aren't decided on a shared screen: Sam or Alex decide them as themselves." });
    const sam = (await h.as("Sam").call("approvals", {})) as CorralApprovals;
    expect(sam.toDecide.find((r) => r.asks.startsWith("Bake sale"))?.from).toBe("The kitchen screen");
  });
});
