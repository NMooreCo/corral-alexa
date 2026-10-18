import { Temporal } from "temporal-polyfill";
import { ToolError, type CorralChange, type CorralEvent, type CorralTask, type CorralTool, type CorralWhere, type Household } from "../household.ts";
import { clock, dollars, isAllDay, unitAmount, whenLabel } from "./labels.ts";
import { seed, type SamplePerson, type SampleState, type SampleTask } from "./seed.ts";

type Args = Record<string, unknown>;

/**
 * The sample household, answering Corral's tools the way Corral does, so the
 * bridge runs and demos with no Corral account. It acts as a shared kitchen
 * screen: it sees what the adults see, except private events, which read as
 * Busy; check-offs and list changes happen right away; and anything it puts
 * on the calendar goes to a parent to approve.
 */
export class SampleHousehold implements Household {
  readonly state: SampleState;
  readonly #now: () => Temporal.Instant;

  /** A fresh household laid out around today, or `state` as it was kept. */
  constructor(opts: { now?: () => Temporal.Instant; timeZone?: string; state?: SampleState } = {}) {
    this.#now = opts.now ?? (() => Temporal.Now.instant());
    this.state = opts.state ?? seed(this.#now(), opts.timeZone);
  }

  get name(): string {
    return this.state.name;
  }

  async about() {
    return { name: this.state.name, timeZone: this.state.timeZone };
  }

  async call(tool: CorralTool, args: Args): Promise<unknown> {
    switch (tool) {
      case "calendar":
        return this.calendar(args);
      case "tasks":
        return this.tasks(args);
      case "whereabouts":
        return this.whereabouts(args);
      case "people":
        return this.state.people.map((p) => ({ name: p.name, shortName: p.shortName, roles: p.roles }));
      case "lists":
        return this.lists(args);
      case "points":
        return this.points();
      case "supplies":
        return this.supplies();
      case "add_event":
        return this.addEvent(args);
      case "add_task":
        return this.addTask(args);
      case "complete_task":
      case "undo_task":
      case "claim_task":
      case "skip_task":
        return this.markTask(tool, args);
      case "add_list_item":
        return this.addListItem(args);
      case "check_list_item":
        return this.checkListItem(args);
      case "update_supply":
        return this.updateSupply(args);
    }
  }

  // ---------- Reading ----------

  private calendar(args: Args): CorralEvent[] {
    const from = this.dateArg(args.from, this.today());
    const p = this.person(args.person);
    const search = typeof args.search === "string" && args.search.trim() ? args.search.trim().toLowerCase() : null;
    const to = this.dateArg(args.to, search ? from.add({ days: 30 }) : from);
    if (Temporal.PlainDate.compare(to, from) < 0) throw new ToolError("The end date is before the start date.");
    const last = Temporal.PlainDate.compare(to, from.add({ days: 61 })) > 0 ? from.add({ days: 61 }) : to;
    return this.state.events
      .filter((e) => Temporal.PlainDate.compare(this.dayOf(e.start), last) <= 0 && Temporal.PlainDate.compare(this.dayOf(e.end), from) >= 0)
      .filter((e) => !p || e.people.length === 0 || e.people.includes(p.id) || e.drivers.includes(p.id))
      .filter((e) => !search || (!e.private && e.title.toLowerCase().includes(search)))
      .sort((a, b) => this.instantOf(a.start).epochMilliseconds - this.instantOf(b.start).epochMilliseconds)
      .map((e) => {
        const when = isAllDay(e.start) ? `${whenLabel(e.start)} (all day)` : `${whenLabel(e.start)} to ${clock(e.end)}`;
        // A private event says only that the time is taken: no id, no title, nobody named.
        if (e.private) return { when, title: "Busy (private, no details)", people: [], drivers: [], location: null, calendar: e.calendar };
        return { event: e.id, when, title: e.title, people: e.people.map((id) => this.nameOf(id)), drivers: e.drivers.map((id) => this.nameOf(id)), location: e.location, calendar: e.calendar };
      });
  }

  private tasks(args: Args): CorralTask[] {
    const from = this.dateArg(args.from, this.today());
    const to = this.dateArg(args.to, from);
    const last = Temporal.PlainDate.compare(to, from.add({ days: 30 })) > 0 ? from.add({ days: 30 }) : to;
    const p = this.person(args.person);
    const includeDone = args.include_done === true;
    return this.state.tasks
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

  private whereabouts(args: Args): CorralWhere[] {
    const p = this.person(args.person);
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

  /** Putting something on the calendar from a shared screen goes to a parent to approve. */
  private addEvent(args: Args): CorralChange {
    const title = this.titled(args.title, "New event");
    const start = this.wire(args.start, "start");
    const names = Array.isArray(args.people) ? args.people.filter((n): n is string => typeof n === "string") : [];
    const guests = names.filter((n) => !this.findPerson(n));
    const titleWithGuests = guests.length ? `${title} with ${guests.join(" and ")}` : title;
    const summary = `${titleWithGuests}, ${whenLabel(start)}`;
    const requestId = crypto.randomUUID();
    this.state.requests.push({ id: requestId, summary });
    return { status: "waiting_for_approval", summary, approvers: this.state.approvers, requestId };
  }

  private addTask(args: Args): CorralChange {
    const title = this.titled(args.title, "New task");
    const due = args.due ? this.wire(args.due, "due time") : this.today().toString();
    const assignees = Array.isArray(args.assignees) && args.assignees.length ? args.assignees.map((n) => this.person(n)!.id) : "anyone";
    this.state.tasks.push({ id: crypto.randomUUID(), title, due, assignees, status: "open", doneBy: null });
    return { status: "done", summary: `${title}, due ${whenLabel(due)}` };
  }

  private markTask(tool: "complete_task" | "undo_task" | "claim_task" | "skip_task", args: Args): CorralChange {
    const t = this.state.tasks.find((x) => x.id === args.task);
    if (!t) throw new ToolError("Use the task's id from the tasks tool.");
    const by = this.person(args.by);
    switch (tool) {
      case "complete_task": {
        t.status = "done";
        // Credit goes to whoever's named, else the one person it's for; a shared screen itself is nobody.
        t.doneBy = by?.id ?? (t.assignees !== "anyone" && t.assignees.length === 1 ? t.assignees[0]! : null);
        if (args.values && typeof args.values === "object" && !Array.isArray(args.values)) t.captured = args.values as Record<string, unknown>;
        return { status: "done", summary: `${t.title}: done${t.doneBy ? ` by ${this.shortNameOf(t.doneBy)}` : ""}` };
      }
      case "undo_task":
        t.status = "open";
        t.doneBy = null;
        delete t.captured;
        return { status: "done", summary: `${t.title}: not done` };
      case "claim_task":
        if (!by) throw new ToolError("Say who's taking it.");
        if (t.status !== "open") throw new ToolError(`${t.title} isn't open.`);
        t.assignees = [by.id];
        return { status: "done", summary: `${by.shortName} is taking ${t.title}` };
      case "skip_task":
        t.status = "skipped";
        return { status: "done", summary: `Skipped ${t.title}` };
    }
  }

  private addListItem(args: Args): CorralChange {
    const text = String(args.text ?? "").trim().slice(0, 300);
    if (!text) throw new ToolError("Say what to add.");
    const list = typeof args.list === "string" && args.list ? this.list(args.list) : this.state.lists[0]!;
    const quantity = typeof args.quantity === "string" && args.quantity.trim() ? args.quantity.trim().slice(0, 40) : null;
    const there = list.items.find((it) => !it.done && it.text.toLowerCase() === text.toLowerCase());
    if (there) {
      if (quantity) there.quantity = quantity;
      return { status: "done", summary: `${there.text} is already on ${list.name}` };
    }
    list.items.push({ text: text.charAt(0).toUpperCase() + text.slice(1), quantity, done: false, approved: true });
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

  private findPerson(v: unknown): SamplePerson | undefined {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const said = v.trim().toLowerCase();
    return this.state.people.find((p) => p.name.toLowerCase() === said || p.shortName.toLowerCase() === said);
  }

  /** The person named, or none when nobody was named; a name nobody here has is a mistake to say. */
  private person(v: unknown): SamplePerson | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    const p = this.findPerson(v);
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
