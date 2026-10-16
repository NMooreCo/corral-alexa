import { ToolError, type CorralEvent, type CorralTask, type CorralWhere, type Household } from "./household.ts";

/** The Today screen's address, an MCP Apps resource. */
export const TODAY_URI = "ui://corral/today.html";

/** What the Today screen shows: today's calendar, today's chores (done ones too) and who's where. */
export type TodayView = {
  household: string | null;
  events: CorralEvent[];
  tasks: CorralTask[];
  whereabouts: CorralWhere[];
};

/**
 * Today from Corral's own tools, left at their defaults so "today" is the
 * household's today in its own time zone. A part this connection may not see
 * (no whereabouts for this person, say) is left empty rather than failing the
 * whole screen.
 */
export async function todayView(household: Household): Promise<TodayView> {
  const [events, tasks, whereabouts] = await Promise.all([
    part<CorralEvent[]>(household.call("calendar", {})),
    part<CorralTask[]>(household.call("tasks", { include_done: true })),
    part<CorralWhere[]>(household.call("whereabouts", {})),
  ]);
  return { household: household.name ?? null, events, tasks, whereabouts };
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
