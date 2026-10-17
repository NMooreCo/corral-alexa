import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { UpstreamAuthError } from "./corral.ts";
import { ToolError, type CorralTool, type Household } from "./household.ts";
import { TODAY_URI, todayView } from "./today.ts";
import { widgetHtml } from "./widgets.generated.ts";

export const SERVER_INFO = { name: "corral", title: "Corral", version: "0.1.0" };

const name = z.string().describe("A person's name");
const date = (what: string) => z.string().describe(`YYYY-MM-DD, ${what}`);
const task = z.string().describe("The task's id from the tasks tool");

interface ToolDef {
  name: CorralTool;
  title: string;
  description: string;
  input: z.ZodObject;
  write?: boolean;
  destructive?: boolean;
}

/**
 * Corral's tools as this bridge offers them: the same names, arguments and
 * answers as Corral's own MCP server, with descriptions written for a voice
 * assistant. Alexa+ reads these once, when the add-on is deployed.
 */
const TOOLS: ToolDef[] = [
  {
    name: "calendar",
    title: "Calendar",
    description:
      "Events between two dates (inclusive), optionally for one person (what they're in or drive, and what's for everyone) or with words in the title. Without dates it's today. A private event reads as Busy with no details: say only that the time is taken.",
    input: z.object({ from: date("default today").optional(), to: date("at most 62 days after from").optional(), person: name.optional(), search: z.string().describe('Words in the title, like "movie night"').optional() }),
  },
  {
    name: "tasks",
    title: "Tasks and chores",
    description: "Chores and tasks due between two dates (open ones include anything overdue). Without dates it's today.",
    input: z.object({ from: date("default today").optional(), to: date("at most 31 days after from").optional(), person: name.optional(), include_done: z.boolean().optional() }),
  },
  { name: "whereabouts", title: "Where people are", description: "Where each person is at a time (home, school, work, the other parent's, a trip), and until when.", input: z.object({ person: name.optional(), at: z.string().describe("YYYY-MM-DDTHH:MM local time; default now").optional() }) },
  { name: "people", title: "People", description: "Everyone in the household.", input: z.object({}) },
  { name: "lists", title: "Lists", description: "Shopping and to-do lists. Without a list name, the lists there are; with one, what's on it.", input: z.object({ list: z.string().describe("A list name").optional() }) },
  { name: "points", title: "Points", description: "Points and allowance balances, and what points turn into.", input: z.object({}) },
  { name: "supplies", title: "Supplies", description: "Tracked supplies (feed, medicine, pet food and so on): how much is left and when it runs out.", input: z.object({}) },
  {
    name: "add_event",
    title: "Add an event",
    description: "Add a calendar event. If changes from here need a parent's approval, it's sent to them instead, and the answer says who.",
    input: z.object({
      title: z.string(),
      start: z.string().describe('Zoned like "2026-10-07T15:30:00-06:00[America/Denver]", or all day "2026-10-07"'),
      end: z.string().optional(),
      people: z.array(z.string()).describe("Names").optional(),
      calendar: z.string().describe("Calendar name").optional(),
      location: z.string().optional(),
      rrule: z.string().describe("RFC 5545 rule body").optional(),
    }),
    write: true,
  },
  {
    name: "add_task",
    title: "Add a task",
    description: 'Add a one-off task. A reminder ("remind Leo to practice piano Friday") is a task for whoever it reminds, due then.',
    input: z.object({ title: z.string(), due: z.string().describe('Zoned like "2026-10-07T17:00:00-06:00[America/Denver]"').optional(), assignees: z.array(z.string()).describe("Names").optional() }),
    write: true,
  },
  {
    name: "complete_task",
    title: "Mark a task done",
    description: 'Mark a task or chore done ("Maya fed the dog"). Say who did it with by. Check-offs happen right away.',
    input: z.object({ task, by: name.describe("Who did it, when someone's named").optional(), values: z.record(z.string(), z.unknown()).describe("What the task asks for when it's done (see the tasks tool), by key").optional() }),
    write: true,
  },
  { name: "undo_task", title: "Undo marking a task done", description: "Mark a finished task or chore not done again.", input: z.object({ task }), write: true },
  { name: "claim_task", title: "Take a task", description: 'Take a task that\'s up for grabs, for someone named ("I\'ll water the garden" is take, not done).', input: z.object({ task, by: name.describe("Who's taking it") }), write: true },
  { name: "skip_task", title: "Skip a task", description: "Skip a task this time, taking it off everyone's list.", input: z.object({ task }), write: true, destructive: true },
  { name: "add_list_item", title: "Add to a list", description: "Add an item to a shopping or to-do list.", input: z.object({ list: z.string().describe("List name").optional(), text: z.string().describe("The item"), quantity: z.string().describe("How much").optional() }), write: true },
  { name: "check_list_item", title: "Check off a list item", description: 'Check an item off a list, by its text ("we got the milk").', input: z.object({ list: z.string().describe("List name").optional(), text: z.string().describe("The item") }), write: true },
  {
    name: "update_supply",
    title: "Update a supply",
    description: 'Record supplies used, added, or counted ("used two bales of hay"; "we\'re out of dog food" is a count of 0). Use the supply\'s name or id from the supplies tool.',
    input: z.object({ supply: z.string().describe("Its name or id"), change: z.enum(["used", "added", "count"]), amount: z.number().describe("How much was used or added, or how much is there now"), where: z.string().describe("A place, when it's kept in more than one").optional() }),
    write: true,
  },
];

function instructions(household: Household): string {
  return [
    `Corral runs ${household.name ? `the ${household.name} household` : "this household"}: its calendar, chores, lists, whereabouts, points and supplies.`,
    "Look things up with the read tools before changing anything, and use the ids they return.",
    "Changes happen right away, so confirm with the person first. Some changes go to a parent to approve instead; the answer says so and who.",
    "Speak briefly: the next thing or two, not a whole list. When someone wants to see the day, use show_today.",
  ].join(" ");
}

/** A tool's answer as MCP content, with Corral's refusals said back to the model to act on. */
async function answer(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run()) }] };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
    if (err instanceof UpstreamAuthError) return { content: [{ type: "text", text: "Corral didn't accept this connection's sign-in. Link the account again." }], isError: true };
    throw err;
  }
}

/** One MCP server for one request, answering from `household`. */
export function buildServer(household: Household): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: instructions(household) });

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: Boolean(t.destructive), idempotentHint: !t.write, openWorldHint: false },
      },
      (args) => answer(() => household.call(t.name, args as Record<string, unknown>)),
    );
  }

  const today = async (): Promise<CallToolResult> => {
    try {
      const view = await todayView(household);
      return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
    } catch (err) {
      return answer(() => Promise.reject(err));
    }
  };
  const readOnly = (title: string) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  registerAppTool(
    server,
    "show_today",
    {
      title: "Show today",
      description: "Show today on the screen: the calendar, chores (tap one to check it off) and who's where. Use it when someone asks what's going on today or wants to see the day.",
      inputSchema: z.object({}),
      annotations: readOnly("Show today"),
      _meta: { ui: { resourceUri: TODAY_URI } },
    },
    today,
  );

  // The screen keeps itself current through this; only the screen calls it, so the assistant never sees it.
  registerAppTool(
    server,
    "refresh_today",
    { title: "Refresh today", description: "The Today screen's own refresh.", inputSchema: z.object({}), annotations: readOnly("Refresh today"), _meta: { ui: { resourceUri: TODAY_URI, visibility: ["app"] } } },
    today,
  );

  registerAppResource(server, "Today", TODAY_URI, { description: "Today at a glance, for screens like the Echo Show." }, async () => ({
    // Everything is inside the page, so it reaches nothing else.
    contents: [{ uri: TODAY_URI, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml.today, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }],
  }));

  return server;
}
