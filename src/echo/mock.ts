import type Anthropic from "@anthropic-ai/sdk";
import { Temporal } from "temporal-polyfill";
import { json } from "../http.ts";

/**
 * A practice stand-in for Claude, for building the simulator on a machine
 * with no Bedrock key (MODEL_MOCK=true). It knows a few requests, answers in
 * the Messages API's own shape, and is never deployed.
 */
export async function mockTurn(request: Request): Promise<Response> {
  const { messages, context } = (await request.json()) as { messages: Anthropic.Beta.BetaMessageParam[]; context?: { timeZone?: string } };
  const last = messages.at(-1);
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
  const reply = (content: Anthropic.Beta.BetaContentBlock[], stop: "end_turn" | "tool_use") =>
    json(200, { id: `msg_mock_${crypto.randomUUID()}`, type: "message", role: "assistant", model: "practice-model", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
  const toolUse = (name: string, input: Record<string, unknown>) => reply([{ type: "tool_use", id: `toolu_mock_${crypto.randomUUID()}`, name, input } as Anthropic.Beta.BetaContentBlock], "tool_use");
  const say = (text: string) => reply([{ type: "text", text, citations: null } as Anthropic.Beta.BetaContentBlock], "end_turn");

  // After a tool ran, say one line about it.
  if (blocks.some((b) => b.type === "tool_result")) {
    const failed = blocks.some((b) => b.type === "tool_result" && b.is_error);
    return say(failed ? "That didn't work." : "Here you go.");
  }
  const words = blocks.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join(" ").toLowerCase();
  if (/waiting for me|approv/.test(words)) return toolUse("show_approvals", {});
  if (/sleepover/.test(words)) {
    // Whoever Alexa recognized is the one going, on the coming Friday.
    const who = /alexa recognized the voice: ([^,.)]+)/.exec(words)?.[1];
    let day = Temporal.Now.plainDateISO(context?.timeZone ?? "UTC").add({ days: 1 });
    while (day.dayOfWeek !== 5) day = day.add({ days: 1 });
    return toolUse("add_event", { title: "Sleepover at Ava's", start: day.toString(), ...(who ? { people: [who] } : {}) });
  }
  if (/today|going on|my day/.test(words)) return toolUse("show_today", {});
  const add = /add (.+?) to the (\w[\w ]*?) list/.exec(words);
  if (add) return toolUse("add_list_item", { text: add[1], list: add[2] });
  return say("I'm the practice model. Try asking what's going on today.");
}
