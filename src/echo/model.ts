import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { Env } from "../env.ts";
import { json } from "../http.ts";
import { skillPrompt } from "../server.ts";

/**
 * The simulated Echo Show's brain: one Claude turn. The page is the MCP
 * client (it lists Corral's tools, calls them, and shows the screens); this
 * only asks Claude what to say or which tool to call next, so the model key
 * never leaves the server.
 *
 * Two places can answer, both speaking the Messages API through the plain
 * Anthropic SDK:
 *
 * - Amazon Bedrock serves it at bedrock-mantle.{region}.api.aws/anthropic,
 *   which takes a Bedrock API key as the key, so there's no request signing.
 * - The Claude API itself, or anything that speaks its wire format (a model
 *   gateway, say) at ANTHROPIC_BASE_URL.
 *
 * MODEL_PROVIDER picks one; unset, it's whichever has a key, Bedrock first.
 */

interface Provider {
  id: "bedrock" | "anthropic";
  /** For people: "Bedrock didn't accept the simulator's key". */
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
  // If the main model ever declines, the same request runs again on this one.
  fallback: string;
}

function bedrock(env: Env): Provider | undefined {
  if (!env.BEDROCK_API_KEY) return undefined;
  return {
    id: "bedrock",
    name: "Bedrock",
    apiKey: env.BEDROCK_API_KEY,
    baseURL: `https://bedrock-mantle.${env.BEDROCK_REGION ?? "us-west-2"}.api.aws/anthropic`,
    model: env.BEDROCK_MODEL ?? "anthropic.claude-opus-5-5",
    fallback: "anthropic.claude-opus-4-8",
  };
}

function anthropic(env: Env): Provider | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  return {
    id: "anthropic",
    name: "The Claude API",
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
  return provider.id === "bedrock" ? "Claude on Amazon Bedrock" : "Claude through the Claude API";
}

/** The simulator's page, saying what answers it and whether it asks for the passcode first. */
export function echoPage(html: string, env: Env): string {
  return html.replaceAll("{{model}}", modelPlace(env)).replaceAll("{{passcode}}", env.DEMO_PASSCODE ? "required" : "none");
}

const MAX_BODY = 300_000;
const MAX_MESSAGES = 80;
const MAX_TOOLS = 40;

const VOICE = `You are the voice of a smart display in a family's kitchen: a simulated Alexa+ on an Echo Show, connected to the family's Corral over MCP. What you say is spoken aloud and shown as a caption.

- Speak in plain sentences: no markdown, no bullet points, no emoji, no headings.
- One or two short sentences unless they ask for more.
- When a tool shows a screen (like show_today), the screen is already in front of them: say one line about it, not everything on it.
- Lines that start "(On the screen" tell you what someone just did by tapping the display.
- You help with this household's day and its ranch. For anything else, say briefly that you can help with the family's calendar, chores, lists, whereabouts, points and supplies, and the ranch's devices, weather and animals.`;

interface TurnRequest {
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  context?: { instructions?: string; now?: string; timeZone?: string };
}

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** The parts of a turn request this takes, after checking its shape and size. */
function readTurn(raw: string): TurnRequest | string {
  if (raw.length > MAX_BODY) return "That conversation is too long; start a new one.";
  let body: Partial<TurnRequest>;
  try {
    body = JSON.parse(raw) as Partial<TurnRequest>;
  } catch {
    return "Send JSON.";
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) return "Send between 1 and 80 messages; start a new conversation if it's longer.";
  if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) return "Send at most 40 tools.";
  for (const t of body.tools) {
    if (!t || typeof t.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) || typeof t.input_schema !== "object") return "Each tool needs a name and an input schema.";
  }
  return { messages: body.messages, tools: body.tools, context: body.context };
}

export async function modelTurn(request: Request, env: Env): Promise<Response> {
  const provider = modelProvider(env);
  if (!provider) return json(503, { error: { code: "not_configured", message: "The simulator's model isn't set up on this server." } });
  if (env.DEMO_PASSCODE && request.headers.get("x-demo-passcode")?.trim() !== env.DEMO_PASSCODE.trim()) {
    return json(401, { error: { code: "passcode", message: "Enter the demo passcode to talk to the simulator." } });
  }
  if (env.MODEL_LIMIT) {
    const who = request.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await env.MODEL_LIMIT.limit({ key: who });
    if (!success) return json(429, { error: { code: "rate_limited", message: "That's a lot of questions at once. Give it a minute." } });
  }
  const turn = readTurn(await request.text());
  if (typeof turn === "string") return json(400, { error: { code: "bad_request", message: turn } });

  const client = new Anthropic({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    middleware: [betaRefusalFallbackMiddleware([{ model: provider.fallback }])],
    maxRetries: 1,
  });
  const ctx = turn.context ?? {};
  try {
    const message = await client.beta.messages.create({
      model: provider.model,
      max_tokens: 4096,
      // Spoken replies: low effort keeps the answer quick.
      output_config: { effort: "low" },
      system: [
        // The same every turn, so tools and this block are cached.
        { type: "text", text: `${VOICE}\n\n${skillPrompt()}`, cache_control: { type: "ephemeral" } },
        { type: "text", text: [`The household's time zone is ${clip(ctx.timeZone, 64) || "unknown"}. It's now ${clip(ctx.now, 64) || "unknown"}.`, clip(ctx.instructions, 2000)].filter(Boolean).join("\n") },
      ],
      tools: turn.tools,
      messages: turn.messages,
    });
    return json(200, message, { "x-model-provider": provider.id });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return json(502, { error: { code: "model_key", message: `${provider.name} didn't accept the simulator's key or model access.` } });
    }
    if (err instanceof Anthropic.RateLimitError) return json(429, { error: { code: "rate_limited", message: `${provider.name} is busy. Try again in a moment.` } });
    if (err instanceof Anthropic.BadRequestError) return json(400, { error: { code: "bad_request", message: err.message } });
    if (err instanceof Anthropic.APIError) return json(502, { error: { code: "model_error", message: `${provider.name} answered ${err.status ?? "with an error"}.` } });
    throw err;
  }
}
