import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { APPROVAL_TOOLS, CORRAL_TOOLS, ORDER_TOOLS } from "../src/household.ts";
import worker, { type Env } from "../src/index.ts";

const CTX = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
import { SUPPLIES_URI } from "../src/screens.ts";
import { TODAY_URI } from "../src/today.ts";

const SAMPLE: Env = { BACKEND: "sample" };

/** One JSON-RPC message the way Alexa+ sends it: the 2025-11-25 protocol, one POST each. */
async function rpc(env: Env, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-11-25" }), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    CTX,
  );
  const text = await res.text();
  // Answered as JSON or as a one-message event stream.
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)
    : text;
  return { status: res.status, body: data ? (JSON.parse(data) as { result?: Record<string, any>; error?: { message: string } }) : null };
}

describe("serving Alexa+ (MCP 2025-11-25 over Streamable HTTP)", () => {
  it("agrees on 2025-11-25 and says it has tools and resources", async () => {
    const { body } = await rpc(SAMPLE, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "alexa", version: "1" } });
    expect(body?.result).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "corral" }, capabilities: { tools: {}, resources: {} } });
    expect(body?.result?.instructions).toContain("Juniper Hollow");
  });

  it("lists Corral's tools and the Today screen tool, pointing at its screen", async () => {
    const { body } = await rpc(SAMPLE, "tools/list");
    const tools = body!.result!.tools as { name: string; annotations?: { readOnlyHint?: boolean }; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }[];
    const ranch = ["devices", "set_device", "weather", "trackers", "show_ranch", "refresh_ranch", "show_briefing", "automations", "set_automation", "add_automation"];
    expect(tools.map((t) => t.name).sort()).toEqual([...CORRAL_TOOLS, ...APPROVAL_TOOLS, ...ORDER_TOOLS, "show_today", "refresh_today", "household_version", "show_list", "show_week", "show_supplies", "show_approvals", ...ranch].sort());
    expect(tools.find((t) => t.name === "show_today")?._meta?.ui?.resourceUri).toBe(TODAY_URI);
    // The screen's own refresh is the screen's alone: hosts keep it from the model.
    expect(tools.find((t) => t.name === "refresh_today")?._meta?.ui?.visibility).toEqual(["app"]);
    expect(tools.find((t) => t.name === "calendar")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "complete_task")?.annotations?.readOnlyHint).toBe(false);
  });

  it("offers the household Agent Skill as a prompt", async () => {
    const list = await rpc(SAMPLE, "prompts/list");
    expect(list.body!.result!.prompts.map((p: { name: string }) => p.name)).toEqual(["household-assistant"]);
    const got = await rpc(SAMPLE, "prompts/get", { name: "household-assistant" });
    const text = got.body!.result!.messages[0].content.text as string;
    expect(text).toMatch(/^# Corral household assistant/);
    expect(text).toContain("Busy means private");
    expect(text).toContain("# Corral's tools");
    expect(text).not.toContain("name: corral-household");
  });

  it("serves the Today screen as one self-contained MCP Apps page", async () => {
    const { body } = await rpc(SAMPLE, "resources/read", { uri: TODAY_URI });
    const [page] = body!.result!.contents as { uri: string; mimeType: string; text: string }[];
    expect(page).toMatchObject({ uri: TODAY_URI, mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
    expect(page!.text).toMatch(/^<!doctype html>/i);
    expect(page!.text).not.toMatch(/<script[^>]+src=/);
  });

  it("shows today: calendar, chores and whereabouts for the screen", async () => {
    const { body } = await rpc(SAMPLE, "tools/call", { name: "show_today", arguments: {} });
    expect(body!.result!.structuredContent).toMatchObject({ household: "Juniper Hollow", events: expect.any(Array), tasks: expect.any(Array), whereabouts: expect.any(Array) });
    expect(body!.result!.structuredContent.whereabouts).toHaveLength(5);
  });

  it("gives every screen tool its own self-contained page", async () => {
    const { body } = await rpc(SAMPLE, "tools/list");
    const screens = (body!.result!.tools as { name: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }[]).filter((t) => t._meta?.ui?.resourceUri && !t._meta.ui.visibility);
    // Switching a ranch device or changing an automation shows the Ranch screen, and placing an order the Supplies screen, so the change is in front of whoever asked.
    expect(screens.map((t) => t.name).sort()).toEqual(["add_automation", "place_order", "set_automation", "set_device", "show_approvals", "show_briefing", "show_list", "show_ranch", "show_supplies", "show_today", "show_week"]);
    for (const t of screens) {
      const read = await rpc(SAMPLE, "resources/read", { uri: t._meta!.ui!.resourceUri });
      const [page] = read.body!.result!.contents as { mimeType: string; text: string }[];
      expect(page!.mimeType).toBe("text/html;profile=mcp-app");
      expect(page!.text).toMatch(/^<!doctype html>/i);
      expect(page!.text).not.toMatch(/<script[^>]+src=/);
    }
  });

  it("shows a list, the week and supplies", async () => {
    const list = (await rpc(SAMPLE, "tools/call", { name: "show_list", arguments: { list: "grocery" } })).body!.result!.structuredContent;
    expect(list).toMatchObject({ household: "Juniper Hollow", list: "Groceries", lists: ["Groceries", "Feed store", "Hardware"] });
    expect(list.items.length).toBeGreaterThan(0);

    const week = (await rpc(SAMPLE, "tools/call", { name: "show_week", arguments: {} })).body!.result!.structuredContent;
    expect(week.days).toHaveLength(7);
    expect(week.from).toBe(week.today);
    expect(week.days.flatMap((d: { events: unknown[] }) => d.events).length).toBeGreaterThan(0);

    const supplies = (await rpc(SAMPLE, "tools/call", { name: "show_supplies", arguments: {} })).body!.result!.structuredContent;
    expect(supplies.supplies.map((s: { name: string }) => s.name)).toContain("Horse feed");
    expect(supplies.lists).toContain("Feed store");
  });

  it("orders supplies, answering the order to the assistant and showing it on order on the Supplies screen", async () => {
    const { body } = await rpc(SAMPLE, "tools/list");
    const tools = body!.result!.tools as { name: string; annotations: Record<string, boolean>; inputSchema: { required?: string[] }; _meta?: { ui?: { resourceUri?: string } } }[];
    const place = tools.find((t) => t.name === "place_order")!;
    expect(place.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(place.inputSchema.required).toEqual(["items"]);
    expect(place._meta?.ui?.resourceUri).toBe(SUPPLIES_URI);
    expect(tools.find((t) => t.name === "orders")?.annotations).toMatchObject({ readOnlyHint: true });

    const result = (await rpc(SAMPLE, "tools/call", { name: "place_order", arguments: { items: [{ supply: "propane" }] } }, { "x-demo-person": "Nick" })).body!.result!;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "done", summary: expect.stringMatching(/^Ordered 100 gallons of propane from Valley Feed & Propane: \$289\.00, arriving \w{3}, \w{3} \d{1,2}$/), total: "$289.00" });
    const propane = result.structuredContent.supplies.find((s: { name: string }) => s.name === "Propane");
    expect(propane).toMatchObject({ low: true, onOrder: { amount: "100 gallons", supplier: "Valley Feed & Propane", arrivesOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });

    const orders = JSON.parse((await rpc(SAMPLE, "tools/call", { name: "orders", arguments: {} })).body!.result!.content[0].text);
    expect(orders).toEqual([expect.objectContaining({ items: ["100 gallons of propane"], total: "$289.00", totalCents: 28900, status: "placed", by: "Nick", live: false })]);
  });

  it("names the household's time zone in its instructions", async () => {
    const { body } = await rpc(SAMPLE, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(body!.result!.instructions).toContain("The household's time zone is America/Denver.");
  });

  it("says Corral's refusal back to the model as a tool error", async () => {
    const { body } = await rpc(SAMPLE, "tools/call", { name: "complete_task", arguments: { task: "not-a-task" } });
    expect(body!.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Use the task's id from the tasks tool." }] });
  });

  it("also serves the current protocol to an up-to-date client", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://bridge.example/mcp"), { fetch: (input, init) => worker.fetch(new Request(input, init), SAMPLE, CTX) }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("show_today");
    const res = await client.callTool({ name: "lists", arguments: {} });
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify(["Groceries", "Feed store", "Hardware"]) }]);
    await client.close();
  });
});
