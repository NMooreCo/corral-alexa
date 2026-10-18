import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalsView } from "../src/approvals.ts";
import type { CorralEvent } from "../src/household.ts";
import worker, { type Env } from "../src/index.ts";
import { SPEAKER_HEADER } from "../src/sample/roles.ts";
import type { WeekView } from "../src/screens.ts";
import { MemoryKV } from "./memory-kv.ts";

const CTX = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const SAMPLE: Env = { BACKEND: "sample" };

/** One MCP call to the worker, the way the simulated Echo Show makes it, as `speaker`. */
async function rpc(env: Env, method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    CTX,
  );
  const text = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1)
    : text;
  return { status: res.status, body: data ? (JSON.parse(data) as { result?: Record<string, any>; error?: { message: string } }) : null };
}

const as = (speaker: string) => ({ [SPEAKER_HEADER]: encodeURIComponent(speaker) });
const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => (await rpc(SAMPLE, "tools/call", { name, arguments: args }, headers)).body!.result!;
const answer = (result: Record<string, any>) => JSON.parse(result.content[0].text);

// The sample household lives as long as the worker, around the real today; a day well inside next week.
const zone = "America/Denver";
const day = Temporal.Now.plainDateISO(zone).add({ days: 6 });

afterEach(() => vi.unstubAllGlobals());

describe("the speaker header in sample mode", () => {
  it("answers as the person named: their private event in full for them, Busy for anyone else", async () => {
    const forSam = (await call("calendar", { search: "gift" }, as("Sam"))) as Record<string, any>;
    expect(answer(forSam).map((e: CorralEvent) => e.title)).toEqual(["Birthday gift shopping"]);
    expect(answer(await call("calendar", { search: "gift" }, as("Maya")))).toEqual([]);
    expect(answer(await call("calendar", { search: "gift" }))).toEqual([]);
  });

  it("treats a name nobody here has as a guest, never as the kitchen screen", async () => {
    const res = await call("add_list_item", { text: "Fireworks" }, as("Grandpa Joe"));
    expect(res).toMatchObject({ isError: true, content: [{ text: "Only people in Juniper Hollow can change things here, by voice or on the screen, and this voice isn't one of them." }] });
    const items = answer(await call("lists", { list: "Groceries" })).items.map((i: { text: string }) => i.text);
    expect(items).not.toContain("Fireworks");
  });

  it("runs the whole beat: a kid asks, a parent sees it on the approvals screen, approves, and the week shows it", async () => {
    const title = `Sleepover at Ava's ${crypto.randomUUID().slice(0, 4)}`;
    const asked = answer(await call("add_event", { title, start: day.toString(), people: ["Maya"] }, as("Maya")));
    expect(asked).toMatchObject({ status: "waiting_for_approval", approvers: ["Sam", "Alex"], requestId: expect.any(String) });

    const screen = (await call("show_approvals", {}, as("Sam"))).structuredContent as ApprovalsView;
    expect(screen).toMatchObject({ household: "Juniper Hollow" });
    expect(screen.toDecide).toContainEqual(expect.objectContaining({ id: asked.requestId, from: "Maya", asks: expect.stringContaining(title) }));
    const mayas = (await call("show_approvals", {}, as("Maya"))).structuredContent as ApprovalsView;
    expect(mayas).toMatchObject({ toDecide: [], requests: "Only Sam or Alex approve requests." });
    expect(mayas.yoursWaiting.map((r) => r.id)).toContain(asked.requestId);

    // What the screen's Approve button sends, through the same tool.
    expect(answer(await call("decide_approval", { request: asked.requestId, decision: "approve" }, as("Sam")))).toMatchObject({ status: "done", summary: expect.stringContaining(`Approved Maya's request: ${title}`) });
    const week = (await call("show_week", { from: day.toString() }, as("Sam"))).structuredContent as WeekView;
    expect(week.days[0]!.events.map((e) => e.title)).toContain(title);
  });

  it("lets only a parent decide, through the screen's tool too", async () => {
    const asked = answer(await call("add_event", { title: "Movie with friends", start: day.toString() }, as("Leo")));
    const res = await call("decide_approval", { request: asked.requestId, decision: "approve" }, as("Maya"));
    expect(res).toMatchObject({ isError: true, content: [{ text: "Only Sam or Alex can approve or decline requests." }] });
  });

  it("switches speakers mid-connection when the client's requestInit headers change, as the simulator does", async () => {
    const headers: Record<string, string> = { ...as("Sam") };
    const client = new Client({ name: "simulator", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://bridge.example/mcp"), { requestInit: { headers }, fetch: (input, init) => worker.fetch(new Request(input, init), SAMPLE, CTX) }));
    const giftShopping = async () => JSON.parse(((await client.callTool({ name: "calendar", arguments: { search: "gift" } })).content as { text: string }[])[0]!.text) as CorralEvent[];
    expect((await giftShopping()).map((e) => e.title)).toEqual(["Birthday gift shopping"]);
    headers[SPEAKER_HEADER] = encodeURIComponent("Maya");
    expect(await giftShopping()).toEqual([]);
    await client.close();
  });
});

describe("the speaker header in corral mode", () => {
  /** Just Corral's MCP server, recording every call it gets. */
  function fakeCorral() {
    const seen: { headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = (await req.json()) as { method: string; params: { name?: string } };
      seen.push({ headers: Object.fromEntries(req.headers), body });
      if (body.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: 1, result: { instructions: "Corral runs the Test household. The household's time zone is America/Denver." } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify([{ when: "Fri, Oct 16, 12:00 PM to 1:00 PM", title: "Busy (private, no details)", people: [], drivers: [], location: null, calendar: "Family" }]) }] } });
    });
    return seen;
  }
  const env = (): Env => ({ BACKEND: "corral", CORRAL_URL: "https://corral.example", OAUTH_KV: new MemoryKV() as unknown as KVNamespace, ACCEPT_CORRAL_TOKENS: "true" });
  const linked = { authorization: "Bearer crl_pat_test" };

  it("never reaches Corral: the person's own token decides, whatever the header says", async () => {
    const seen = fakeCorral();
    const e = env();
    const plain = await rpc(e, "tools/call", { name: "calendar", arguments: {} }, linked);
    const claimed = await rpc(e, "tools/call", { name: "calendar", arguments: {} }, { ...linked, ...as("Sam") });
    expect(claimed.body).toEqual(plain.body);
    const calls = seen.filter((s) => (s.body as { method: string }).method === "tools/call");
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.headers).not.toHaveProperty(SPEAKER_HEADER);
      expect(c.headers.authorization).toBe("Bearer crl_pat_test");
    }
    expect(calls[0]!.body).toEqual({ ...(calls[1]!.body as object), id: (calls[0]!.body as { id: number }).id });
  });

  it("offers no approval tools or screen, since Corral's own server doesn't decide requests for any credential", async () => {
    fakeCorral();
    const list = await rpc(env(), "tools/list", {}, { ...linked, ...as("Sam") });
    const names = (list.body!.result!.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("calendar");
    expect(names).not.toContain("approvals");
    expect(names).not.toContain("decide_approval");
    expect(names).not.toContain("show_approvals");
  });

  it("still needs a sign-in: the header alone gets a bare 401", async () => {
    fakeCorral();
    expect((await rpc(env(), "tools/call", { name: "calendar", arguments: {} }, as("Sam"))).status).toBe(401);
  });
});
