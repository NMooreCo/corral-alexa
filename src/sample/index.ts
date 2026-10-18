import { Temporal } from "temporal-polyfill";
import type { CorralApprovals } from "../approvals.ts";
import { ToolError, type CorralChange, type CorralEvent, type CorralTask, type CorralWhere, type Household, type HouseholdTool } from "../household.ts";
import { clock, dollars, isAllDay, unitAmount, whenLabel } from "./labels.ts";
import { actorFor, actorOf, approversOf, either, personNamed, type PlanChange, type SampleActor } from "./roles.ts";
import { seed, type SampleEvent, type SamplePerson, type SampleRequest, type SampleState, type SampleTask } from "./seed.ts";

type Args = Record<string, unknown>;

/** The tools that change something. A role that only reads gets none of them. */
const CHANGES = new Set<HouseholdTool>(["add_event", "add_task", "complete_task", "undo_task", "claim_task", "skip_task", "add_list_item", "check_list_item", "update_supply", "decide_approval"]);

/**
 * The sample household, answering Corral's tools the way Corral does, so the
 * bridge runs and demos with no Corral account. Every call comes from
 * someone: a person in the household (the simulated Echo Show says who Alexa
 * recognized), a guest, or, when no one's named, the shared kitchen screen.
 * Their role (see roles.ts) decides what they see and whether a change
 * happens now or waits for a parent to approve it.
 */
export class SampleHousehold implements Household {
  readonly state: SampleState;
  readonly decidesRequests = true;
  readonly #now: () => Temporal.Instant;

  constructor(opts: { now?: () => Temporal.Instant; timeZone?: string } = {}) {
    this.#now = opts.now ?? (() => Temporal.Now.instant());
    this.state = seed(this.#now(), opts.timeZone);
  }

  get name(): string {
    return this.state.name;
  }

  async about() {
    return { name: this.state.name, timeZone: this.state.timeZone };
  }

  /** As the shared kitchen screen: no one in particular. */
  async call(tool: HouseholdTool, args: Args): Promise<unknown> {
    return this.callAs(actorFor(this.state, null), tool, args);
  }

  /**
   * The household as one speaker hears it: a name in the household, "guest"
   * (or any name nobody here has) for a guest, nothing for the shared screen.
   */
  as(speaker: string | null | undefined): Household {
    return {
      name: this.name,
      decidesRequests: true,
      about: () => this.about(),
      call: (tool, args) => this.callAs(actorFor(this.state, speaker), tool, args),
    };
  }

  async callAs(actor: SampleActor, tool: HouseholdTool, args: Args): Promise<unknown> {
    if (CHANGES.has(tool) && !actor.role.changes) {
      throw new ToolError(actor.person ? `${actor.person.shortName} can look but not change things in ${this.state.name}.` : `Only people in ${this.state.name} can change things here, by voice or on the screen, and this voice isn't one of them.`);
    }
    switch (tool) {
      case "calendar":
        return this.calendar(actor, args);
      case "tasks":
        return this.tasks(actor, args);
      case "whereabouts":
        return this.whereabouts(actor, args);
      case "people":
        return this.state.people.map((p) => ({ name: p.name, shortName: p.shortName, roles: p.roles }));
      case "lists":
        return this.lists(args);
      case "points":
        return this.points();
      case "supplies":
        return this.supplies();
      case "add_event":
        return this.addEvent(actor, args);
      case "add_task":
        return this.addTask(actor, args);
      case "complete_task":
      case "undo_task":
      case "claim_task":
      case "skip_task":
        return this.markTask(actor, tool, args);
      case "add_list_item":
        return this.addListItem(actor, args);
      case "check_list_item":
        return this.checkListItem(args);
      case "update_supply":
        return this.updateSupply(args);
      case "approvals":
        return this.approvals(actor);
      case "decide_approval":
        return this.decide(actor, args);
    }
  }

  // ---------- Reading ----------

  private calendar(actor: SampleActor, args: Args): CorralEvent[] {
    const from = this.dateArg(args.from, this.today());
    const p = this.person(args.person);
    const search = typeof args.search === "string" && args.search.trim() ? args.search.trim().toLowerCase() : null;
    const to = this.dateArg(args.to, search ? from.add({ days: 30 }) : from);
    if (Temporal.PlainDate.compare(to, from) < 0) throw new ToolError("The end date is before the start date.");
    const last = Temporal.PlainDate.compare(to, from.add({ days: 61 })) > 0 ? from.add({ days: 61 }) : to;
    return this.state.events
      .filter((e) => this.seesCalendar(actor, e.calendar))
      .filter((e) => Temporal.PlainDate.compare(this.dayOf(e.start), last) <= 0 && Temporal.PlainDate.compare(this.dayOf(e.end), from) >= 0)
      .filter((e) => !p || e.people.length === 0 || e.people.includes(p.id) || e.drivers.includes(p.id))
      .filter((e) => !search || (this.seesDetails(actor, e) && e.title.toLowerCase().includes(search)))
      .sort((a, b) => this.instantOf(a.start).epochMilliseconds - this.instantOf(b.start).epochMilliseconds)
      .map((e) => {
        const when = this.eventWhen(e);
        // A private event says only that the time is taken: no id, no title, nobody named.
        if (!this.seesDetails(actor, e)) return { when, title: "Busy (private, no details)", people: [], drivers: [], location: null, calendar: e.calendar };
        return { event: e.id, when, title: e.title, people: e.people.map((id) => this.nameOf(id)), drivers: e.drivers.map((id) => this.nameOf(id)), location: e.location, calendar: e.calendar };
      });
  }

  /** "Fri, Oct 16, 3:30 PM to 4:45 PM", "Sat, Oct 17 (all day)", or with the end's day when it ends another day. */
  private eventWhen(e: SampleEvent): string {
    if (isAllDay(e.start)) return e.end === e.start || !isAllDay(e.end) ? `${whenLabel(e.start)} (all day)` : `${whenLabel(e.start)} to ${whenLabel(e.end)} (all day)`;
    const sameDay = Temporal.PlainDate.compare(this.dayOf(e.start), this.dayOf(e.end)) === 0;
    return `${whenLabel(e.start)} to ${sameDay ? clock(e.end) : whenLabel(e.end)}`;
  }

  private tasks(actor: SampleActor, args: Args): CorralTask[] {
    const from = this.dateArg(args.from, this.today());
    const to = this.dateArg(args.to, from);
    const last = Temporal.PlainDate.compare(to, from.add({ days: 30 })) > 0 ? from.add({ days: 30 }) : to;
    const p = this.person(args.person);
    const includeDone = args.include_done === true;
    return this.state.tasks
      .filter((t) => this.seesTask(actor, t))
      .filter((t) => {
        const day = this.dayOf(t.due);
        const inWindow = Temporal.PlainDate.compare(day, from) >= 0 && Temporal.PlainDate.compare(day, last) <= 0;
        // Open ones include anything overdue from before.
        const overdueBefore = t.status === "open" && Temporal.PlainDate.compare(day, from) < 0;
        return inWindow || overdueBefore;
      })
      .filter((t) => includeDone || t.status === "open")
      .filter((t) => !p || t.assignees === "anyone" || t.assignees.includes(p.id))
      .sort((a, b) => this.dueOrder(a) - this.dueOrder(b))
      .map((t) => this.task(t));
  }

  private task(t: SampleTask): CorralTask {
    return {
      id: t.id,
      title: t.title,
      due: whenLabel(t.due),
      status: this.overdue(t) ? "overdue" : t.status,
      assignees: t.assignees === "anyone" ? ["anyone"] : t.assignees.map((id) => this.nameOf(id)),
      doneBy: t.doneBy ? this.nameOf(t.doneBy) : null,
      ...(t.asks ? { asks: t.asks } : {}),
    };
  }

  private whereabouts(actor: SampleActor, args: Args): CorralWhere[] {
    let p = this.person(args.person);
    if (actor.role.whereabouts === "own") {
      if (!actor.person) throw new ToolError(`Where people are is only for people in ${this.state.name}.`);
      if (p && p.id !== actor.person.id) throw new ToolError(`Where others are isn't shared with ${actor.person.shortName}.`);
      p = actor.person;
    }
    let at = this.#now();
    if (typeof args.at === "string" && args.at) {
      try {
        at = Temporal.PlainDateTime.from(args.at).toZonedDateTime(this.state.timeZone).toInstant();
      } catch {
        throw new ToolError(`"${args.at}" isn't a local time; use YYYY-MM-DDTHH:MM.`);
      }
    }
    return (p ? [p] : this.state.people).map((person) => {
      const stays = this.state.stays.filter((s) => s.person === person.id);
      const i = stays.findIndex((s) => Temporal.Instant.compare(s.start, at) <= 0 && Temporal.Instant.compare(at, s.end) < 0);
      const stay = stays[i];
      const next = stays[i + 1];
      if (!stay) return { name: person.name, location: "Not known", until: null };
      const until = next ? whenLabel(stay.end.toZonedDateTimeISO(this.state.timeZone).toString()) : null;
      return { name: person.name, location: stay.location, until, ...(next && next.location !== stay.location ? { then: next.location } : {}) };
    });
  }

  private lists(args: Args) {
    if (typeof args.list !== "string" || !args.list) return this.state.lists.map((l) => l.name);
    const list = this.list(args.list);
    return {
      list: list.name,
      items: list.items.filter((it) => !it.done).map((it) => ({ text: it.text, quantity: it.quantity, waitingForApproval: !it.approved })),
    };
  }

  private points() {
    const kids = this.state.balances.map((b) => ({ name: this.shortNameOf(b.person), has: [`${b.points} points`, `${dollars(b.allowanceCents)} of allowance`] }));
    return { balances: kids, turnsInto: [`${this.state.pointsPerFiveDollars} points make $5.00 of allowance`] };
  }

  private supplies() {
    return this.state.supplies.map((s) => {
      const daysLeft = Math.floor(s.quantity / s.perDay);
      return {
        id: s.id,
        name: s.name,
        quantity: s.quantity,
        unit: s.unit,
        onHand: unitAmount(s.quantity, s.unit),
        daysLeft,
        runsOut: this.today().add({ days: daysLeft }).toString(),
        low: s.quantity <= s.lowAt,
        onList: s.onList,
      };
    });
  }

  // ---------- Changing ----------

  /** Whether this change waits for an approver, by the actor's role. `forOthers`: it's for someone besides them. */
  private waits(actor: SampleActor, change: PlanChange, forOthers: boolean): boolean {
    const rule = actor.role.approval[change];
    return rule === "always" || (rule === "for_others" && forOthers);
  }

  /** Keeps a change as a request for an approver, and says so, the way Corral answers. */
  private hold(actor: SampleActor, tool: PlanChange, args: Args, summary: string): CorralChange {
    const id = crypto.randomUUID();
    this.state.requests.push({ id, from: actor.person?.id ?? null, summary, at: this.#now().toZonedDateTimeISO(this.state.timeZone).toString(), change: { tool, args }, status: "pending" });
    return { status: "waiting_for_approval", summary, approvers: this.approvers().filter((p) => p.id !== actor.person?.id).map((p) => p.shortName), requestId: id };
  }

  /** `approved`: an approver said yes to it, so it happens now whoever asked. */
  private addEvent(actor: SampleActor, args: Args, approved = false): CorralChange {
    const title = this.titled(args.title, "New event");
    const start = this.wire(args.start, "start");
    const end = args.end ? this.wire(args.end, "end") : isAllDay(start) ? start : Temporal.ZonedDateTime.from(start).add({ hours: 1 }).toString();
    if (Temporal.Instant.compare(this.instantOf(end), this.instantOf(start)) < 0) throw new ToolError("The end is before the start.");
    const names = Array.isArray(args.people) ? args.people.filter((n): n is string => typeof n === "string") : [];
    const members = names.map((n) => personNamed(this.state, n)).filter((p): p is SamplePerson => Boolean(p));
    const guests = names.filter((n) => !personNamed(this.state, n));
    const titleWithGuests = guests.length ? `${title} with ${guests.join(" and ")}` : title;
    const calendar = this.calendarFor(actor, args.calendar);
    const location = typeof args.location === "string" && args.location.trim() ? args.location.trim().slice(0, 200) : null;
    const summary = `${titleWithGuests}, ${whenLabel(start)}`;
    if (!approved && this.waits(actor, "add_event", true)) return this.hold(actor, "add_event", { title, start, end, people: names, calendar, location }, summary);
    const id = crypto.randomUUID();
    this.state.events.push({ id, title: titleWithGuests, start, end, people: members.map((p) => p.id), drivers: [], location, calendar });
    return { status: "done", summary, event: id };
  }

  private addTask(actor: SampleActor, args: Args, approved = false): CorralChange {
    const title = this.titled(args.title, "New task");
    const due = args.due ? this.wire(args.due, "due time") : this.today().toString();
    const named = Array.isArray(args.assignees) ? args.assignees.map((n) => this.person(n)).filter((p): p is SamplePerson => Boolean(p)) : [];
    const assignees = named.length ? named.map((p) => p.id) : "anyone";
    const summary = `${title}, due ${whenLabel(due)}`;
    const forOthers = assignees === "anyone" || assignees.some((id) => id !== actor.person?.id);
    if (!approved && this.waits(actor, "add_task", forOthers)) return this.hold(actor, "add_task", { title, due, assignees: named.map((p) => p.shortName) }, summary);
    this.state.tasks.push({ id: crypto.randomUUID(), title, due, assignees, status: "open", doneBy: null });
    return { status: "done", summary };
  }

  private markTask(actor: SampleActor, tool: "complete_task" | "undo_task" | "claim_task" | "skip_task", args: Args, approved = false): CorralChange {
    const t = this.state.tasks.find((x) => x.id === args.task);
    if (!t || !this.seesTask(actor, t)) throw new ToolError("Use the task's id from the tasks tool.");
    const by = this.person(args.by);
    switch (tool) {
      case "complete_task": {
        t.status = "done";
        // Credit goes to whoever's named, else the one person it's for, else whoever's speaking; a shared screen itself is nobody.
        t.doneBy = by?.id ?? (t.assignees !== "anyone" && t.assignees.length === 1 ? t.assignees[0]! : (actor.person?.id ?? null));
        if (args.values && typeof args.values === "object" && !Array.isArray(args.values)) t.captured = args.values as Record<string, unknown>;
        return { status: "done", summary: `${t.title}: done${t.doneBy ? ` by ${this.shortNameOf(t.doneBy)}` : ""}` };
      }
      case "undo_task":
        t.status = "open";
        t.doneBy = null;
        delete t.captured;
        return { status: "done", summary: `${t.title}: not done` };
      case "claim_task": {
        const taker = by ?? actor.person;
        if (!taker) throw new ToolError("Say who's taking it.");
        if (t.status !== "open") throw new ToolError(`${t.title} isn't open.`);
        t.assignees = [taker.id];
        return { status: "done", summary: `${taker.shortName} is taking ${t.title}` };
      }
      case "skip_task":
        if (!approved && this.waits(actor, "skip_task", true)) return this.hold(actor, "skip_task", { task: t.id }, `Skip ${t.title}`);
        t.status = "skipped";
        return { status: "done", summary: `Skipped ${t.title}` };
    }
  }

  private addListItem(actor: SampleActor, args: Args): CorralChange {
    const text = String(args.text ?? "").trim().slice(0, 300);
    if (!text) throw new ToolError("Say what to add.");
    const list = typeof args.list === "string" && args.list ? this.list(args.list) : this.state.lists[0]!;
    const quantity = typeof args.quantity === "string" && args.quantity.trim() ? args.quantity.trim().slice(0, 40) : null;
    const there = list.items.find((it) => !it.done && it.text.toLowerCase() === text.toLowerCase());
    if (there) {
      if (quantity) there.quantity = quantity;
      return { status: "done", summary: `${there.text} is already on ${list.name}` };
    }
    const item = text.charAt(0).toUpperCase() + text.slice(1);
    // Waiting, it's on the list for everyone to see, marked as waiting for a parent.
    const waits = this.waits(actor, "add_list_item", true);
    list.items.push({ text: item, quantity, done: false, approved: !waits });
    if (waits) return this.hold(actor, "add_list_item", { list: list.name, text: item }, `${item} on ${list.name}`);
    return { status: "done", summary: `Added ${text} to ${list.name}` };
  }

  private checkListItem(args: Args): CorralChange {
    const text = String(args.text ?? "").trim().toLowerCase();
    const lists = typeof args.list === "string" && args.list ? [this.list(args.list)] : this.state.lists;
    const open = lists.flatMap((l) => l.items.filter((it) => !it.done).map((it) => ({ l, it })));
    const found = open.find(({ it }) => it.text.toLowerCase() === text) ?? open.find(({ it }) => it.text.toLowerCase().includes(text) && text.length > 0);
    if (!found) throw new ToolError(`"${args.text}" isn't on ${lists.length === 1 ? lists[0]!.name : "any list"}.`);
    found.it.done = true;
    return { status: "done", summary: `Checked off ${found.it.text} on ${found.l.name}` };
  }

  private updateSupply(args: Args): CorralChange {
    const said = String(args.supply ?? "").trim().toLowerCase();
    const s = this.state.supplies.find((x) => x.id === args.supply || x.name.toLowerCase() === said) ?? this.state.supplies.find((x) => said && x.name.toLowerCase().includes(said));
    if (!s) throw new ToolError(`There's no supply called "${args.supply}" here. Look it up with the supplies tool.`);
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new ToolError("Give an amount of 0 or more.");
    if (args.change === "used") s.quantity = Math.max(0, s.quantity - amount);
    else if (args.change === "added") s.quantity += amount;
    else if (args.change === "count") s.quantity = amount;
    else throw new ToolError('The change is "used", "added" or "count".');
    return { status: "done", summary: `${s.name}: ${unitAmount(s.quantity, s.unit)} left` };
  }

  // ---------- Approvals ----------

  private approvers(): SamplePerson[] {
    return approversOf(this.state);
  }

  /** Who decides requests, besides `me`: "Sam or Alex". */
  private decidedBy(me?: SamplePerson | null): string {
    return either(this.approvers().filter((p) => p.id !== me?.id).map((p) => p.shortName));
  }

  /** What's waiting for this actor to decide, and what of theirs waits for someone else. */
  private approvals(actor: SampleActor): CorralApprovals {
    const me = actor.person;
    const pending = this.state.requests.filter((r) => r.status === "pending").sort((a, b) => this.instantOf(a.at).epochMilliseconds - this.instantOf(b.at).epochMilliseconds);
    const decides = Boolean(me && actor.role.approves);
    const toDecide = decides ? pending.filter((r) => r.from !== me!.id).map((r) => ({ id: r.id, from: this.askedBy(r), asks: r.summary, since: whenLabel(r.at) })) : [];
    const yoursWaiting = me ? pending.filter((r) => r.from === me.id).map((r) => ({ id: r.id, asks: r.summary, since: whenLabel(r.at), decidedBy: this.decidedBy(me) })) : [];
    if (decides) return { toDecide, yoursWaiting };
    // Why there's nothing to decide here, without saying what waits.
    const requests = me ? `Only ${this.decidedBy()} approve requests.` : actor.role.changes ? this.screenNote() : `Only people in ${this.state.name} see its requests.`;
    return { toDecide, yoursWaiting, requests };
  }

  private screenNote(): string {
    return `Requests aren't decided on a shared screen: ${this.decidedBy()} decide them as themselves.`;
  }

  private decide(actor: SampleActor, args: Args): CorralChange {
    const me = actor.person;
    if (!me) throw new ToolError(this.screenNote());
    const r = this.state.requests.find((x) => x.id === args.request);
    if (!actor.role.approves) {
      if (r?.from === me.id) throw new ToolError(`They can't approve or decline their own request, which waits for ${this.decidedBy(me)}.`);
      throw new ToolError(`Only ${this.decidedBy()} can approve or decline requests.`);
    }
    if (!r) throw new ToolError("Use the request's id from the approvals tool.");
    if (r.status !== "pending") throw new ToolError(`That request was already ${r.status}${r.decidedBy ? ` by ${this.shortNameOf(r.decidedBy)}` : ""}.`);
    if (args.decision !== "approve" && args.decision !== "decline") throw new ToolError('The decision is "approve" or "decline".');
    // Approving makes the change as it was asked, as whoever asked; if it can't happen now, the request stays.
    if (args.decision === "approve") this.apply(r);
    else this.discard(r);
    r.status = args.decision === "approve" ? "approved" : "declined";
    r.decidedBy = me.id;
    const asker = r.from ? `${this.shortNameOf(r.from)}'s` : `${this.state.actingAs}'s`;
    return { status: "done", summary: `${args.decision === "approve" ? "Approved" : "Declined"} ${asker} request: ${r.summary}` };
  }

  private apply(r: SampleRequest): void {
    const from = r.from ? this.state.people.find((p) => p.id === r.from) : undefined;
    const asker = from ? actorOf(this.state, from) : actorFor(this.state, null);
    const { tool, args } = r.change;
    if (tool === "add_event") this.addEvent(asker, args, true);
    else if (tool === "add_task") this.addTask(asker, args, true);
    else if (tool === "skip_task") this.markTask(asker, "skip_task", args, true);
    else {
      const item = this.waitingItem(r);
      if (item) item.approved = true;
    }
  }

  /** Declining a list item takes it back off the list; anything else was never made. */
  private discard(r: SampleRequest): void {
    if (r.change.tool !== "add_list_item") return;
    const item = this.waitingItem(r);
    const list = this.state.lists.find((l) => l.items.includes(item!));
    if (item && list) list.items.splice(list.items.indexOf(item), 1);
  }

  private waitingItem(r: SampleRequest) {
    const list = this.state.lists.find((l) => l.name === r.change.args.list);
    const text = String(r.change.args.text ?? "").toLowerCase();
    return list?.items.find((it) => !it.approved && it.text.toLowerCase() === text);
  }

  /** "Maya", or "The kitchen screen". */
  private askedBy(r: SampleRequest): string {
    if (r.from) return this.shortNameOf(r.from);
    return this.state.actingAs.charAt(0).toUpperCase() + this.state.actingAs.slice(1);
  }

  // ---------- What a role sees ----------

  private seesCalendar(actor: SampleActor, calendar: string): boolean {
    return actor.role.calendars === "*" || actor.role.calendars.includes(calendar);
  }

  /** A private event in full is its owner's alone. */
  private seesDetails(actor: SampleActor, e: SampleEvent): boolean {
    return !e.private || (actor.person !== null && e.owner === actor.person.id);
  }

  private seesTask(actor: SampleActor, t: SampleTask): boolean {
    if (actor.role.tasks === "everyone" || t.assignees === "anyone") return true;
    return actor.person !== null && t.assignees.includes(actor.person.id);
  }

  /** The calendar a new event goes on: the one named, if this actor sees it, else the first they see. */
  private calendarFor(actor: SampleActor, said: unknown): string {
    const sees = this.state.calendars.filter((c) => this.seesCalendar(actor, c));
    if (typeof said !== "string" || !said.trim()) {
      if (!sees[0]) throw new ToolError("There's no calendar to add it to.");
      return sees[0];
    }
    const named = this.state.calendars.find((c) => c.toLowerCase() === said.trim().toLowerCase());
    if (!named || !sees.includes(named)) {
      throw new ToolError(sees.length === 1 ? `Events go on the ${sees[0]} calendar.` : `There's no calendar called "${said}". Calendars: ${sees.join(", ")}.`);
    }
    return named;
  }

  // ---------- Helpers ----------

  private today(): Temporal.PlainDate {
    return this.#now().toZonedDateTimeISO(this.state.timeZone).toPlainDate();
  }

  private dateArg(v: unknown, fallback: Temporal.PlainDate): Temporal.PlainDate {
    if (typeof v !== "string" || !v) return fallback;
    try {
      return Temporal.PlainDate.from(v);
    } catch {
      throw new ToolError(`"${v}" isn't a date; use YYYY-MM-DD.`);
    }
  }

  /** A start or due time as a model wrote it: zoned, a date for all day, or a local time here. */
  private wire(v: unknown, what: string): string {
    const s = String(v ?? "").trim();
    if (isAllDay(s)) return s;
    try {
      return Temporal.ZonedDateTime.from(s).withTimeZone(this.state.timeZone).toString();
    } catch {
      try {
        return Temporal.PlainDateTime.from(s).toZonedDateTime(this.state.timeZone).toString();
      } catch {
        throw new ToolError(`"${s}" isn't a valid ${what}.`);
      }
    }
  }

  private dayOf(wire: string): Temporal.PlainDate {
    return isAllDay(wire) ? Temporal.PlainDate.from(wire) : Temporal.ZonedDateTime.from(wire).toPlainDate();
  }

  private instantOf(wire: string): Temporal.Instant {
    return isAllDay(wire) ? Temporal.PlainDate.from(wire).toZonedDateTime(this.state.timeZone).toInstant() : Temporal.ZonedDateTime.from(wire).toInstant();
  }

  /** Due in order, with an all-day task after the timed ones that day. */
  private dueOrder(t: SampleTask): number {
    return isAllDay(t.due) ? this.instantOf(t.due).add({ hours: 23, minutes: 59 }).epochMilliseconds : this.instantOf(t.due).epochMilliseconds;
  }

  private overdue(t: SampleTask): boolean {
    if (t.status !== "open") return false;
    if (isAllDay(t.due)) return Temporal.PlainDate.compare(Temporal.PlainDate.from(t.due), this.today()) < 0;
    return Temporal.Instant.compare(Temporal.ZonedDateTime.from(t.due).toInstant(), this.#now()) < 0;
  }

  private titled(v: unknown, fallback: string): string {
    const s = String(v ?? "").trim().slice(0, 300);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : fallback;
  }

  /** The person named, or none when nobody was named; a name nobody here has is a mistake to say. */
  private person(v: unknown): SamplePerson | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    const p = typeof v === "string" ? personNamed(this.state, v) : undefined;
    if (!p) throw new ToolError(`No one named "${String(v)}" lives here.`);
    return p;
  }

  private nameOf(id: string): string {
    return this.state.people.find((p) => p.id === id)?.name ?? "Someone";
  }

  private shortNameOf(id: string): string {
    return this.state.people.find((p) => p.id === id)?.shortName ?? "Someone";
  }

  private list(said: string) {
    // "grocery", "the groceries list" and "Groceries" are all the same list.
    const plain = (v: string) =>
      v
        .toLowerCase()
        .replace(/\b(the|list)\b/g, "")
        .replace(/[^a-z ]/g, "")
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/ies$/, "y").replace(/s$/, ""))
        .join(" ");
    const s = plain(said);
    const list = this.state.lists.find((l) => plain(l.name) === s) ?? this.state.lists.find((l) => s && (plain(l.name).includes(s) || s.includes(plain(l.name))));
    if (!list) throw new ToolError(`There's no list called "${said}". Lists: ${this.state.lists.map((l) => l.name).join(", ")}.`);
    return list;
  }
}
