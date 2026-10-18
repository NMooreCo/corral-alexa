/**
 * The household the tools answer from. Both kinds, the built-in sample and a
 * real Corral, answer Corral's own MCP tools by name, with the same arguments
 * and the same JSON. So every rule about who sees and changes what (private
 * events read as Busy, a kid's change waits for a parent, the farm hand only
 * hears about the ranch) stays in Corral, and this bridge never decides it.
 */

/** The Corral tools this bridge offers. Each takes Corral's arguments and returns Corral's JSON. */
export const CORRAL_TOOLS = [
  "calendar",
  "tasks",
  "whereabouts",
  "people",
  "lists",
  "points",
  "supplies",
  "add_event",
  "add_task",
  "complete_task",
  "undo_task",
  "claim_task",
  "skip_task",
  "add_list_item",
  "check_list_item",
  "update_supply",
] as const;

export type CorralTool = (typeof CORRAL_TOOLS)[number];

/**
 * Seeing and deciding requests that wait for approval. Corral's own MCP
 * server doesn't let any credential decide requests yet, so a linked
 * household doesn't offer these; the sample household does.
 */
export const APPROVAL_TOOLS = ["approvals", "decide_approval"] as const;

export type ApprovalTool = (typeof APPROVAL_TOOLS)[number];
export type HouseholdTool = CorralTool | ApprovalTool;

export interface Household {
  /** The household's name, when already known, for screens and the server's instructions. */
  readonly name?: string;
  /** Whether it answers the approval tools. */
  readonly decidesRequests?: boolean;
  /** The household's name and time zone, looked up if need be. */
  about(): Promise<HouseholdAbout>;
  /** Calls one of its tools. Throws ToolError for an answer the model should hear and can act on. */
  call(tool: HouseholdTool, args: Record<string, unknown>): Promise<unknown>;
  /** A counter that goes up whenever anything in the household changes, when this kind of household keeps one, so screens can tell when to refresh. */
  version?(): Promise<number>;
  /** Why this speaker may not do something beyond the household's own tools, said for people, or null when they may. A household that knows no speakers leaves it out. */
  refusal?(action: HouseholdAction): string | null;
}

/** What a household says yes or no to beyond its own tools, like switching one of its ranch's devices. */
export type HouseholdAction = "switch_device";

export interface HouseholdAbout {
  name?: string;
  /** An IANA zone, like "America/Denver". */
  timeZone?: string;
}

/** A tracked supply as Corral's supplies tool says it. */
export interface CorralSupply {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  /** Like "6 bags". */
  onHand: string;
  daysLeft?: number;
  /** A date, like "2026-10-25". */
  runsOut?: string;
  /** Its unit changed since anyone counted it. */
  needsFreshCount?: boolean;
  low: boolean;
  /** The list it's already on, if any. */
  onList: string | null;
}

/** A list item as Corral's lists tool says it. */
export interface CorralListItem {
  text: string;
  quantity: string | null;
  waitingForApproval: boolean;
}

/** A refusal or a mistake in the call, said for the model (and through it, the person), like Corral's tool errors. */
export class ToolError extends Error {
  override name = "ToolError";
}

// ---------- What Corral's tools return ----------

/** An event as Corral's calendar tool says it. A Busy block has no id and names nobody. */
export interface CorralEvent {
  event?: string;
  /** For one day of a repeating event: which one. */
  occurrence?: string;
  /** Like "Fri, Oct 16, 3:30 PM to 4:45 PM" or "Sat, Oct 17 (all day)". */
  when: string;
  title: string;
  people: string[];
  drivers: string[];
  location: string | null;
  calendar: string;
}

/** What a task asks for when it's done, like an amount fed or eggs collected. */
export interface CorralAsk {
  key: string;
  label: string;
  type: string;
  unit?: string;
  required?: boolean;
}

/** A task or chore as Corral's tasks tool says it. */
export interface CorralTask {
  id: string;
  title: string;
  /** Like "Fri, Oct 16, 9:00 AM", or "Fri, Oct 16" when it's due any time that day. */
  due: string;
  status: "open" | "done" | "skipped" | "overdue";
  /** ["anyone"] when it's up for grabs. */
  assignees: string[];
  doneBy: string | null;
  asks?: CorralAsk[];
}

/** Where someone is, as Corral's whereabouts tool says it. */
export interface CorralWhere {
  name: string;
  location: string;
  /** Like "Fri, Oct 16, 3:15 PM", or null when they stay put. */
  until: string | null;
  /** Where they go after that, when it's somewhere else. */
  then?: string;
}

/** The answer to a change: done now, or sent to someone to approve. */
export type CorralChange =
  | { status: "done"; summary: string; [more: string]: unknown }
  | { status: "waiting_for_approval"; summary: string; approvers: string[]; requestId: string };
