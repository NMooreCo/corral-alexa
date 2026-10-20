import type Anthropic from "@anthropic-ai/sdk";

/**
 * A turn on a model that speaks OpenAI's Responses API, like GPT-5.6 on
 * Amazon Bedrock's bedrock-mantle endpoint. The page keeps the conversation
 * in the Messages API's shape whatever model answers, so this turns that
 * conversation into Responses input and the answer back into a Messages reply.
 */

type MessageParam = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Tool = Anthropic.Beta.BetaTool;

export interface ResponsesTurn {
  baseURL: string;
  apiKey: string;
  model: string;
  instructions: string;
  messages: MessageParam[];
  tools: Tool[];
}

/** A failed call, with the status the model's host answered. */
export class ResponsesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type InputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function blocksOf(message: MessageParam): BlockParam[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function textOf(blocks: BlockParam[]): string {
  return blocks
    .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function resultText(block: Anthropic.Beta.BetaToolResultBlockParam): string {
  const content = block.content;
  const text = typeof content === "string" ? content : textOf((content ?? []) as BlockParam[]);
  return block.is_error ? `Error: ${text}` : text;
}

/**
 * The conversation as Responses input. A tool's call and its result become
 * items of their own, matched by call id; thinking and anything else only
 * Claude makes is left out.
 */
export function responsesInput(messages: MessageParam[]): InputItem[] {
  const input: InputItem[] = [];
  for (const message of messages) {
    const blocks = blocksOf(message);
    if (message.role === "user") {
      for (const b of blocks) if (b.type === "tool_result") input.push({ type: "function_call_output", call_id: b.tool_use_id, output: resultText(b) });
      const text = textOf(blocks);
      if (text) input.push({ role: "user", content: text });
    } else {
      const text = textOf(blocks);
      if (text) input.push({ role: "assistant", content: text });
      for (const b of blocks) if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
  }
  return input;
}

export function responsesTools(tools: Tool[]) {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: t.input_schema, strict: false }));
}

interface ResponsesOutput {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: (
    | { type: "message"; content?: { type: string; text?: string; refusal?: string }[] }
    | { type: "function_call"; call_id: string; name: string; arguments?: string }
    | { type: string }
  )[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The Responses answer as a Messages reply, which is what the page reads. */
export function messagesReply(body: ResponsesOutput, model: string): Anthropic.Beta.BetaMessage {
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let refused = false;
  for (const item of body.output ?? []) {
    if (item.type === "message" && "content" in item) {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text, citations: null });
        if (part.type === "refusal") refused = true;
      }
    }
    if (item.type === "function_call" && "call_id" in item) {
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parseArguments(item.arguments) } as Anthropic.Beta.BetaContentBlock);
    }
  }
  const usesTools = content.some((b) => b.type === "tool_use");
  const cut = body.status === "incomplete" && body.incomplete_details?.reason === "max_output_tokens";
  const cached = body.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    id: body.id ?? `resp_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: body.model ?? model,
    content,
    stop_reason: usesTools ? "tool_use" : refused ? "refusal" : cut ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: (body.usage?.input_tokens ?? 0) - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: body.usage?.output_tokens ?? 0 },
  } as Anthropic.Beta.BetaMessage;
}

/** One turn: Responses in, a Messages reply out. A busy or failing host gets one more try. */
export async function responsesTurn(turn: ResponsesTurn): Promise<Anthropic.Beta.BetaMessage> {
  const request = {
    model: turn.model,
    instructions: turn.instructions,
    input: responsesInput(turn.messages),
    tools: responsesTools(turn.tools),
    // Spoken replies: low effort keeps the answer quick.
    reasoning: { effort: "low" },
    max_output_tokens: 4096,
    // The page keeps the conversation, so the host needn't.
    store: false,
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${turn.baseURL}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${turn.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (res.ok) return messagesReply((await res.json()) as ResponsesOutput, turn.model);
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
    const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
    throw new ResponsesError(res.status, detail.error?.message ?? detail.message ?? `HTTP ${res.status}`);
  }
}
