import type { CorralApprovals, CorralRequest } from "./approvals.ts";
import { ToolError, type CorralEvent, type CorralTask, type CorralWhere, type Household } from "./household.ts";
import { now as clockNow } from "./clock.ts";

/** The Today screen's address, an MCP Apps resource. */
export const TODAY_URI = "ui://corral/today.html";

/** What the Today screen shows: today's calendar, today's chores (done ones too) and who's where. */
export type TodayView = {
  household: string | null;
  /** When this was made, by the household's clock, so the screen's clock and "now" follow the household. */
  at: string;
  events: CorralEvent[];
  tasks: CorralTask[];
  whereabouts: CorralWhere[];
  /** Requests waiting for whoever's looking to decide, for a household that decides its own; they can approve one with a tap. */
  toDecide?: CorralRequest[];
};

/**
 * Today from Corral's own tools, left at their defaults so "today" is the
 * household's today in its own time zone. A part this connection may not see
 * (no whereabouts for this person, say) is left empty rather than failing the
 * whole screen.
 */
export async function todayView(household: Household): Promise<TodayView> {
  const [about, events, tasks, whereabouts, approvals] = await Promise.all([
    household.about(),
    part<CorralEvent[]>(household.call("calendar", {})),
    part<CorralTask[]>(household.call("tasks", { include_done: true })),
    part<CorralWhere[]>(household.call("whereabouts", {})),
    household.decidesRequests ? household.call("approvals", {}).catch((err) => (err instanceof ToolError ? null : Promise.reject(err))) : Promise.resolve(null),
  ]);
  const toDecide = (approvals as Partial<CorralApprovals> | null)?.toDecide;
  return { household: about.name ?? null, at: (household.now?.() ?? clockNow()).toString(), events, tasks, whereabouts, ...(Array.isArray(toDecide) && toDecide.length ? { toDecide } : {}) };
}

async function part<T extends unknown[]>(answer: Promise<unknown>): Promise<T> {
  try {
    const v = await answer;
    return (Array.isArray(v) ? v : []) as T;
  } catch (err) {
    if (err instanceof ToolError) return [] as unknown as T;
    throw err;
  }
}
