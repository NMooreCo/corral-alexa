import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { Env } from "../env.ts";
import { json } from "../http.ts";
import { skillPrompt } from "../server.ts";
import { fitConversation } from "./conversation.ts";
import { demoGate } from "./gate.ts";
import { ResponsesError, responsesTurn } from "./responses.ts";
import { voiceReady } from "./voice.ts";

/**
 * The simulated Echo Show's brain: one Claude turn. The page is the MCP
 * client (it lists Corral's tools, calls them, and shows the screens); this
 * only asks Claude what to say or which tool to call next, so the model key
 * never leaves the server.
 *
 * Two places can answer:
 *
 * - Amazon Bedrock's bedrock-mantle endpoint, which takes a Bedrock API key
 *   as the key, so there's no request signing. Claude there speaks the
 *   Messages API (at /anthropic, through the plain Anthropic SDK); any other
 *   model, like GPT-5.6 Terra, speaks OpenAI's Responses API (at /openai/v1).
 *   BEDROCK_MODEL's id says which.
 * - The Claude API itself, or anything that speaks its wire format (a model
 *   gateway, say) at ANTHROPIC_BASE_URL.
 *
 * MODEL_PROVIDER picks one; unset, it's whichever has a key, Bedrock first.
 * Whichever answers, the page sees a Messages reply.
 */

interface Provider {
  id: "bedrock" | "anthropic";
  /** For people: "Bedrock didn't accept the simulator's key". */
  name: string;
  /** The model, for people: "Claude", "GPT-5.6 Terra". */
  label: string;
  /** Which wire format the model speaks. */
  api: "messages" | "responses";
  apiKey: string;
  baseURL: string;
  model: string;
  // If Claude ever declines, the same request runs again on this one.
  fallback?: string;
}

/** A Bedrock model id for people: "openai.gpt-5.6-terra" is "GPT-5.6 Terra". */
export function modelLabel(id: string): string {
  const name = id.replace(/^[a-z]+\./, "");
  if (name.startsWith("claude")) return "Claude";
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(name);
  if (!gpt) return name;
  const variant = (gpt[2] ?? "")
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return `GPT-${gpt[1]}${variant ? ` ${variant}` : ""}`;
}

function bedrock(env: Env): Provider | undefined {
  if (!env.BEDROCK_API_KEY) return undefined;
  const model = env.BEDROCK_MODEL ?? "anthropic.claude-opus-5-5";
  const host = `https://bedrock-mantle.${env.BEDROCK_REGION ?? "us-west-2"}.api.aws`;
  const claude = model.startsWith("anthropic.");
  return {
    id: "bedrock",
    name: "Bedrock",
    label: modelLabel(model),
    api: claude ? "messages" : "responses",
    apiKey: env.BEDROCK_API_KEY,
    baseURL: claude ? `${host}/anthropic` : `${host}/openai/v1`,
    model,
    fallback: claude ? "anthropic.claude-opus-4-8" : undefined,
  };
}

function anthropic(env: Env): Provider | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  return {
    id: "anthropic",
    name: "The Claude API",
    label: "Claude",
    api: "messages",
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    fallback: "claude-opus-4-8",
  };
}

export function modelProvider(env: Env): Provider | undefined {
  if (env.MODEL_PROVIDER === "bedrock") return bedrock(env);
  if (env.MODEL_PROVIDER === "anthropic") return anthropic(env);
  return bedrock(env) ?? anthropic(env);
}

/** What the simulator's page says answers it, like "Claude on Amazon Bedrock". */
export function modelPlace(env: Env): string {
  if (env.MODEL_MOCK === "true") return "a practice model standing in for Claude";
  const provider = modelProvider(env);
  if (!provider) return "Claude (not set up on this server)";
  return provider.id === "bedrock" ? `${provider.label} on Amazon Bedrock` : "Claude through the Claude API";
}

/** The simulator's page, saying what answers it, what speaks, and whether it asks for the passcode first. */
export function echoPage(html: string, env: Env): string {
  const polly = voiceReady(env);
  return html
    .replaceAll("{{model}}", modelPlace(env))
    .replaceAll("{{voiced}}", polly ? ", and Amazon Polly says the answers" : "")
    .replaceAll("{{voice}}", polly ? "polly" : "browser")
    .replaceAll("{{passcode}}", env.DEMO_PASSCODE ? "required" : "none");
}

/** What goes to the model at most: messages, and characters of JSON (the conversation, the tools and the context). */
const MAX_MESSAGES = 80;
const MAX_SENT = 300_000;
const MAX_TOOLS = 40;
/** What the route reads at all. A longer conversation is cut to fit before it's sent; past this, it isn't read. */
const MAX_READ = 4_000_000;

/**
 * What the device says when a turn can't go to the model. The simulator says
 * a failed turn's message aloud, so each is a sentence for the person, not
 * an error for a developer (that's in `detail`, and the Worker's log).
 */
const TOO_LONG = "That conversation got long. Start a new one and ask me again.";
const MUDDLED = "Something went wrong with that one. Start a new conversation and ask me again.";

const VOICE = `You are the voice of a smart display in a family's home (the kitchen, unless it says otherwise below): a simulated Alexa+ on an Echo Show, connected to the family's Corral over MCP. What you say is spoken aloud and shown as a caption.

- Speak in plain sentences: no markdown, no bullet points, no emoji, no headings.
- Keep it short, the way Alexa talks: one sentence, two at most, about 30 words in all, unless they ask for more. The screen carries the detail, so say only what matters most.
- Lead with the answer or what you did ("Done. It's on the calendar for Friday at 6."). No filler like "Okay" or "Sure", and don't repeat back what they asked.
- Answer what they asked. Bring up something else only when it's urgent (an animal outside the fence before a freeze), never just because a tool mentioned it.
- Ask at most one question, and make it the very last thing you say: nothing after it.
- When a tool shows a screen (like show_today), the screen is already in front of them: say one line about it, not everything on it.
- Lines that start "(On the screen" tell you what someone just did by tapping the display.
- Lines that start "(Alexa recognized the voice" say who is speaking now, as Alexa+ knows family members by voice; "(Alexa doesn't recognize this voice" means a guest. The tools already answer as that person and apply their rules, so use their first name only now and then (a greeting, or when it matters, not every answer), "me" and "my" mean them, and pass them as by or assignees when they mean themselves.
- You help with this household's day and its ranch. For anything else, say briefly that you can help with the family's calendar, chores, lists, whereabouts, points and supplies, and the ranch's devices, weather and animals.`;

interface TurnRequest {
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  /** About this turn: the server's instructions, the time, and where the display is ("barn", say). */
  context?: { instructions?: string; now?: string; timeZone?: string; place?: string; screen?: boolean };
}

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** A turn the route won't send on: its status, and what the device says. */
interface Refusal {
  status: 400 | 413;
  code: "bad_request" | "too_long";
  message: string;
  /** For a developer: what was wrong with the request. */
  detail?: string;
}

const refused = (r: Refusal) => json(r.status, { error: { code: r.code, message: r.message, ...(r.detail ? { detail: r.detail } : {}) } });
const malformed = (detail: string): Refusal => ({ status: 400, code: "bad_request", message: MUDDLED, detail });
const tooLong: Refusal = { status: 413, code: "too_long", message: TOO_LONG };

function isMessage(m: unknown): m is Anthropic.Beta.BetaMessageParam {
  const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
  return (role === "user" || role === "assistant") && (typeof content === "string" || (Array.isArray(content) && content.every((b) => typeof (b as { type?: unknown } | null)?.type === "string")));
}

/** The parts of a turn request this takes, after checking its shape, with the conversation cut to fit what goes to the model. */
function readTurn(raw: string): (TurnRequest & { dropped: number }) | Refusal {
  if (raw.length > MAX_READ) return tooLong;
  let body: Partial<TurnRequest>;
  try {
    body = JSON.parse(raw) as Partial<TurnRequest>;
  } catch {
    return malformed("Send JSON.");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) return malformed("Send at least one message.");
  if (!body.messages.every(isMessage)) return malformed("Each message needs a role (user or assistant) and content.");
  if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) return malformed(`Send at most ${MAX_TOOLS} tools.`);
  for (const t of body.tools) {
    if (!t || typeof t.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) || typeof t.input_schema !== "object") return malformed("Each tool needs a name and an input schema.");
  }
  // The tools and the context go every turn; the conversation gets what's left.
  const rest = JSON.stringify(body.tools).length + JSON.stringify(body.context ?? {}).length;
  const messages = fitConversation(body.messages, { messages: MAX_MESSAGES, chars: MAX_SENT - rest });
  if (!messages) return tooLong;
  return { messages, tools: body.tools, context: body.context, dropped: body.messages.length - messages.length };
}

/** What the device says when the model's host turned a request down: that the conversation's too long, or a plain sentence. */
function hostRefused(said: string): Response {
  return refused(/too long|too many (input )?tokens|context (window|length)/i.test(said) ? tooLong : { status: 400, code: "bad_request", message: MUDDLED });
}

export async function modelTurn(request: Request, env: Env): Promise<Response> {
  const provider = modelProvider(env);
  if (!provider) return json(503, { error: { code: "not_configured", message: "The simulator's model isn't set up on this server." } });
  const stopped = await demoGate(request, env, env.MODEL_LIMIT);
  if (stopped) return stopped;
  const turn = readTurn(await request.text());
  if ("status" in turn) return refused(turn);
  // Says how many of the oldest messages were left out, when any were.
  const trimmed: Record<string, string> = turn.dropped ? { "x-trimmed-messages": String(turn.dropped) } : {};

  const ctx = turn.context ?? {};
  // The same every turn, so it's cached.
  const standing = `${VOICE}\n\n${skillPrompt()}`;
  const now = [
    `The household's time zone is ${clip(ctx.timeZone, 64) || "unknown"}. It's now ${clip(ctx.now, 64) || "unknown"}.`,
    // The simulator can show two displays on one household, a kitchen's and a barn's.
    clip(ctx.place, 40).trim() ? `This display is in the ${clip(ctx.place, 40).trim().toLowerCase()}.` : "",
    // An Echo Dot: the same tools, but nothing they show is seen.
    ctx.screen === false
      ? "This device is an Echo Dot, with no screen: nothing a tool shows appears here. Say what matters in words (two or three short sentences when a screen would have carried the detail), and never mention a screen, a tab or a tap."
      : "",
    clip(ctx.instructions, 2000),
    turn.dropped ? "The start of this conversation was left out to keep it short." : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (provider.api === "responses") {
    try {
      const message = await responsesTurn({ baseURL: provider.baseURL, apiKey: provider.apiKey, model: provider.model, instructions: `${standing}\n\n${now}`, messages: turn.messages, tools: turn.tools });
      return json(200, message, { "x-model-provider": provider.id, ...trimmed });
    } catch (err) {
      if (!(err instanceof ResponsesError)) throw err;
      // The host's own words stay in the Worker's log; the page gets a plain sentence.
      console.error(`${provider.name} answered ${err.status}: ${err.message}`);
      if (err.status === 401 || err.status === 403) return json(502, { error: { code: "model_key", message: `${provider.name} didn't accept the simulator's key or model access.` } });
      if (err.status === 429) return json(429, { error: { code: "rate_limited", message: `${provider.name} is busy. Try again in a moment.` } });
      if (err.status === 400) return hostRefused(err.message);
      return json(502, { error: { code: "model_error", message: `${provider.name} answered ${err.status}.` } });
    }
  }

  const client = new Anthropic({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    middleware: provider.fallback ? [betaRefusalFallbackMiddleware([{ model: provider.fallback }])] : [],
    maxRetries: 1,
  });
  try {
    const message = await client.beta.messages.create({
      model: provider.model,
      max_tokens: 4096,
      // Spoken replies: low effort keeps the answer quick.
      output_config: { effort: "low" },
      system: [
        // Tools and this block are cached.
        { type: "text", text: standing, cache_control: { type: "ephemeral" } },
        { type: "text", text: now },
      ],
      tools: turn.tools,
      messages: turn.messages,
    });
    return json(200, message, { "x-model-provider": provider.id, ...trimmed });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return json(502, { error: { code: "model_key", message: `${provider.name} didn't accept the simulator's key or model access.` } });
    }
    if (err instanceof Anthropic.RateLimitError) return json(429, { error: { code: "rate_limited", message: `${provider.name} is busy. Try again in a moment.` } });
    if (err instanceof Anthropic.BadRequestError) {
      // The host's own words stay in the Worker's log; the device says a plain sentence.
      console.error(`${provider.name} answered 400: ${err.message}`);
      return hostRefused(err.message);
    }
    if (err instanceof Anthropic.APIError) return json(502, { error: { code: "model_error", message: `${provider.name} answered ${err.status ?? "with an error"}.` } });
    throw err;
  }
}
