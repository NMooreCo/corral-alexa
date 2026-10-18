import type { Household } from "./household.ts";

/** The approvals screen's address, an MCP Apps resource. */
export const APPROVALS_URI = "ui://corral/approvals.html";

/** A request someone may approve or decline, as the approvals tool says it (the shape of Corral's own inbox). */
export interface CorralRequest {
  id: string;
  /** Who asked, like "Eli". */
  from: string;
  /** What they asked for, like "Sleepover at Ava's, Fri, Oct 23, 6:00 PM". */
  asks: string;
  /** When they asked, like "Sat, Oct 17, 4:05 PM". */
  since: string;
}

/** One of the speaker's own requests, still waiting. */
export interface CorralOwnRequest {
  id: string;
  asks: string;
  since: string;
  /** Who can say yes, like "Nick or Holly". */
  decidedBy: string;
}

/** What the approvals tool answers. */
export type CorralApprovals = {
  /** Requests this person may decide, oldest first. */
  toDecide: CorralRequest[];
  /** Their own requests still waiting. */
  yoursWaiting: CorralOwnRequest[];
  /** Said when they can't decide requests here: who does, or where. */
  requests?: string;
};

export type ApprovalsView = CorralApprovals & { household: string | null };

/** The approvals screen: what's waiting for the speaker, and what of theirs waits for someone else. */
export async function approvalsView(household: Household): Promise<ApprovalsView> {
  const [about, answer] = await Promise.all([household.about(), household.call("approvals", {})]);
  const a = (answer ?? {}) as Partial<CorralApprovals>;
  return {
    household: about.name ?? null,
    toDecide: Array.isArray(a.toDecide) ? a.toDecide : [],
    yoursWaiting: Array.isArray(a.yoursWaiting) ? a.yoursWaiting : [],
    ...(typeof a.requests === "string" ? { requests: a.requests } : {}),
  };
}
