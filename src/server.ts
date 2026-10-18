import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { APPROVALS_URI, approvalsView } from "./approvals.ts";
import { UpstreamAuthError } from "./corral.ts";
import { APPROVAL_TOOLS, ToolError, type Household, type HouseholdAbout, type HouseholdTool } from "./household.ts";
import type { Ranch } from "./ranch/index.ts";
import { ADD_AUTOMATION, AUTOMATIONS, RANCH_INSTRUCTIONS, RANCH_TOOLS, SET_AUTOMATION, SET_DEVICE } from "./ranch/tools.ts";
import { BRIEFING_URI, RANCH_URI, briefingView, ranchSummary, ranchView, type RanchTab, type RanchView } from "./ranch/views.ts";
import { LIST_URI, SUPPLIES_URI, WEEK_URI, listView, suppliesView, weekView } from "./screens.ts";
import { TODAY_URI, todayView } from "./today.ts";
import { householdSkill, householdSkillTools, widgetHtml } from "./widgets.generated.ts";

/** The household Agent Skill's guidance without its YAML header, as a prompt any MCP client can load. */
export function skillPrompt(): string {
  return `${householdSkill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()}\n\n${householdSkillTools.trim()}`;
}

export const SERVER_INFO = { name: "corral", title: "Corral", version: "0.1.0" };

const name = z.string().describe("A person's name");
const date = (what: string) => z.string().describe(`YYYY-MM-DD, ${what}`);
const task = z.string().describe("The task's id from the tasks tool");

interface ToolDef {
  name: HouseholdTool;
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
    description: 'Add a one-off task. A reminder ("remind Jak to practice piano Friday") is a task for whoever it reminds, due then.',
    input: z.object({ title: z.string(), due: z.string().describe('Zoned like "2026-10-07T17:00:00-06:00[America/Denver]"').optional(), assignees: z.array(z.string()).describe("Names").optional() }),
    write: true,
  },
  {
    name: "complete_task",
    title: "Mark a task done",
    description: 'Mark a task or chore done ("Eli fed the dog"). Say who did it with by. Check-offs happen right away.',
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
  {
    name: "approvals",
    title: "Requests waiting",
    description: 'Requests waiting for approval: ones this person can approve or decline (toDecide, with ids), and their own still waiting (yoursWaiting, with who decides). For "anything waiting for me?" or "did Mom say yes yet?".',
    input: z.object({}),
  },
  {
    name: "decide_approval",
    title: "Approve or decline a request",
    description: "Approve or decline a request waiting for this person, by its id from approvals. Approving makes the change it asks for. Only people who approve requests can, never for their own.",
    input: z.object({ request: z.string().describe("The request's id from approvals"), decision: z.enum(["approve", "decline"]) }),
    write: true,
  },
];

function instructions(about: HouseholdAbout, decides: boolean, ranch: boolean): string {
  return [
    `Corral runs ${about.name ? `the ${about.name} household` : "this household"}: its calendar, chores, lists, whereabouts, points and supplies.`,
    ...(about.timeZone ? [`The household's time zone is ${about.timeZone}.`] : []),
    "Look things up with the read tools before changing anything, and use the ids they return.",
    "Changes happen right away, so confirm with the person first. Some changes go to a parent to approve instead; the answer says so and who.",
    ...(decides ? ["What waits for someone to approve is in approvals; only the people who approve requests decide them, with decide_approval."] : []),
    `Speak briefly: the next thing or two, not a whole list. To show something on a screen, use show_today, show_week, show_list${decides ? ", show_supplies or show_approvals" : " or show_supplies"}.`,
    ...(ranch ? [RANCH_INSTRUCTIONS] : []),
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

/** One MCP server for one request, answering from `household` (and its ranch, when it has one). */
export async function buildServer(household: Household, ranch?: Ranch): Promise<McpServer> {
  const decides = Boolean(household.decidesRequests);
  const server = new McpServer(SERVER_INFO, { instructions: instructions(await household.about(), decides, Boolean(ranch)) });

  for (const t of TOOLS) {
    if ((APPROVAL_TOOLS as readonly string[]).includes(t.name) && !decides) continue;
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

  const readOnly = (title: string) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  /** A tool's answer as a screen's view: the JSON for the model (or what `say` makes of it) and structuredContent for the screen. */
  const asView = async (make: () => Promise<Record<string, unknown>>, say?: (view: Record<string, unknown>) => unknown): Promise<CallToolResult> => {
    try {
      const view = await make();
      return { content: [{ type: "text", text: JSON.stringify(say ? say(view) : view) }], structuredContent: view };
    } catch (err) {
      return answer(() => Promise.reject(err));
    }
  };
  /** A screen: the tool that shows it and the MCP Apps page it shows. Every page is self-contained, so it reaches no other origin. */
  const screen = (
    name: string,
    title: string,
    description: string,
    input: z.ZodObject,
    uri: string,
    html: string,
    make: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    say?: (view: Record<string, unknown>) => unknown,
  ) => {
    registerAppTool(server, name, { title, description, inputSchema: input, annotations: readOnly(title), _meta: { ui: { resourceUri: uri } } }, (args: unknown) => asView(() => make((args ?? {}) as Record<string, unknown>), say));
    registerAppResource(server, title, uri, { description }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }],
    }));
  };

  screen(
    "show_today",
    "Show today",
    "Show today on the screen: the calendar, chores (tap one to check it off) and who's where. Use it when someone asks what's going on today or wants to see the day.",
    z.object({}),
    TODAY_URI,
    widgetHtml.today,
    () => todayView(household),
  );
  // The Today screen keeps itself current through this; only the screen calls it, so the assistant never sees it.
  registerAppTool(
    server,
    "refresh_today",
    { title: "Refresh today", description: "The Today screen's own refresh.", inputSchema: z.object({}), annotations: readOnly("Refresh today"), _meta: { ui: { resourceUri: TODAY_URI, visibility: ["app"] } } },
    () => asView(() => todayView(household)),
  );
  // A change made anywhere (another Echo Show, the assistant, a tap) reaches every screen within a few seconds:
  // a stateless server can't push, so screens ask this cheap counter and refresh when it moves. Only screens call it.
  if (household.version) {
    const version = household.version.bind(household);
    registerAppTool(
      server,
      "household_version",
      {
        title: "Household changes",
        description: "A counter that goes up whenever anything in the household changes, for screens to know when to refresh.",
        inputSchema: z.object({}),
        annotations: readOnly("Household changes"),
        _meta: { ui: { visibility: ["app"] } },
      },
      async () => {
        const view = { version: await version() };
        return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
      },
    );
  }
  screen(
    "show_list",
    "Show a list",
    "Show a shopping or to-do list on the screen (tap an item to check it off). Use it when someone wants to see a list, or after adding several things so they can see it.",
    z.object({ list: z.string().describe("A list name; default the first list").optional() }),
    LIST_URI,
    widgetHtml.list,
    (a) => listView(household, typeof a.list === "string" ? a.list : undefined),
  );
  screen(
    "show_week",
    "Show the week",
    "Show seven days of the calendar on the screen, starting today or on a given date. Use it when someone asks about the week, the weekend or the days ahead.",
    z.object({ from: date("default today").optional() }),
    WEEK_URI,
    widgetHtml.week,
    (a) => weekView(household, typeof a.from === "string" ? a.from : undefined),
  );
  screen(
    "show_supplies",
    "Show supplies",
    "Show tracked supplies on the screen (feed, hay, pet food and so on): how much is left, how many days that lasts, and what's low. Use it when someone asks about supplies or after a count.",
    z.object({}),
    SUPPLIES_URI,
    widgetHtml.supplies,
    () => suppliesView(household),
  );
  if (decides) {
    screen(
      "show_approvals",
      "Show requests waiting",
      `Show requests waiting for approval on the screen, with Approve and Decline buttons for whoever may decide them, and the speaker's own requests still waiting. Use it for "anything waiting for me?" or "what needs my OK?".`,
      z.object({}),
      APPROVALS_URI,
      widgetHtml.approvals,
      () => approvalsView(household),
    );
  }

  if (ranch) {
    for (const t of RANCH_TOOLS) {
      server.registerTool(
        t.name,
        { title: t.title, description: t.description, inputSchema: t.input, annotations: { ...readOnly(t.title), openWorldHint: t.openWorld } },
        (args) =>
          answer(async () => {
            await ranch.tick();
            const out = await t.run(ranch, args as Record<string, unknown>);
            // Someone who may not switch devices hears so (and who can) before anything is offered.
            const refusal = t.name === "devices" ? household.refusal?.("switch_device") : null;
            return refusal ? { switching: refusal, devices: out } : out;
          }),
      );
    }
    const ranchNow = (tab?: RanchTab) => ranchView(ranch, household, tab) as unknown as Promise<Record<string, unknown>>;
    const sayRanch = (v: Record<string, unknown>) => ranchSummary(v as unknown as RanchView);
    screen(
      "show_ranch",
      "Show the ranch",
      "Show the ranch on the screen. Its tabs: \"ranch\" is every device by place, which people can tap to switch, with how the animals are; \"animals\" is a map of the property with the fence, its zones and each collar (one outside the fence stands out), beside every collar's place and battery; \"automations\" is each automation with a switch. Use it when someone asks about the ranch, a device, the greenhouse, the animals or the automations.",
      z.object({ view: z.enum(["ranch", "animals", "automations"]).describe('Which tab to open on: "ranch" (the default), "animals" or "automations"').optional() }),
      RANCH_URI,
      widgetHtml.ranch,
      (args) => ranchNow(typeof args.view === "string" ? (args.view as RanchTab) : undefined),
      sayRanch,
    );
    server.registerTool(AUTOMATIONS.name, { title: AUTOMATIONS.title, description: AUTOMATIONS.description, inputSchema: AUTOMATIONS.input, annotations: readOnly(AUTOMATIONS.title) }, () =>
      answer(async () => {
        await ranch.tick();
        const list = await ranch.automations.list();
        // Someone who may not change automations hears so (and who can) before anything is offered.
        const refusal = household.refusal?.("switch_device");
        return refusal ? { changing: refusal, automations: list } : list;
      }),
    );
    // Changing an automation shows the Ranch screen on its Automations tab, so the change is in front of whoever asked.
    const automationTool = (def: { name: string; title: string; description: string; input: z.ZodObject }, run: (args: Record<string, unknown>) => Promise<unknown>) =>
      registerAppTool(
        server,
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.input,
          annotations: { title: def.title, readOnlyHint: false, destructiveHint: false, idempotentHint: def.name === SET_AUTOMATION.name, openWorldHint: true },
          _meta: { ui: { resourceUri: RANCH_URI } },
        },
        async (args: unknown) => {
          // The same people who may switch devices may change what switches them.
          const refusal = household.refusal?.("switch_device");
          if (refusal) return answer(() => Promise.reject(new ToolError(refusal)));
          try {
            const change = await run((args ?? {}) as Record<string, unknown>);
            return { content: [{ type: "text", text: JSON.stringify(change) }], structuredContent: await ranchNow("automations") };
          } catch (err) {
            return answer(() => Promise.reject(err));
          }
        },
      );
    automationTool(SET_AUTOMATION, (a) => ranch.automations.set(a.automation, a.enabled));
    automationTool(ADD_AUTOMATION, (a) => ranch.automations.add(a));
    // The Ranch screen keeps itself current through this; only the screen calls it.
    registerAppTool(
      server,
      "refresh_ranch",
      { title: "Refresh the ranch", description: "The Ranch screen's own refresh.", inputSchema: z.object({}), annotations: readOnly("Refresh the ranch"), _meta: { ui: { resourceUri: RANCH_URI, visibility: ["app"] } } },
      () => asView(ranchNow, sayRanch),
    );
    // Switching shows the Ranch screen, so a run started by voice counts down in front of whoever asked.
    registerAppTool(
      server,
      SET_DEVICE.name,
      {
        title: SET_DEVICE.title,
        description: SET_DEVICE.description,
        inputSchema: SET_DEVICE.input,
        annotations: { title: SET_DEVICE.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        _meta: { ui: { resourceUri: RANCH_URI } },
      },
      async (args: unknown) => {
        // The household says who may switch its devices; a screen's tap is the speaker's too.
        const refusal = household.refusal?.("switch_device");
        if (refusal) return answer(() => Promise.reject(new ToolError(refusal)));
        try {
          const change = await ranch.devices.set((args ?? {}) as Record<string, unknown>);
          const view = await ranchNow();
          return { content: [{ type: "text", text: JSON.stringify(change) }], structuredContent: view };
        } catch (err) {
          return answer(() => Promise.reject(err));
        }
      },
    );
    screen(
      "show_briefing",
      "Show the briefing",
      "Show the morning briefing as swipeable cards: today at a glance, the weather, late chores, low supplies, the animals (outside the fence, low collar batteries), the greenhouse and devices needing attention. Use it for good morning, or what do I need to know today.",
      z.object({}),
      BRIEFING_URI,
      widgetHtml.briefing,
      () => briefingView(household, ranch) as unknown as Promise<Record<string, unknown>>,
    );
  }

  // The same guidance as skills/corral-household, for clients that load prompts.
  server.registerPrompt(
    "household-assistant",
    { title: "Household assistant", description: "How to run a family's day through Corral's tools by voice: confirm changes, respect approvals, keep private events private, speak briefly." },
    () => ({ description: "Corral household assistant", messages: [{ role: "user", content: { type: "text", text: skillPrompt() } }] }),
  );

  return server;
}
