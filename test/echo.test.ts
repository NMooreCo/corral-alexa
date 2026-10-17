import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.ts";

const CTX = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const call = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request(`https://bridge.example${path}`, init), env, CTX);
const turn = (messages: unknown[], tools: unknown[] = [{ name: "show_today", description: "Show today", input_schema: { type: "object" } }]) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ messages, tools, context: { timeZone: "America/Denver", now: "Friday, October 16, 2026 at 10:30 AM" } }),
});

afterEach(() => vi.unstubAllGlobals());

describe("the simulated Echo Show", () => {
  it("serves its page in sample mode", async () => {
    const res = await call({ BACKEND: "sample" }, "/echo");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("simulated Echo Show");
  });

  it("isn't there in corral mode, where calls need account linking", async () => {
    const res = await call({ BACKEND: "corral", CORRAL_URL: "https://corral.example", OAUTH_KV: {} as KVNamespace }, "/echo");
    expect(res.status).toBe(404);
  });

  it("says plainly when the model isn't set up", async () => {
    const res = await call({ BACKEND: "sample" }, "/echo/model", turn([{ role: "user", content: "hi" }]));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "not_configured" } });
  });

  it("asks for the passcode when one is set", async () => {
    const res = await call({ BACKEND: "sample", BEDROCK_API_KEY: "key", DEMO_PASSCODE: "ranch" }, "/echo/model", turn([{ role: "user", content: "hi" }]));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "passcode" } });
  });

  it("holds a visitor to the rate limit", async () => {
    const env: Env = { BACKEND: "sample", BEDROCK_API_KEY: "key", MODEL_LIMIT: { limit: async () => ({ success: false }) } as RateLimit };
    expect((await call(env, "/echo/model", turn([{ role: "user", content: "hi" }]))).status).toBe(429);
  });

  it("refuses an oversized or malformed turn before it costs anything", async () => {
    const env: Env = { BACKEND: "sample", BEDROCK_API_KEY: "key" };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await call(env, "/echo/model", turn([]))).status).toBe(400);
    expect((await call(env, "/echo/model", turn([{ role: "user", content: "hi" }], [{ name: "bad name!", input_schema: {} }]))).status).toBe(400);
    expect((await call(env, "/echo/model", turn(Array.from({ length: 81 }, () => ({ role: "user", content: "hi" }))))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks Claude on Bedrock with the household skill, the household's time and low effort", async () => {
    let sent: { url: string; headers: Headers; body: Record<string, any> } | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      sent = { url: req.url, headers: req.headers, body: await req.json() };
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "anthropic.claude-opus-5-5", content: [{ type: "text", text: "Here's today." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } });
    });
    const res = await call({ BACKEND: "sample", BEDROCK_API_KEY: "bedrock-key", BEDROCK_REGION: "us-west-2" }, "/echo/model", turn([{ role: "user", content: "What's going on today?" }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "Here's today." }] });
    const url = new URL(sent!.url);
    expect(url.origin + url.pathname).toBe("https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages");
    expect(sent!.headers.get("x-api-key")).toBe("bedrock-key");
    expect(sent!.body).toMatchObject({ model: "anthropic.claude-opus-5-5", output_config: { effort: "low" }, tools: [{ name: "show_today" }] });
    expect(sent!.body.system[0].text).toContain("Busy means private");
    expect(sent!.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent!.body.system[1].text).toContain("America/Denver");
  });

  it("answers with the practice model when building without a key", async () => {
    const env: Env = { BACKEND: "sample", MODEL_MOCK: "true" };
    const first = await (await call(env, "/echo/model", turn([{ role: "user", content: "What's going on today?" }]))).json();
    expect(first).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "show_today" }] });
  });
});
