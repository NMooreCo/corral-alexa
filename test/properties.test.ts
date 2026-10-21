import type Anthropic from "@anthropic-ai/sdk";
import fc from "fast-check";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { HouseholdClock } from "../src/clock.ts";
import { fitConversation, startsTurn } from "../src/echo/conversation.ts";
import { modelLabel } from "../src/echo/model.ts";
import { messagesReply, responsesInput } from "../src/echo/responses.ts";
import { ToolError } from "../src/household.ts";
import { quote } from "../src/orders.ts";
import { DeviceHub } from "../src/ranch/devices.ts";
import type { Device, DeviceLimits, SwitchRequest } from "../src/ranch/types.ts";
import { duration } from "../src/ranch/words.ts";
import { SampleHousehold } from "../src/sample/index.ts";
import { dollars } from "../src/sample/labels.ts";
import { sampleRanch } from "../src/sample/ranch.ts";
import { SampleSupplier } from "../src/sample/supplier.ts";

/**
 * Property tests: rules that hold for every input, checked against a hundred
 * or so generated ones each. The seed is fixed, so every run (and CI) tries
 * the same cases and a failure reproduces; fast-check shrinks one to the
 * smallest input that still fails.
 */
fc.configureGlobal({ seed: 20261016 });

// ---------- The simulator's Responses API conversion ----------

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ReplyBody = Parameters<typeof messagesReply>[0];

/** What only Claude sees: no thinking may reach another model's input. */
const THINKING = "only-claude-sees-this-thinking";

const words = fc.string({ unit: "grapheme", maxLength: 12 });
const id = fc.string({ minLength: 1, maxLength: 8 });
const toolName = fc.stringMatching(/^[a-zA-Z0-9_-]{1,16}$/);
const textBlock = words.map((text) => ({ type: "text" as const, text }));
const toolResult = fc.record({
  type: fc.constant("tool_result" as const),
  tool_use_id: id,
  content: fc.option(fc.oneof(words, fc.array(textBlock, { maxLength: 3 })), { nil: undefined }),
  is_error: fc.option(fc.boolean(), { nil: undefined }),
});
const toolUse = fc.record({ type: fc.constant("tool_use" as const), id, name: toolName, input: fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 }) });
const thinking = fc.oneof(
  words.map((t) => ({ type: "thinking" as const, thinking: `${THINKING} ${t}`, signature: THINKING })),
  words.map((t) => ({ type: "redacted_thinking" as const, data: `${THINKING} ${t}` })),
);
const userMessage = fc.record({ role: fc.constant("user" as const), content: fc.oneof(words, fc.array(fc.oneof(textBlock, toolResult), { maxLength: 4 })) });
const assistantMessage = fc.record({ role: fc.constant("assistant" as const), content: fc.oneof(words, fc.array(fc.oneof(textBlock, thinking, toolUse), { maxLength: 4 })) });
const conversation = fc.array(fc.oneof(userMessage, assistantMessage), { maxLength: 8 }).map((m) => m as MessageParam[]);

type Block = Anthropic.Beta.BetaContentBlockParam;
const blocksOf = (m: MessageParam): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const textOf = (blocks: Block[]) =>
  blocks
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
const callsOf = (m: MessageParam) => blocksOf(m).flatMap((b) => (b.type === "tool_use" ? [{ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : []));
const resultsOf = (m: MessageParam) =>
  blocksOf(m).flatMap((b) => {
    if (b.type !== "tool_result") return [];
    const text = typeof b.content === "string" ? b.content : textOf((b.content ?? []) as Block[]);
    return [{ type: "function_call_output", call_id: b.tool_use_id, output: b.is_error ? `Error: ${text}` : text }];
  });
const saidIn = (m: MessageParam) => (textOf(blocksOf(m)) ? [{ role: m.role, content: textOf(blocksOf(m)) }] : []);

describe("the conversation as Responses input (properties)", () => {
  it("turns every tool call into a function_call with its id, name and JSON arguments, in order", () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        const calls = responsesInput(messages).filter((i) => "type" in i && i.type === "function_call");
        expect(calls).toEqual(messages.filter((m) => m.role === "assistant").flatMap(callsOf));
      }),
    );
  });

  it("turns every tool result into a function_call_output with the matching call id, an error saying so, in order", () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        const outputs = responsesInput(messages).filter((i) => "type" in i && i.type === "function_call_output");
        expect(outputs).toEqual(messages.filter((m) => m.role === "user").flatMap(resultsOf));
      }),
    );
  });

  it("keeps each message's words, trimmed, under its role, and never passes Claude's thinking on", () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        const input = responsesInput(messages);
        expect(input.filter((i) => "role" in i)).toEqual(messages.flatMap(saidIn));
        expect(JSON.stringify(input)).not.toContain(THINKING);
      }),
    );
  });

  it("takes each message in turn: a person's tool results before their words, the assistant's words before its calls", () => {
    fc.assert(
      fc.property(conversation, (messages) => {
        expect(responsesInput(messages)).toEqual(messages.flatMap<unknown>((m) => (m.role === "user" ? [...resultsOf(m), ...saidIn(m)] : [...saidIn(m), ...callsOf(m)])));
      }),
    );
  });
});

const outputText = fc.record({ type: fc.constant("output_text"), text: words });
const refusal = fc.record({ type: fc.constant("refusal"), refusal: words });
const message = fc.record({ type: fc.constant("message" as const), content: fc.array(fc.oneof(outputText, refusal), { maxLength: 3 }) });
const objectArguments = fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 }).map((o) => JSON.stringify(o));
const functionCall = fc.record({ type: fc.constant("function_call" as const), call_id: id, name: toolName, arguments: fc.option(fc.oneof(objectArguments, fc.string()), { nil: undefined }) });
const reasoning = fc.constant({ type: "reasoning" });
const answer = fc.record({
  output: fc.array(fc.oneof(message, functionCall, reasoning), { maxLength: 5 }),
  status: fc.constantFrom("completed", "incomplete", undefined),
  incomplete_details: fc.option(fc.record({ reason: fc.constantFrom("max_output_tokens", "content_filter") }), { nil: undefined }),
}) as fc.Arbitrary<ReplyBody>;

/** What a function call's arguments should become: the JSON object they say, or nothing at all. */
function argumentsOf(raw: string | undefined): unknown {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

describe("a Responses answer as a Messages reply (properties)", () => {
  it("carries the answer's words and calls in order, and stops for tools exactly when there's a call", () => {
    fc.assert(
      fc.property(answer, (body) => {
        const reply = messagesReply(body, "openai.gpt-5.6-terra");
        const items = body.output ?? [];
        const expected = items.flatMap<unknown>((item) => {
          if (item.type === "message" && "content" in item) return (item.content ?? []).flatMap((p) => (p.type === "output_text" && p.text ? [{ type: "text", text: p.text, citations: null }] : []));
          if (item.type === "function_call" && "call_id" in item) return [{ type: "tool_use", id: item.call_id, name: item.name, input: argumentsOf(item.arguments) }];
          return [];
        });
        expect(reply.content).toEqual(expected);
        const calls = items.some((i) => i.type === "function_call");
        const refused = items.some((i) => i.type === "message" && "content" in i && (i.content ?? []).some((p) => p.type === "refusal"));
        const cut = body.status === "incomplete" && body.incomplete_details?.reason === "max_output_tokens";
        expect(reply.stop_reason).toBe(calls ? "tool_use" : refused ? "refusal" : cut ? "max_tokens" : "end_turn");
      }),
    );
  });

  it("counts cached tokens apart from the rest of the input, never below zero", () => {
    const usage = fc.option(
      fc.integer({ min: 0, max: 1_000_000 }).chain((input) =>
        fc.record({ input_tokens: fc.constant(input), output_tokens: fc.integer({ min: 0, max: 100_000 }), input_tokens_details: fc.option(fc.record({ cached_tokens: fc.integer({ min: 0, max: input }) }), { nil: undefined }) }),
      ),
      { nil: undefined },
    );
    fc.assert(
      fc.property(usage, (usage) => {
        const reply = messagesReply({ output: [], usage }, "openai.gpt-5.6-terra");
        const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
        expect(reply.usage.cache_read_input_tokens).toBe(cached);
        expect(reply.usage.input_tokens).toBeGreaterThanOrEqual(0);
        expect(reply.usage.input_tokens + cached).toBe(usage?.input_tokens ?? 0);
        expect(reply.usage.output_tokens).toBe(usage?.output_tokens ?? 0);
      }),
    );
  });

  it("gives a call the JSON object its arguments say, and an empty one for anything else", () => {
    const anyArguments = fc.oneof(objectArguments, fc.string(), fc.jsonValue().map((v) => JSON.stringify(v)), fc.constant(undefined));
    fc.assert(
      fc.property(anyArguments, (raw) => {
        const [call] = messagesReply({ output: [{ type: "function_call", call_id: "call_1", name: "set_device", arguments: raw }] }, "m").content as Anthropic.Beta.BetaToolUseBlock[];
        expect(call!.input).toEqual(argumentsOf(raw));
        expect(typeof call!.input === "object" && call!.input !== null && !Array.isArray(call!.input)).toBe(true);
      }),
    );
  });

  it("sends a call back exactly as it came when the conversation goes on", () => {
    const calls = fc.array(fc.record({ type: fc.constant("function_call" as const), call_id: id, name: toolName, arguments: objectArguments }), { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(calls, (output) => {
        const reply = messagesReply({ output }, "openai.gpt-5.6-terra");
        const next = responsesInput([{ role: "assistant", content: reply.content as Block[] }]);
        expect(next).toEqual(output);
      }),
    );
  });
});

describe("naming a Bedrock model (properties)", () => {
  it("never throws, and calls any Claude model Claude", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (id) => {
        expect(typeof modelLabel(id)).toBe("string");
      }),
    );
    const claude = fc.tuple(fc.constantFrom("anthropic.", ""), fc.oneof(fc.constant(""), fc.string().map((s) => `-${s}`)));
    fc.assert(
      fc.property(claude, ([provider, rest]) => {
        expect(modelLabel(`${provider}claude${rest}`)).toBe("Claude");
      }),
    );
  });

  it('says a GPT model\'s version and name the way people do: "openai.gpt-5.6-terra" is "GPT-5.6 Terra"', () => {
    const gpt = fc.record({
      provider: fc.option(fc.stringMatching(/^[a-z]{1,8}\.$/), { nil: "" }),
      version: fc.stringMatching(/^\d{1,2}(\.\d{1,2})?$/),
      variant: fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), { maxLength: 3 }),
    });
    fc.assert(
      fc.property(gpt, ({ provider, version, variant }) => {
        const id = `${provider}gpt-${version}${variant.map((w) => `-${w}`).join("")}`;
        const name = variant.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
        expect(modelLabel(id)).toBe(`GPT-${version}${name ? ` ${name}` : ""}`);
      }),
    );
  });
});

// ---------- Fitting a long conversation ----------

describe("a long conversation cut to fit (properties)", () => {
  // Turns as the simulator makes them: what someone said, then the assistant's calls and their results, then maybe its
  // answer, any of the assistant's messages perhaps with Claude's thinking first (an answer can be thinking alone).
  const said = fc.oneof(words, fc.array(textBlock, { minLength: 1, maxLength: 3 }));
  const thought = fc.option(fc.constantFrom<Block>({ type: "thinking", thinking: "", signature: "sig" }, { type: "redacted_thinking", data: "opaque" }), { nil: undefined });
  const call = fc.tuple(id, toolName, words, thought);
  const answer = fc.option(fc.tuple(thought, fc.option(words, { nil: undefined })), { nil: undefined });
  const turnOf = fc.record({ said, calls: fc.array(call, { maxLength: 3 }), answer }).map(({ said, calls, answer }) => {
    const answered: Block[] = answer ? [...(answer[0] ? [answer[0]] : []), ...(answer[1] === undefined ? [] : [{ type: "text" as const, text: answer[1] }])] : [];
    return [
      { role: "user" as const, content: said },
      ...calls.flatMap(([callId, name, result, think], i) => [
        { role: "assistant" as const, content: [...(think ? [think] : []), { type: "tool_use" as const, id: `${callId}-${i}`, name, input: {} }] },
        { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: `${callId}-${i}`, content: result }] },
      ]),
      ...(answered.length ? [{ role: "assistant" as const, content: answered }] : []),
    ];
  });
  const conversation = fc.array(turnOf, { minLength: 1, maxLength: 14 }).map((turns) => turns.flat() as MessageParam[]);
  const limits = fc.record({ messages: fc.integer({ min: 1, max: 40 }), chars: fc.integer({ min: 20, max: 3000 }) });
  const size = (messages: MessageParam[]) => JSON.stringify(messages).length;
  const thinking = (b: Block) => b.type === "thinking" || b.type === "redacted_thinking";
  /** The messages as a cut conversation keeps them: no thinking, and no assistant message that was only thinking. */
  const unthought = (messages: MessageParam[]) =>
    messages.flatMap((m) => {
      if (m.role !== "assistant" || typeof m.content === "string" || !m.content.some(thinking)) return [m];
      const content = m.content.filter((b) => !thinking(b));
      return content.length ? [{ ...m, content }] : [];
    });

  it("keeps the latest whole turns within the limits, every tool result right after its call, or says it can't", () => {
    fc.assert(
      fc.property(conversation, limits, (messages, max) => {
        const kept = fitConversation(messages, max);
        const lastTurn = messages.slice(messages.findLastIndex(startsTurn));
        if (!kept) {
          // Only when the latest turn alone is too much.
          expect(lastTurn.length > max.messages || size(lastTurn) > max.chars).toBe(true);
          return;
        }
        expect(startsTurn(kept[0]!)).toBe(true);
        expect(kept.length).toBeLessThanOrEqual(max.messages);
        expect(size(kept)).toBeLessThanOrEqual(max.chars);
        kept.forEach((m, i) => {
          for (const b of typeof m.content === "string" ? [] : m.content) {
            if (b.type === "tool_result") expect((kept[i - 1]!.content as { id?: string }[]).map((c) => c.id)).toContain(b.tool_use_id);
          }
        });
      }),
    );
  });

  it("leaves a conversation that fits as it is, thinking and all; a cut one is its latest turns from the start of one, never less than the last, without thinking", () => {
    fc.assert(
      fc.property(conversation, limits, (messages, max) => {
        const kept = fitConversation(messages, max);
        if (messages.length <= max.messages && size(messages) <= max.chars) {
          expect(kept).toBe(messages);
          return;
        }
        if (!kept) return;
        const cut = messages.indexOf(kept[0]!);
        expect(cut).toBeGreaterThan(0);
        expect(cut).toBeLessThanOrEqual(messages.findLastIndex(startsTurn));
        expect(startsTurn(messages[cut]!)).toBe(true);
        expect(kept).toEqual(unthought(messages.slice(cut)));
        expect(kept.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).some(thinking)).toBe(false);
      }),
    );
  });
});

// ---------- The household's clock ----------

const ZONES = ["UTC", "America/Denver", "Pacific/Kiritimati", "Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns", "Australia/Lord_Howe", "Europe/London", "Pacific/Chatham"];
/** Zones whose offset never changes, so a day there is always 24 hours. */
const STEADY = new Set(["UTC", "Pacific/Kiritimati", "Asia/Kolkata", "Asia/Kathmandu"]);
const MIN_2000 = Temporal.Instant.from("2000-01-01T00:00:00Z").epochMilliseconds / 60_000;
const MIN_2100 = Temporal.Instant.from("2100-01-01T00:00:00Z").epochMilliseconds / 60_000;
/** An instant on a whole minute, as a household's clock reads one. */
const minute = fc.integer({ min: MIN_2000, max: MIN_2100 }).map((m) => Temporal.Instant.fromEpochMilliseconds(m * 60_000));
const pad = (n: number) => String(n).padStart(2, "0");
const timeOfDay = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(([h, m]) => `${pad(h)}:${pad(m)}`);
/** Whether `time` happens on `date` in `zone`, rather than falling in a daylight saving gap. */
const happens = (date: Temporal.PlainDate, time: string, zone: string) => date.toZonedDateTime({ timeZone: zone, plainTime: time }).toPlainTime().equals(Temporal.PlainTime.from(time));
const wallMinutes = (time: string) => Temporal.PlainTime.from(time).since("00:00").total("minutes");

describe("the household's clock (properties)", () => {
  it("keeps its offset in whole minutes, the nearest to what it's given, and nonsense puts it back", () => {
    const offset = fc.oneof(fc.integer({ min: -100_000, max: 100_000 }), fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.constantFrom(Number.NaN, Infinity, -Infinity));
    fc.assert(
      fc.property(offset, (minutes) => {
        const clock = new HouseholdClock();
        clock.set(minutes);
        if (!Number.isFinite(minutes)) {
          expect(clock.offsetMinutes).toBe(0);
          return;
        }
        expect(Number.isInteger(clock.offsetMinutes)).toBe(true);
        expect(Math.abs(clock.offsetMinutes - minutes)).toBeLessThanOrEqual(0.5 + 1e-6);
        if (Number.isInteger(minutes)) expect(clock.offsetMinutes).toBe(minutes);
      }),
    );
  });

  it("shifts to a time of day today in the household's zone, and two times' offsets differ by the minutes between them", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), minute, timeOfDay, timeOfDay, (zone, at, time, other) => {
        const today = at.toZonedDateTimeISO(zone).toPlainDate();
        fc.pre(happens(today, time, zone));
        const offset = HouseholdClock.offsetTo(time, zone, at);
        expect(Number.isInteger(offset)).toBe(true);
        const shifted = at.add({ minutes: offset }).toZonedDateTimeISO(zone);
        expect(shifted.toPlainDate().equals(today)).toBe(true);
        expect(shifted.toPlainTime().equals(Temporal.PlainTime.from(time))).toBe(true);
        // From the evening back to the morning, say: on a day with no clock change, the gap is the wall clock's.
        if (STEADY.has(zone)) expect(HouseholdClock.offsetTo(other, zone, at) - offset).toBe(wallMinutes(other) - wallMinutes(time));
      }),
    );
  });

  it("finds the next time of day after the household's now, within a day, measured from the real time", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), minute, fc.integer({ min: -3 * 1440, max: 3 * 1440 }), timeOfDay, (zone, at, ahead, time) => {
        const from = at.add({ minutes: ahead });
        const day = from.toZonedDateTimeISO(zone).toPlainDate();
        fc.pre(happens(day, time, zone) && happens(day.add({ days: 1 }), time, zone));
        const offset = HouseholdClock.offsetToNext(time, zone, from, at);
        expect(Number.isInteger(offset)).toBe(true);
        // Where the real clock is only moves where it's measured from.
        expect(offset).toBe(HouseholdClock.offsetToNext(time, zone, from, from) + ahead);
        const next = at.add({ minutes: offset });
        expect(next.toZonedDateTimeISO(zone).toPlainTime().equals(Temporal.PlainTime.from(time))).toBe(true);
        const after = next.since(from).total("minutes");
        expect(after).toBeGreaterThan(0);
        expect(after).toBeLessThanOrEqual(STEADY.has(zone) ? 1440 : 1500);
      }),
    );
  });
});

// ---------- Ranch devices ----------

// Friday, October 16, 2026, 7:30 PM in Denver.
const EVENING = Temporal.Instant.from("2026-10-17T01:30:00Z");
const offline = (async () => Response.json({ error: true, reason: "offline in tests" })) as unknown as typeof fetch;

/** A run length as a model might say it: nothing, a number of any size or sign, or words. */
const length = fc.oneof(
  fc.constantFrom(undefined, null, ""),
  fc.integer({ min: -60, max: 100_000 }),
  fc.double({ min: -10, max: 1e6, noNaN: true }),
  // Far too long, and anything at all (NaN and the infinities too).
  fc.double({ min: 1e6, max: 1e300 }),
  fc.double(),
  fc.integer({ min: 0, max: 5000 }).map(String),
  fc.string({ maxLength: 4 }),
);

describe("each device's limits (properties)", () => {
  it("gives every run a whole number of seconds, at least one, within the device's own cap, or refuses it in words", async () => {
    const limits = fc.record({
      maxRunS: fc.option(fc.integer({ min: 1, max: 7 * 86_400 }), { nil: undefined }),
      defaultRunS: fc.option(fc.integer({ min: 1, max: 7 * 86_400 }), { nil: undefined }),
      failsafe: fc.constantFrom("on" as const, "off" as const),
    });
    await fc.assert(
      fc.asyncProperty(limits, length, length, async (limits: DeviceLimits, seconds, minutes) => {
        const pump: Device = { id: "test.pump", name: "Pump", kind: "valve", place: "Yard", source: "Test", live: false, switchable: true, state: "off", run: null, limits, readings: [], attention: [], reachable: true };
        const hub = new DeviceHub([{ id: "test", list: async () => [pump], set: async () => pump }]);
        let request: SwitchRequest;
        try {
          ({ request } = await hub.check({ device: "pump", state: "on", seconds, minutes }));
        } catch (err) {
          expect(err).toBeInstanceOf(ToolError);
          return;
        }
        if (request.state !== "on") throw new Error("Switching on answered off.");
        const said = [seconds, minutes].some((v) => v !== undefined && v !== null && v !== "");
        if (request.seconds === null) {
          // Only a device with no cap stays on with no end, and only when no length was said.
          expect(limits.maxRunS).toBeUndefined();
          expect(said).toBe(false);
          return;
        }
        expect(Number.isInteger(request.seconds)).toBe(true);
        expect(request.seconds).toBeGreaterThanOrEqual(1);
        if (limits.maxRunS) expect(request.seconds).toBeLessThanOrEqual(limits.maxRunS);
        if (!said) expect(request.seconds).toBe(limits.defaultRunS);
        // And the run ends at a time the clock can say.
        expect(() => EVENING.add({ seconds: request.seconds! })).not.toThrow();
      }),
    );
  });

  it("switches a sample device on for no longer than its cap, and a refused switch changes nothing", async () => {
    const names = (await sampleRanch({ now: () => EVENING, fetch: offline }).devices.all()).filter((d) => d.switchable).map((d) => d.name);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...names), length, length, async (name, seconds, minutes) => {
        const ranch = sampleRanch({ now: () => EVENING, fetch: offline });
        const before = (await ranch.devices.list({ device: name }))[0]!;
        try {
          await ranch.devices.set({ device: name, state: "on", seconds, minutes });
        } catch (err) {
          expect(err).toBeInstanceOf(ToolError);
          expect((await ranch.devices.list({ device: name }))[0]).toEqual(before);
          return;
        }
        const after = (await ranch.devices.list({ device: name }))[0]!;
        expect(after.state).toBe("on");
        if (after.limits.maxRunS) {
          expect(after.run!.secondsLeft).toBeGreaterThanOrEqual(1);
          expect(after.run!.secondsLeft).toBeLessThanOrEqual(after.limits.maxRunS);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("says a run's length in words that never reach 60 minutes or 60 seconds, agree in number, and are off by half a minute at most", () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 1e7, noNaN: true }), (seconds) => {
        const said = duration(seconds);
        const parts = [...said.matchAll(/(\d+) (hour|minute|second)(s?)(?= |$)/g)];
        expect(parts.map((p) => p[0]).join(" ")).toBe(said);
        let total = 0;
        for (const [, n, unit, s] of parts) {
          expect(s).toBe(n === "1" ? "" : "s");
          if (unit !== "hour") expect(Number(n)).toBeLessThan(60);
          total += Number(n) * { hour: 3600, minute: 60, second: 1 }[unit as "hour" | "minute" | "second"];
        }
        const rounded = Math.max(0, Math.round(seconds));
        expect(Math.abs(total - rounded)).toBeLessThanOrEqual(rounded < 3600 ? 0 : 30);
      }),
    );
  });
});

// ---------- Ordering ----------

// Friday, October 16, 2026, 10:30 AM in Denver.
const FRIDAY = Temporal.Instant.from("2026-10-16T16:30:00Z");
const CATALOG = await new SampleSupplier({ now: () => FRIDAY, timeZone: "America/Denver" }).catalog();
const PARENTS = ["Nick", "Holly"];

describe("money and who approves an order (properties)", () => {
  it("says any whole number of cents as dollars, to the cent", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }).map(Number), (cents) => {
        expect(dollars(cents)).toBe(`$${Math.floor(cents / 100)}.${pad(cents % 100)}`);
      }),
    );
  });

  it("orders a whole number from 1 to 10,000, or the usual order when none is said, and refuses any other amount", async () => {
    const amount = fc.oneof(
      fc.constantFrom(undefined, null, ""),
      fc.integer({ min: -5, max: 500 }),
      fc.integer({ min: 9_990, max: 10_010 }),
      fc.double(),
      fc.integer({ min: -5, max: 500 }).map(String),
      fc.string({ maxLength: 4 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...CATALOG), amount, async (product, said) => {
        const store = new SampleSupplier({ now: () => FRIDAY, timeZone: "America/Denver" });
        const unsaid = said === undefined || said === null || said === "";
        const n = Number(said);
        const ask = quote([store], [{ supply: product.supply, quantity: said }], { today: Temporal.PlainDate.from("2026-10-16") });
        if (!unsaid && !(Number.isInteger(n) && n >= 1 && n <= 10_000)) {
          await expect(ask).rejects.toThrow(ToolError);
          return;
        }
        const q = await ask;
        expect(q.lines).toEqual([expect.objectContaining({ product: product.id, quantity: unsaid ? product.usualQuantity : n })]);
      }),
    );
  });

  it("places a parent's order at or under the household's limit, sends one over it to the other parent, always sends anyone else's to a parent, and takes none from a guest", async () => {
    // Parents, kids, the farm hand, the kitchen screen (no one in particular) and a voice no one knows.
    const speaker = fc.constantFrom("Nick", "Holly", "Eli", "Jak", "Jon", null, "guest");
    const items = fc.array(fc.record({ supply: fc.constantFrom(...CATALOG.map((p) => p.supply)), quantity: fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }) }), { minLength: 1, maxLength: 6 });
    // Limits on either side of the total, right at it and a cent under it, and none at all.
    const limit = fc.oneof(fc.integer({ min: 0, max: 200_000 }), fc.constantFrom("at the total", "a cent under", null));
    await fc.assert(
      fc.asyncProperty(speaker, items, limit, async (who, items, limit) => {
        const total = items.reduce((sum, it) => {
          const p = CATALOG.find((x) => x.supply === it.supply)!;
          return sum + (it.quantity ?? p.usualQuantity) * p.unitPriceCents;
        }, 0);
        const h = new SampleHousehold({ now: () => FRIDAY });
        h.state.orderLimitCents = limit === "at the total" ? total : limit === "a cent under" ? total - 1 : limit;
        const placing = h.as(who).call("place_order", { items });
        if (who === "guest") {
          await expect(placing).rejects.toThrow(ToolError);
          expect(h.state.orders).toEqual([]);
          return;
        }
        const res = (await placing) as { status: string; approvers?: string[]; requestId?: string };
        const order = h.state.orders[0]!;
        const parent = who !== null && PARENTS.includes(who);
        const limitCents = h.state.orderLimitCents;
        if (parent && (limitCents === null || total <= limitCents)) {
          expect(res.status).toBe("done");
          expect(order).toMatchObject({ status: "placed", totalCents: total });
          return;
        }
        expect(res.status).toBe("waiting_for_approval");
        expect(res.approvers).toEqual(PARENTS.filter((p) => p !== who));
        expect(order).toMatchObject({ status: "waiting_for_approval", deliveryDate: null, totalCents: total });
        // A yes from someone it waits for places it, for the same total.
        await h.as(res.approvers![0]!).call("decide_approval", { request: res.requestId, decision: "approve" });
        expect(order).toMatchObject({ status: "placed", totalCents: total });
      }),
      { numRuns: 80 },
    );
  });
});
