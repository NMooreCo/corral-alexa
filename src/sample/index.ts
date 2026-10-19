import { Temporal } from "temporal-polyfill";
import type { CorralApprovals } from "../approvals.ts";
import { ToolError, type CorralChange, type CorralEvent, type CorralSupply, type CorralTask, type CorralWhere, type Household, type HouseholdHistoryEntry, type HouseholdTool } from "../household.ts";
import { amountWords, and, lineWords, quote, type CorralOrder, type CorralReorder, type CorralSupplyOrder, type Supplier } from "../orders.ts";
import { clock, dollars, isAllDay, unitAmount, whenLabel } from "./labels.ts";
import { actorFor, actorOf, approversOf, either, personNamed, refusalFor, type PlanChange, type RequestChange, type SampleActor } from "./roles.ts";
import { seed, type SampleEvent, type SampleOrder, type SamplePerson, type SampleRequest, type SampleState, type SampleStay, type SampleSupply, type SampleTask } from "./seed.ts";
import { SampleSupplier } from "./supplier.ts";
import { now as clockNow } from "../clock.ts";

type Args = Record<string, unknown>;

/** The tools that change something. A role that only reads gets none of them. */
const CHANGES = new Set<HouseholdTool>(["add_event", "add_task", "complete_task", "undo_task", "claim_task", "skip_task", "add_list_item", "check_list_item", "update_supply", "decide_approval", "place_order"]);

/** The most supplies one order asks for. */
const MAX_ORDER_ITEMS = 12;

/** The most history a household keeps. */
const MAX_HISTORY = 60;

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
  readonly placesOrders = true;
  readonly #now: () => Temporal.Instant;
  /** The stores it orders supplies from: the sample's own made-up store, unless others are given. */
  readonly #suppliers: Supplier[];
  /** Requests being decided right now. */
  readonly #deciding = new Set<string>();

  /** A fresh household laid out around today, or `state` as it was kept. */
  constructor(opts: { now?: () => Temporal.Instant; timeZone?: string; state?: SampleState; suppliers?: Supplier[] } = {}) {
    this.#now = opts.now ?? clockNow;
    this.state = opts.state ?? seed(this.#now(), opts.timeZone);
    this.#suppliers = opts.suppliers ?? [new SampleSupplier({ now: this.#now, timeZone: this.state.timeZone })];
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
      placesOrders: true,
      about: () => this.about(),
      call: (tool, args) => this.callAs(actorFor(this.state, speaker), tool, args),
      refusal: (action) => refusalFor(this.state, actorFor(this.state, speaker), action),
      history: async (since) => this.historyFor(actorFor(this.state, speaker), since),
    };
  }

  /**
   * What's happened since `since`, oldest first: chores done, orders placed,
   * requests decided (what's only asked waits in approvals). The household's
   * history is about everyone (who did which chore, who ordered what), so it's for the
   * people who approve requests and for the shared screen; anyone else hears
   * none of it.
   */
  async history(since: Temporal.Instant): Promise<HouseholdHistoryEntry[]> {
    return this.historyFor(actorFor(this.state, null), since);
  }

  /** History as one actor may hear it (see history). */
  historyFor(actor: SampleActor, since: Temporal.Instant): HouseholdHistoryEntry[] {
    if (actor.person ? !actor.role.approves : !actor.role.changes) return [];
    return this.state.history
      .filter((h) => Temporal.Instant.compare(this.instantOf(h.at), since) >= 0)
      .map((h) => ({ at: h.at, who: h.who ? this.shortNameOf(h.who) : null, text: h.text }));
  }

  /** Keeps something that happened, for history. */
  private note(who: string | null, text: string): void {
    this.state.history.push({ at: this.#now().toZonedDateTimeISO(this.state.timeZone).toString(), who, text });
    if (this.state.history.length > MAX_HISTORY) this.state.history.splice(0, this.state.history.length - MAX_HISTORY);
  }

  /**
   * Moves the household on to a new day, keeping what happened (orders,
   * requests, history): each daily chore gets today's, yesterday's still-open
   * one is closed the way a missed repeat is, and a one-off from before stays
   * as it was. Call it once the household's clock reads the new day.
   */
  nextDay(): void {
    const today = this.today();
    const shift = (wire: string, days: number) => (isAllDay(wire) ? Temporal.PlainDate.from(wire).add({ days }).toString() : Temporal.ZonedDateTime.from(wire).add({ days }).toString());
    const daily = this.state.tasks.filter((t) => t.repeats === "daily");
    // The latest day each daily chore was set for; today's comes from it, once.
    const latest = new Map<string, SampleTask>();
    for (const t of daily) {
      const seen = latest.get(t.title);
      if (!seen || Temporal.PlainDate.compare(this.dayOf(t.due), this.dayOf(seen.due)) > 0) latest.set(t.title, t);
    }
    for (const t of latest.values()) {
      const gap = today.since(this.dayOf(t.due)).days;
      if (gap <= 0) continue;
      const { captured: _done, ...chore } = structuredClone(t);
      this.state.tasks.push({ ...chore, id: crypto.randomUUID(), due: shift(t.due, gap), status: "open", doneBy: null });
    }
    for (const t of daily) {
      if (t.status === "open" && Temporal.PlainDate.compare(this.dayOf(t.due), today) < 0) t.status = "skipped";
    }
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
      case "orders":
        return this.orders();
      case "place_order":
        return this.placeOrder(actor, args);
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
      const stays = this.timeline(person.id);
      const i = stays.findIndex((s) => Temporal.Instant.compare(s.start, at) <= 0 && Temporal.Instant.compare(at, s.end) < 0);
      const stay = stays[i];
      // Only a stretch that follows straight on says where they go next; past the schedule's end, nobody knows.
      const next = stay && stays[i + 1]?.start.equals(stay.end) ? stays[i + 1] : undefined;
      if (!stay) return { name: person.name, location: "Not known", until: null };
      const until = next ? whenLabel(stay.end.toZonedDateTimeISO(this.state.timeZone).toString()) : null;
      return { name: person.name, location: stay.location, until, ...(next && next.location !== stay.location ? { then: next.location } : {}) };
    });
  }

  /**
   * Where someone is over time: their usual stays, with the timed events they
   * go to laid over them, so the calendar and whereabouts never disagree. A
   * private event never says where; back-to-back stretches at one place are one.
   */
  private timeline(person: string): SampleStay[] {
    const before = (a: Temporal.Instant, b: Temporal.Instant) => Temporal.Instant.compare(a, b) < 0;
    let stays = this.state.stays.filter((s) => s.person === person).map((s) => ({ ...s }));
    for (const e of this.state.events) {
      if (!e.location || e.private || isAllDay(e.start) || !e.people.includes(person)) continue;
      const start = Temporal.ZonedDateTime.from(e.start).toInstant();
      const end = Temporal.ZonedDateTime.from(e.end).toInstant();
      const kept: SampleStay[] = [];
      for (const s of stays) {
        if (!before(start, s.end) || !before(s.start, end)) kept.push(s);
        else {
          if (before(s.start, start)) kept.push({ ...s, end: start });
          if (before(end, s.end)) kept.push({ ...s, start: end });
        }
      }
      kept.push({ person, location: e.location, start, end });
      stays = kept.sort((a, b) => Temporal.Instant.compare(a.start, b.start));
    }
    const merged: SampleStay[] = [];
    for (const s of stays) {
      const last = merged.at(-1);
      if (last && last.location === s.location && last.end.equals(s.start)) last.end = s.end;
      else merged.push(s);
    }
    return merged;
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

  private async supplies(): Promise<CorralSupply[]> {
    const reorders = await this.reorders();
    return this.state.supplies.map((s) => {
      const daysLeft = Math.floor(s.quantity / s.perDay);
      const onOrder = this.onOrder(s);
      const reorder = reorders.get(s.name.toLowerCase());
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
        ...(onOrder ? { onOrder } : {}),
        ...(reorder ? { reorder } : {}),
      };
    });
  }

  /** How each supply a store sells is usually ordered, by its name in lowercase; the first store that sells it says. A store that doesn't answer just says nothing. */
  private async reorders(): Promise<Map<string, CorralReorder>> {
    const out = new Map<string, CorralReorder>();
    const catalogs = await Promise.all(this.#suppliers.map(async (supplier) => ({ supplier, products: await supplier.catalog().catch(() => []) })));
    for (const { supplier, products } of catalogs) {
      for (const p of products) {
        const key = p.supply.trim().toLowerCase();
        if (out.has(key) || !this.state.supplies.some((s) => s.name.toLowerCase() === key)) continue;
        out.set(key, { supplier: supplier.name, amount: amountWords(p.usualQuantity, p.unit), price: dollars(p.usualQuantity * p.unitPriceCents), arrives: whenLabel(this.today().add({ days: p.deliveryDays }).toString()) });
      }
    }
    return out;
  }

  /** The order for a supply that hasn't come yet: the placed one that comes soonest, else one waiting for a yes. */
  private onOrder(s: SampleSupply): CorralSupplyOrder | null {
    const open = this.state.orders
      .filter((o) => this.orderStatus(o) !== "delivered" && o.lines.some((l) => l.supply.toLowerCase() === s.name.toLowerCase()))
      .sort((a, b) => (a.deliveryDate ?? "9999").localeCompare(b.deliveryDate ?? "9999"));
    const o = open[0];
    if (!o) return null;
    const line = o.lines.find((l) => l.supply.toLowerCase() === s.name.toLowerCase())!;
    return {
      order: o.id,
      amount: amountWords(line.quantity, line.unit),
      supplier: o.supplier.name,
      arrives: o.deliveryDate ? whenLabel(o.deliveryDate) : null,
      arrivesOn: o.deliveryDate,
      ...(o.status === "waiting_for_approval" ? { waitingFor: this.waitingFor(o) } : {}),
    };
  }

  /** Every order, in words: waiting ones first, then what's coming soonest, then what's come. */
  private orders(): CorralOrder[] {
    const rank = { waiting_for_approval: 0, placed: 1, delivered: 2 } as const;
    return this.state.orders
      .map((o) => ({ o, status: this.orderStatus(o) }))
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.status === "delivered" ? -1 : 1) * (a.o.deliveryDate ?? a.o.at).localeCompare(b.o.deliveryDate ?? b.o.at))
      .map(({ o, status }) => ({
        id: o.id,
        supplier: o.supplier.name,
        items: o.lines.map(lineWords),
        total: dollars(o.totalCents),
        totalCents: o.totalCents,
        status,
        arrives: o.deliveryDate ? whenLabel(o.deliveryDate) : null,
        by: o.by ? this.shortNameOf(o.by) : this.screenName(),
        ...(status === "waiting_for_approval" ? { waitingFor: this.waitingFor(o) } : {}),
        live: o.supplier.live,
      }));
  }

  /** A placed order is delivered once its delivery day comes, in the household's time zone. */
  private orderStatus(o: SampleOrder): CorralOrder["status"] {
    if (o.status === "placed" && o.deliveryDate && Temporal.PlainDate.compare(Temporal.PlainDate.from(o.deliveryDate), this.today()) <= 0) return "delivered";
    return o.status;
  }

  /** Who can say yes to a waiting order: anyone who approves, besides whoever placed it. */
  private waitingFor(o: SampleOrder): string {
    return this.decidedBy(o.by ? this.state.people.find((p) => p.id === o.by) : null);
  }

  // ---------- Changing ----------

  /** Whether this change waits for an approver, by the actor's role. `forOthers`: it's for someone besides them. */
  private waits(actor: SampleActor, change: PlanChange, forOthers: boolean): boolean {
    const rule = actor.role.approval[change];
    return rule === "always" || (rule === "for_others" && forOthers);
  }

  /** Keeps a change as a request for an approver, and says so, the way Corral answers; `note` says why, when that's worth saying. */
  private hold(actor: SampleActor, tool: RequestChange, args: Args, summary: string, note?: string): CorralChange & { status: "waiting_for_approval" } {
    const id = crypto.randomUUID();
    this.state.requests.push({ id, from: actor.person?.id ?? null, summary, at: this.#now().toZonedDateTimeISO(this.state.timeZone).toString(), change: { tool, args }, status: "pending" });
    return { status: "waiting_for_approval", summary, approvers: this.approvers().filter((p) => p.id !== actor.person?.id).map((p) => p.shortName), requestId: id, ...(note ? { note } : {}) };
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
        this.note(t.doneBy, `${t.title}: done${t.doneBy ? ` by ${this.shortNameOf(t.doneBy)}` : ""}`);
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

  /** A supply by its id or however someone says its name, or none. */
  private supplyNamed(v: unknown): SampleSupply | undefined {
    const said = String(v ?? "").trim().toLowerCase();
    return this.state.supplies.find((x) => x.id === v || x.name.toLowerCase() === said) ?? this.state.supplies.find((x) => said && x.name.toLowerCase().includes(said));
  }

  private updateSupply(args: Args): CorralChange {
    const s = this.supplyNamed(args.supply);
    if (!s) throw new ToolError(`There's no supply called "${args.supply}" here. Look it up with the supplies tool.`);
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new ToolError("Give an amount of 0 or more.");
    if (args.change === "used") s.quantity = Math.max(0, s.quantity - amount);
    else if (args.change === "added") s.quantity += amount;
    else if (args.change === "count") s.quantity = amount;
    else throw new ToolError('The change is "used", "added" or "count".');
    return { status: "done", summary: `${s.name}: ${unitAmount(s.quantity, s.unit)} left` };
  }

  // ---------- Ordering ----------

  /**
   * Orders supplies from one of the household's stores. Someone whose role
   * doesn't order (a kid, the farm hand, the shared screen) asks instead, so
   * it waits for a parent; an order over the household's limit waits for
   * someone besides whoever placed it. Otherwise it's placed with the store
   * now, and the answer says what it cost and when it comes.
   */
  private async placeOrder(actor: SampleActor, args: Args): Promise<CorralChange> {
    const raw = Array.isArray(args.items) ? args.items : [];
    if (!raw.length || raw.length > MAX_ORDER_ITEMS) throw new ToolError(`Say what to order: one to ${MAX_ORDER_ITEMS} of the supplies from the supplies tool.`);
    const items = raw.map((it) => {
      const item = (it && typeof it === "object" ? it : { supply: it }) as Args;
      const s = this.supplyNamed(item.supply);
      if (!s) throw new ToolError(`There's no supply called "${String(item.supply ?? "")}" here to order. Supplies: ${this.state.supplies.map((x) => x.name).join(", ")}.`);
      return { supply: s.name, quantity: item.quantity };
    });
    const q = await quote(this.#suppliers, items, { supplier: args.supplier, today: this.today() });
    const what = `${and(q.lines.map(lineWords))} from ${q.supplier.name}`;
    const order: SampleOrder = {
      id: crypto.randomUUID(),
      supplier: { id: q.supplier.id, name: q.supplier.name, live: q.supplier.live },
      lines: q.lines,
      totalCents: q.totalCents,
      by: actor.person?.id ?? null,
      at: this.#now().toZonedDateTimeISO(this.state.timeZone).toString(),
      status: "waiting_for_approval",
      deliveryDate: null,
      reference: null,
      request: null,
    };

    const limit = this.state.orderLimitCents;
    const overLimit = limit !== null && q.totalCents > limit;
    if (!actor.role.orders || overLimit) {
      const others = this.approvers().filter((p) => p.id !== actor.person?.id);
      const over = overLimit ? `It's ${dollars(q.totalCents)}, over ${this.state.name}'s ${dollars(limit!)} limit for one order` : "";
      if (overLimit && actor.role.orders && !others.length) throw new ToolError(`${over}, and no one else here approves requests, so nothing was ordered.`);
      // A kid's order waits anyway; the limit is worth saying only when it's why.
      const note = overLimit && actor.role.orders ? `${over}, so ${either(others.map((p) => p.shortName))} decides.` : undefined;
      const held = this.hold(actor, "place_order", { order: order.id }, `Order ${what}, ${dollars(q.totalCents)}`, note);
      order.request = held.requestId;
      this.state.orders.push(order);
      return held;
    }
    await this.send(order);
    this.state.orders.push(order);
    const arrives = whenLabel(order.deliveryDate!);
    this.note(actor.person?.id ?? null, `Ordered ${what}, ${dollars(order.totalCents)}, arriving ${arrives}`);
    return { status: "done", summary: `Ordered ${what}: ${dollars(order.totalCents)}, arriving ${arrives}`, order: order.id, total: dollars(order.totalCents), arrives };
  }

  /** Places an order with its store, and keeps what the store answered. If the store won't take it, nothing changes. */
  private async send(order: SampleOrder): Promise<void> {
    const supplier = this.#suppliers.find((s) => s.id === order.supplier.id);
    if (!supplier) throw new ToolError(`${order.supplier.name} isn't one of ${this.state.name}'s stores anymore, so nothing was ordered.`);
    let receipt;
    try {
      receipt = await supplier.placeOrder(order.lines.map((l) => ({ product: l.product, quantity: l.quantity })));
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`${supplier.name} didn't take the order just now, so nothing was ordered. Try again in a moment.`);
    }
    order.status = "placed";
    order.deliveryDate = receipt.deliveryDate;
    order.reference = receipt.reference;
    order.totalCents = receipt.totalCents;
  }

  // ---------- Approvals ----------

  private approvers(): SamplePerson[] {
    return approversOf(this.state);
  }

  /** Who decides requests, besides `me`: "Nick or Holly". */
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

  private async decide(actor: SampleActor, args: Args): Promise<CorralChange> {
    const me = actor.person;
    if (!me) throw new ToolError(this.screenNote());
    const r = this.state.requests.find((x) => x.id === args.request);
    // No one decides their own request, a parent's big order included.
    if (r?.from === me.id) throw new ToolError(`They can't approve or decline their own request, which waits for ${this.decidedBy(me)}.`);
    if (!actor.role.approves) throw new ToolError(`Only ${this.decidedBy()} can approve or decline requests.`);
    if (!r) throw new ToolError("Use the request's id from the approvals tool.");
    if (r.status !== "pending") throw new ToolError(`That request was already ${r.status}${r.decidedBy ? ` by ${this.shortNameOf(r.decidedBy)}` : ""}.`);
    if (args.decision !== "approve" && args.decision !== "decline") throw new ToolError('The decision is "approve" or "decline".');
    // Approving makes the change as it was asked, as whoever asked; if it can't happen now, the request stays.
    // An order waits on its store, so a second yes while the first is still out can't place it twice.
    if (this.#deciding.has(r.id)) throw new ToolError("That request is being decided right now.");
    this.#deciding.add(r.id);
    let placed: SampleOrder | null = null;
    try {
      if (args.decision === "approve") placed = await this.apply(r);
      else this.discard(r);
    } finally {
      this.#deciding.delete(r.id);
    }
    r.status = args.decision === "approve" ? "approved" : "declined";
    r.decidedBy = me.id;
    const asker = r.from ? `${this.shortNameOf(r.from)}'s` : `${this.state.actingAs}'s`;
    const summary = `${args.decision === "approve" ? "Approved" : "Declined"} ${asker} request: ${r.summary}`;
    this.note(me.id, `${me.shortName} ${args.decision === "approve" ? "approved" : "declined"} ${asker} request: ${r.summary}${placed?.deliveryDate ? `, arriving ${whenLabel(placed.deliveryDate)}` : ""}`);
    if (!placed?.deliveryDate) return { status: "done", summary };
    const arrives = whenLabel(placed.deliveryDate);
    return { status: "done", summary: `${summary}. It arrives ${arrives}.`, order: placed.id, arrives };
  }

  /** Makes the change a request asked for. An order is placed with its store, and comes back so the answer can say when it arrives. */
  private async apply(r: SampleRequest): Promise<SampleOrder | null> {
    const from = r.from ? this.state.people.find((p) => p.id === r.from) : undefined;
    const asker = from ? actorOf(this.state, from) : actorFor(this.state, null);
    const { tool, args } = r.change;
    if (tool === "add_event") this.addEvent(asker, args, true);
    else if (tool === "add_task") this.addTask(asker, args, true);
    else if (tool === "skip_task") this.markTask(asker, "skip_task", args, true);
    else if (tool === "place_order") {
      const order = this.waitingOrder(r);
      if (!order) throw new ToolError("That order isn't waiting anymore.");
      await this.send(order);
      return order;
    } else {
      const item = this.waitingItem(r);
      if (item) item.approved = true;
    }
    return null;
  }

  /** Declining a list item takes it back off the list, and declining an order takes it off the orders; anything else was never made. */
  private discard(r: SampleRequest): void {
    if (r.change.tool === "place_order") {
      const order = this.waitingOrder(r);
      if (order) this.state.orders.splice(this.state.orders.indexOf(order), 1);
      return;
    }
    if (r.change.tool !== "add_list_item") return;
    const item = this.waitingItem(r);
    const list = this.state.lists.find((l) => l.items.includes(item!));
    if (item && list) list.items.splice(list.items.indexOf(item), 1);
  }

  private waitingOrder(r: SampleRequest): SampleOrder | undefined {
    return this.state.orders.find((o) => o.request === r.id && o.status === "waiting_for_approval");
  }

  private waitingItem(r: SampleRequest) {
    const list = this.state.lists.find((l) => l.name === r.change.args.list);
    const text = String(r.change.args.text ?? "").toLowerCase();
    return list?.items.find((it) => !it.approved && it.text.toLowerCase() === text);
  }

  /** "Eli", or "The kitchen screen". */
  private askedBy(r: SampleRequest): string {
    return r.from ? this.shortNameOf(r.from) : this.screenName();
  }

  /** "The kitchen screen", for something no one in particular did. */
  private screenName(): string {
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
