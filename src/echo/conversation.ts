import type Anthropic from "@anthropic-ai/sdk";

/**
 * Fitting a long conversation to what the model route sends. The simulator
 * keeps the whole conversation and sends all of it every turn; when that's
 * more than the route sends on, the oldest turns are left out, whole.
 */

type MessageParam = Anthropic.Beta.BetaMessageParam;

/** How much of a conversation goes to the model: its messages, and their length as JSON. */
export interface ConversationLimits {
  messages: number;
  chars: number;
}

/** Turns are left out this many at a time, counted from the conversation's start (see fitConversation). */
const TURNS_AT_A_TIME = 4;

/**
 * Whether a message starts a turn: something someone said (or a screen said
 * for them), rather than the results of the tools the assistant just called.
 */
export function startsTurn(message: MessageParam): boolean {
  return message.role === "user" && (typeof message.content === "string" || !message.content.some((b) => b.type === "tool_result"));
}

/**
 * The conversation with its oldest whole turns left out until it fits. A
 * turn runs from what someone said to just before they next spoke, so a
 * tool's call and its result always go or stay together, and what's kept
 * still starts with something someone said, as the Messages API needs.
 * Turns go four at a time, counted from the conversation's start, so the
 * start of what's kept stays put for a few turns and the model's host can
 * keep reusing what it cached of it. A cut conversation goes without its
 * thinking blocks: each was made with the whole conversation before it, and
 * Claude's host can refuse a request that brings one back once what came
 * before it has changed. The latest turn always stays: null when that alone
 * doesn't fit. A conversation that fits comes back as it is.
 */
export function fitConversation(messages: MessageParam[], limits: ConversationLimits): MessageParam[] | null {
  // How long the messages from each one on run as a JSON array: each message and its comma, and the brackets.
  const after: number[] = new Array<number>(messages.length + 1).fill(1);
  for (let i = messages.length - 1; i >= 0; i--) after[i] = after[i + 1]! + JSON.stringify(messages[i]).length + 1;
  const fits = (from: number) => messages.length - from <= limits.messages && after[from]! <= limits.chars;
  if (fits(0)) return messages;
  const starts = messages.flatMap((m, i) => (startsTurn(m) ? [i] : []));
  const first = starts.findIndex(fits);
  if (first < 0) return null;
  const turn = Math.min(Math.ceil(first / TURNS_AT_A_TIME) * TURNS_AT_A_TIME, starts.length - 1);
  return withoutThinking(messages.slice(starts[turn]));
}

/**
 * The messages with every thinking block left out. An assistant message that
 * was only thinking goes too: it called no tool, so nothing waits on it, and
 * the person's messages either side of it simply run together.
 */
function withoutThinking(messages: MessageParam[]): MessageParam[] {
  return messages.flatMap((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return [m];
    const content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    if (content.length === m.content.length) return [m];
    return content.length ? [{ ...m, content }] : [];
  });
}
