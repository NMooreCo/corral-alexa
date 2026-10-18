import { Temporal } from "temporal-polyfill";
import { ToolError, type CorralEvent, type CorralListItem, type CorralSupply, type Household } from "./household.ts";
import { todayIn } from "./clock.ts";

/**
 * The views behind the list, week and supplies screens, each made from
 * Corral's own tools so Corral's rules apply to what they show.
 */

export const LIST_URI = "ui://corral/list.html";
export const WEEK_URI = "ui://corral/week.html";
export const SUPPLIES_URI = "ui://corral/supplies.html";

export type ListView = { household: string | null; list: string; lists: string[]; items: CorralListItem[] };
export type WeekView = { household: string | null; from: string; today: string; days: { date: string; label: string; events: CorralEvent[] }[] };
/** Supplies, and the lists a low one could go on. */
export type SuppliesView = { household: string | null; supplies: CorralSupply[]; lists: string[] };

/** One list (the first unless one's named), with the names of the others to switch to. */
export async function listView(household: Household, list?: string): Promise<ListView> {
  const [about, names] = await Promise.all([household.about(), household.call("lists", {})]);
  const lists = Array.isArray(names) ? (names as string[]) : [];
  const which = list || lists[0];
  if (!which) return { household: about.name ?? null, list: "", lists, items: [] };
  const one = (await household.call("lists", { list: which })) as { list: string; items: CorralListItem[] };
  return { household: about.name ?? null, list: one.list, lists, items: one.items };
}

/** Seven days from `from` (default today in the household's time zone), with each day's events. */
export async function weekView(household: Household, from?: string): Promise<WeekView> {
  const about = await household.about();
  const zone = about.timeZone ?? "UTC";
  const today = todayIn(zone);
  let start = today;
  if (from) {
    try {
      start = Temporal.PlainDate.from(from);
    } catch {
      throw new ToolError(`"${from}" isn't a date; use YYYY-MM-DD.`);
    }
  }
  const events = (await household.call("calendar", { from: start.toString(), to: start.add({ days: 6 }).toString() })) as CorralEvent[];
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = start.add({ days: i });
    // Corral's labels start with the day the way this does ("Sat, Oct 17").
    const label = date.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
    return { date: date.toString(), label, events: (Array.isArray(events) ? events : []).filter((e) => e.when.startsWith(label)) };
  });
  return { household: about.name ?? null, from: start.toString(), today: today.toString(), days };
}

export async function suppliesView(household: Household): Promise<SuppliesView> {
  const [about, supplies, lists] = await Promise.all([household.about(), household.call("supplies", {}), household.call("lists", {}).catch(() => [])]);
  return { household: about.name ?? null, supplies: Array.isArray(supplies) ? (supplies as CorralSupply[]) : [], lists: Array.isArray(lists) ? (lists as string[]) : [] };
}
