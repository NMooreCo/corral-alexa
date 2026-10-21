import { afterEach, describe, expect, it, vi } from "vitest";
import { samePasscode } from "../src/echo/gate.ts";
import { modelLabel } from "../src/echo/model.ts";
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
    const wrong = turn([{ role: "user", content: "hi" }]);
    expect((await call({ BACKEND: "sample", BEDROCK_API_KEY: "key", DEMO_PASSCODE: "ranch" }, "/echo/model", { ...wrong, headers: { ...wrong.headers, "x-demo-passcode": "Ranch" } })).status).toBe(401);
  });

  it("takes the passcode with stray spaces on either side", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    const req = turn([{ role: "user", content: "hi" }]);
    const res = await call({ BACKEND: "sample", BEDROCK_API_KEY: "key", DEMO_PASSCODE: "ranch " }, "/echo/model", { ...req, headers: { ...req.headers, "x-demo-passcode": " ranch" } });
    expect(res.status).toBe(200);
  });

  it("tells the page up front whether it needs the passcode", async () => {
    const page = async (env: Env) => (await call({ BACKEND: "sample", ...env }, "/echo")).text();
    expect(await page({ DEMO_PASSCODE: "ranch" })).toContain('data-passcode="required"');
    expect(await page({})).toContain('data-passcode="none"');
    expect(await page({ DEMO_PASSCODE: "ranch" })).not.toContain("ranch");
  });

  it("holds a visitor to the rate limit", async () => {
    const env: Env = { BACKEND: "sample", BEDROCK_API_KEY: "key", MODEL_LIMIT: { limit: async () => ({ success: false }) } as RateLimit };
    expect((await call(env, "/echo/model", turn([{ role: "user", content: "hi" }]))).status).toBe(429);
  });

  it("counts every try at the passcode against the visitor's limit, before comparing it", async () => {
    const keys: string[] = [];
    let left = 2;
    const MODEL_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: left-- > 0 }) } as unknown as RateLimit;
    const env: Env = { BACKEND: "sample", BEDROCK_API_KEY: "key", DEMO_PASSCODE: "ranch", MODEL_LIMIT };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const guess = (passcode: string) => {
      const req = turn([{ role: "user", content: "hi" }]);
      return call(env, "/echo/model", { ...req, headers: { ...req.headers, "x-demo-passcode": passcode, "cf-connecting-ip": "203.0.113.9" } });
    };
    expect((await guess("barn")).status).toBe(401);
    expect((await guess("corral")).status).toBe(401);
    // Out of tries, even the right passcode waits: the limit comes before the comparison.
    const stopped = await guess("ranch");
    expect(stopped.status).toBe(429);
    expect(await stopped.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(keys).toEqual(["203.0.113.9", "203.0.113.9", "203.0.113.9"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("compares the passcode whole, ignoring only stray spaces on either side", async () => {
    expect(await samePasscode(" ranch ", "ranch")).toBe(true);
    expect(await samePasscode("ranch", " ranch")).toBe(true);
    expect(await samePasscode("Ranch", "ranch")).toBe(false);
    expect(await samePasscode("ranc", "ranch")).toBe(false);
    expect(await samePasscode("ranch hand", "ranch")).toBe(false);
    expect(await samePasscode("", "ranch")).toBe(false);
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
    expect(res.headers.get("x-model-provider")).toBe("bedrock");
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "Here's today." }] });
    const url = new URL(sent!.url);
    expect(url.origin + url.pathname).toBe("https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages");
    expect(sent!.headers.get("x-api-key")).toBe("bedrock-key");
    expect(sent!.body).toMatchObject({ model: "anthropic.claude-opus-5-5", output_config: { effort: "low" }, tools: [{ name: "show_today" }] });
    expect(sent!.body.system[0].text).toContain("Busy means private");
    // It knows the simulator says who Alexa recognized before each turn.
    expect(sent!.body.system[0].text).toContain("(Alexa recognized the voice");
    expect(sent!.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent!.body.system[1].text).toContain("America/Denver");
  });

  it("asks the Claude API, or a gateway that speaks it, when that's the provider", async () => {
    let sent: { url: string; headers: Headers; body: Record<string, any> } | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      sent = { url: req.url, headers: req.headers, body: await req.json() };
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Here's today." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } });
    });
    const env: Env = { BACKEND: "sample", MODEL_PROVIDER: "anthropic", BEDROCK_API_KEY: "bedrock-key", ANTHROPIC_API_KEY: "gateway-key", ANTHROPIC_BASE_URL: "https://gateway.example" };
    const res = await call(env, "/echo/model", turn([{ role: "user", content: "What's going on today?" }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-provider")).toBe("anthropic");
    const url = new URL(sent!.url);
    expect(url.origin + url.pathname).toBe("https://gateway.example/v1/messages");
    expect(sent!.headers.get("x-api-key")).toBe("gateway-key");
    expect(sent!.body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" } });
    expect(sent!.body.system[0].text).toContain("Busy means private");
  });

  it("asks GPT-5.6 on Bedrock through the Responses API, and answers the page in the Messages shape", async () => {
    let sent: { url: string; headers: Headers; body: Record<string, any> } | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      sent = { url: req.url, headers: req.headers, body: await req.json() };
      return Response.json({
        id: "resp_1",
        model: "openai.gpt-5.6-terra",
        status: "completed",
        output: [
          { type: "reasoning", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking the misters." }] },
          { type: "function_call", call_id: "call_2", name: "set_device", arguments: '{"device":"greenhouse misters","state":"on","seconds":30}' },
        ],
        usage: { input_tokens: 7000, output_tokens: 40, input_tokens_details: { cached_tokens: 6000 } },
      });
    });
    const env: Env = { BACKEND: "sample", BEDROCK_API_KEY: "bedrock-key", BEDROCK_REGION: "us-west-2", BEDROCK_MODEL: "openai.gpt-5.6-terra" };
    const conversation = [
      { role: "user", content: [{ type: "text", text: "(Alexa recognized the voice: Nick Rivera, Parent.)" }, { type: "text", text: "What's going on today?" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "tool_use", id: "call_1", name: "show_today", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Soccer at 4." }] },
      { role: "assistant", content: [{ type: "text", text: "Soccer at 4." }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "No such device.", is_error: true }, { type: "text", text: "Run the misters for 30 seconds." }] },
    ];
    const res = await call(env, "/echo/model", turn(conversation, [{ name: "show_today", description: "Show today", input_schema: { type: "object" } }, { name: "set_device", input_schema: { type: "object", properties: { device: { type: "string" } } } }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-model-provider")).toBe("bedrock");
    expect(await res.json()).toEqual({
      id: "resp_1",
      type: "message",
      role: "assistant",
      model: "openai.gpt-5.6-terra",
      content: [
        { type: "text", text: "Checking the misters.", citations: null },
        { type: "tool_use", id: "call_2", name: "set_device", input: { device: "greenhouse misters", state: "on", seconds: 30 } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1000, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, output_tokens: 40 },
    });
    expect(sent!.url).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
    expect(sent!.headers.get("authorization")).toBe("Bearer bedrock-key");
    expect(sent!.body).toMatchObject({ model: "openai.gpt-5.6-terra", reasoning: { effort: "low" }, store: false });
    expect(sent!.body.instructions).toContain("Busy means private");
    expect(sent!.body.instructions).toContain("America/Denver");
    expect(sent!.body.tools).toEqual([
      { type: "function", name: "show_today", description: "Show today", parameters: { type: "object" }, strict: false },
      { type: "function", name: "set_device", description: "", parameters: { type: "object", properties: { device: { type: "string" } } }, strict: false },
    ]);
    // Each call and its result are items of their own, matched by call id; Claude's thinking is left out.
    expect(sent!.body.input).toEqual([
      { role: "user", content: "(Alexa recognized the voice: Nick Rivera, Parent.)\nWhat's going on today?" },
      { type: "function_call", call_id: "call_1", name: "show_today", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "Soccer at 4." },
      { role: "assistant", content: "Soccer at 4." },
      { type: "function_call_output", call_id: "call_9", output: "Error: No such device." },
      { role: "user", content: "Run the misters for 30 seconds." },
    ]);
  });

  it("says plainly when Bedrock turns the Responses call down, and tries a busy one once more", async () => {
    const env: Env = { BACKEND: "sample", BEDROCK_API_KEY: "bedrock-key", BEDROCK_MODEL: "openai.gpt-5.6-terra" };
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return Response.json({ error: { message: "slow down" } }, { status: 429 });
    });
    const busy = await call(env, "/echo/model", turn([{ role: "user", content: "hi" }]));
    expect(busy.status).toBe(429);
    expect(calls).toBe(2);
    vi.stubGlobal("fetch", async () => Response.json({ message: "no access" }, { status: 403 }));
    const denied = await call(env, "/echo/model", turn([{ role: "user", content: "hi" }]));
    expect(denied.status).toBe(502);
    expect(await denied.json()).toMatchObject({ error: { code: "model_key" } });
    vi.stubGlobal("fetch", async () => Response.json({ output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }));
    expect(await (await call(env, "/echo/model", turn([{ role: "user", content: "hi" }]))).json()).toMatchObject({ content: [], stop_reason: "refusal" });
  });

  it("says each answer with Amazon Polly, signed with the IAM key, behind the passcode", async () => {
    let sent: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = new Request(input, init);
      return new Response(new Uint8Array([0xff, 0xfb, 0x90]), { headers: { "content-type": "audio/mpeg" } });
    });
    const env: Env = { BACKEND: "sample", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", DEMO_PASSCODE: "ranch" };
    const say = (text: unknown, passcode = "ranch") => call(env, "/echo/voice", { method: "POST", headers: { "content-type": "application/json", "x-demo-passcode": passcode }, body: JSON.stringify({ text }) });
    expect((await say("Hi.", "wrong")).status).toBe(401);
    expect((await say("")).status).toBe(400);
    expect((await say("x".repeat(1001))).status).toBe(400);
    const res = await say("Soccer is at four.");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb, 0x90]));
    expect(sent!.url).toBe("https://polly.us-west-2.amazonaws.com/v1/speech");
    expect(sent!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/polly\/aws4_request/);
    expect(await sent!.json()).toEqual({ Engine: "neural", OutputFormat: "mp3", Text: "Soccer is at four.", TextType: "text", VoiceId: "Joanna" });
  });

  it("tells the page when Polly can't speak, so it uses the browser's voice", async () => {
    const say = (env: Env) => call({ BACKEND: "sample", ...env }, "/echo/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hi." }) });
    expect((await say({})).status).toBe(503);
    vi.stubGlobal("fetch", async () => new Response('{"message":"The security token included in the request is invalid."}', { status: 403 }));
    const res = await say({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "voice_error" } });
    const page = async (env: Env) => (await call({ BACKEND: "sample", ...env }, "/echo")).text();
    expect(await page({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" })).toContain('data-voice="polly"');
    expect(await page({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" })).toContain('data-voiced=", and Amazon Polly says the answers"');
    expect(await page({})).toContain('data-voice="browser"');
    expect(await page({})).not.toContain("{{voice");
  });

  it("tells the model when the device is an Echo Dot, with no screen", async () => {
    let system = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = (await new Request(input, init).json()) as { system: { text: string }[] };
      system = body.system.map((b) => b.text).join("\n");
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const ask = (context: Record<string, unknown>) =>
      call({ BACKEND: "sample", ANTHROPIC_API_KEY: "key" }, "/echo/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [], context: { timeZone: "America/Denver", ...context } }) });
    await ask({ screen: false });
    expect(system).toContain("This device is an Echo Dot, with no screen");
    await ask({});
    expect(system).not.toContain("Echo Dot");
  });

  it("names a Bedrock model for people", () => {
    expect(modelLabel("openai.gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(modelLabel("openai.gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(modelLabel("openai.gpt-6")).toBe("GPT-6");
    expect(modelLabel("anthropic.claude-opus-5-5")).toBe("Claude");
    expect(modelLabel("mistral.mistral-large-3")).toBe("mistral-large-3");
  });

  it("uses whichever provider has a key, Bedrock first, and names it on the page", async () => {
    const page = async (env: Env) => (await call({ BACKEND: "sample", ...env }, "/echo")).text();
    expect(await page({ BEDROCK_API_KEY: "b", ANTHROPIC_API_KEY: "a" })).toContain('data-model="Claude on Amazon Bedrock"');
    expect(await page({ ANTHROPIC_API_KEY: "a" })).toContain('data-model="Claude through the Claude API"');
    expect(await page({ BEDROCK_API_KEY: "b", BEDROCK_MODEL: "openai.gpt-5.6-terra" })).toContain('data-model="GPT-5.6 Terra on Amazon Bedrock"');
    expect(await page({ MODEL_PROVIDER: "anthropic", BEDROCK_API_KEY: "b" })).toContain("not set up on this server");
    expect(await page({ MODEL_MOCK: "true" })).toContain("a practice model standing in for Claude");
    expect(await page({})).not.toContain("{{model}}");
  });

  it("answers with the practice model when building without a key", async () => {
    const env: Env = { BACKEND: "sample", MODEL_MOCK: "true" };
    const first = await (await call(env, "/echo/model", turn([{ role: "user", content: "What's going on today?" }]))).json();
    expect(first).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "show_today" }] });
  });

  it("plays the approval demo with the practice model too: a kid's sleepover for the coming Friday, then a parent's approvals", async () => {
    const env: Env = { BACKEND: "sample", MODEL_MOCK: "true" };
    const said = (who: string, text: string) => [{ role: "user", content: [{ type: "text", text: who }, { type: "text", text }] }];
    const asked = await (await call(env, "/echo/model", turn(said("(Alexa recognized the voice: Eli Rivera, Kid.)", "Can I have a sleepover at Ava's on Friday?")))).json() as { content: { input: { start: string } }[] };
    const use = asked.content[0]!;
    expect(use).toMatchObject({ type: "tool_use", name: "add_event", input: { title: "Sleepover at Ava's", people: ["eli rivera"] } });
    expect(new Date(`${use.input.start}T12:00:00Z`).getUTCDay()).toBe(5);
    const waiting = await (await call(env, "/echo/model", turn(said("(Alexa recognized the voice: Nick Rivera, Parent.)", "Anything waiting for me?")))).json();
    expect(waiting).toMatchObject({ content: [{ type: "tool_use", name: "show_approvals" }] });
  });
});
