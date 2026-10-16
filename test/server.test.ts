import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORRAL_TOOLS } from "../src/household.ts";
import worker, { type Env } from "../src/index.ts";
import { TODAY_URI } from "../src/today.ts";

const SAMPLE: Env = { BACKEND: "sample" };
const CORRAL: Env = { BACKEND: "corral", CORRAL_URL: "https://corral.example" };

/** One JSON-RPC message the way Alexa+ sends it: the 2025-11-25 protocol, one POST each. */
async function rpc(env: Env, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-11-25" }), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  );
  const text = await res.text();
  // Answered as JSON or as a one-message event stream.
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)
    : text;
  return { status: res.status, body: data ? (JSON.parse(data) as { result?: Record<string, any>; error?: { message: string } }) : null };
}

afterEach(() => vi.unstubAllGlobals());

describe("serving Alexa+ (MCP 2025-11-25 over Streamable HTTP)", () => {
  it("agrees on 2025-11-25 and says it has tools and resources", async () => {
    const { body } = await rpc(SAMPLE, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "alexa", version: "1" } });
    expect(body?.result).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "corral" }, capabilities: { tools: {}, resources: {} } });
    expect(body?.result?.instructions).toContain("Juniper Hollow");
  });

  it("lists Corral's tools and the Today screen tool, pointing at its screen", async () => {
    const { body } = await rpc(SAMPLE, "tools/list");
    const tools = body!.result!.tools as { name: string; annotations?: { readOnlyHint?: boolean }; _meta?: { ui?: { resourceUri?: string } } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...CORRAL_TOOLS, "show_today"].sort());
    expect(tools.find((t) => t.name === "show_today")?._meta?.ui?.resourceUri).toBe(TODAY_URI);
    expect(tools.find((t) => t.name === "calendar")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "complete_task")?.annotations?.readOnlyHint).toBe(false);
  });

  it("serves the Today screen as one self-contained MCP Apps page", async () => {
    const { body } = await rpc(SAMPLE, "resources/read", { uri: TODAY_URI });
    const [page] = body!.result!.contents as { uri: string; mimeType: string; text: string }[];
    expect(page).toMatchObject({ uri: TODAY_URI, mimeType: "text/html;profile=mcp-app" });
    expect(page!.text).toMatch(/^<!doctype html>/i);
    expect(page!.text).not.toMatch(/<script[^>]+src=/);
  });

  it("shows today: calendar, chores and whereabouts for the screen", async () => {
    const { body } = await rpc(SAMPLE, "tools/call", { name: "show_today", arguments: {} });
    expect(body!.result!.structuredContent).toMatchObject({ household: "Juniper Hollow", events: expect.any(Array), tasks: expect.any(Array), whereabouts: expect.any(Array) });
    expect(body!.result!.structuredContent.whereabouts).toHaveLength(5);
  });

  it("says Corral's refusal back to the model as a tool error", async () => {
    const { body } = await rpc(SAMPLE, "tools/call", { name: "complete_task", arguments: { task: "not-a-task" } });
    expect(body!.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Use the task's id from the tasks tool." }] });
  });

  it("also serves the current protocol to an up-to-date client", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://bridge.example/mcp"), { fetch: (input, init) => worker.fetch(new Request(input, init), SAMPLE) }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("show_today");
    const res = await client.callTool({ name: "lists", arguments: {} });
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify(["Groceries", "Feed store", "Hardware"]) }]);
    await client.close();
  });
});

describe("answering from a real Corral", () => {
  it("asks for a credential before anything else", async () => {
    const { status } = await rpc(CORRAL, "tools/list");
    expect(status).toBe(401);
  });

  it("carries the call to Corral's MCP server with the caller's credential, and Corral's answer back", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [{ type: "text", text: JSON.stringify({ list: "Groceries", items: [] }) }], isError: false } }),
    );
    vi.stubGlobal("fetch", upstream);
    const { body } = await rpc(CORRAL, "tools/call", { name: "lists", arguments: { list: "Groceries" } }, { authorization: "Bearer crl_pat_test" });
    expect(body!.result!.content).toEqual([{ type: "text", text: JSON.stringify({ list: "Groceries", items: [] }) }]);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://corral.example/mcp");
    expect(init.headers).toMatchObject({ authorization: "Bearer crl_pat_test", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "lists" });
    expect(JSON.parse(String(init.body)).params).toMatchObject({ name: "lists", arguments: { list: "Groceries" } });
  });

  it("passes Corral's refusal on, and asks to link again when Corral turns the credential down", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [{ type: "text", text: "This person can't add events." }], isError: true } }));
    const refused = await rpc(CORRAL, "tools/call", { name: "add_event", arguments: { title: "Dentist", start: "2026-10-22" } }, { authorization: "Bearer crl_pat_test" });
    expect(refused.body!.result).toMatchObject({ isError: true, content: [{ type: "text", text: "This person can't add events." }] });

    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    const unlinked = await rpc(CORRAL, "tools/call", { name: "calendar", arguments: {} }, { authorization: "Bearer crl_pat_test" });
    expect(unlinked.body!.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("Link the account again") }] });
  });
});
