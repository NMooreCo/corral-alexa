import type Anthropic from "@anthropic-ai/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, getToolUiResourceUri, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import "./style.css";

/**
 * A simulated Alexa+ on an Echo Show. This page is the MCP client: it
 * connects to the server's /mcp over Streamable HTTP, lists Corral's tools,
 * calls them, and renders their MCP Apps screens. Claude (on Amazon Bedrock or
 * the Claude API, through /echo/model) only decides what to say or which tool
 * to call next.
 */

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;
type ModelTool = Anthropic.Beta.BetaTool;
type Reply = Anthropic.Beta.BetaMessage;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

// ---------- Which device this is ----------

// /echo is an Echo Show 8 in the kitchen. /echo?devices=2 puts two of these pages side by side on one household,
// each with ?embed=1, a place and a model (?place=Barn&show=5). ?household= names a sample household other than the shared one.
const params = new URLSearchParams(location.search);
const SHOWS: Record<string, { name: string; width: number; height: number }> = {
  "5": { name: "Echo Show 5", width: 960, height: 480 },
  "8": { name: "Echo Show 8", width: 1280, height: 800 },
};
const show = SHOWS[params.get("show") ?? "8"] ?? SHOWS["8"]!;
const place = (params.get("place") ?? "").trim().slice(0, 40);
const embedded = params.get("embed") === "1";
const householdParam = params.get("household");

const SCREEN_W = show.width;
const SCREEN_H = show.height;
const MAX_STEPS = 8;
/** Who Alexa recognized, on every MCP request. Only the sample household reads it (sample mode has no sign-in). */
const SPEAKER_HEADER = "x-demo-person";
/** Things to try. One with `as` is said by that person: the picker switches to them first. */
const SUGGESTIONS: (string | { text: string; as: string })[] = [
  "What's going on today?",
  { text: "Can I have a sleepover at Ava's on Friday?", as: "Eli" },
  { text: "Anything waiting for me?", as: "Nick" },
  "Did anyone collect the eggs yet?",
  "Jak emptied the dishwasher.",
  "We're down to two bags of horse feed.",
  "Add tortillas and salsa to the grocery list.",
  "Put the dentist on Thursday at 3:30 for Jak.",
  "Where's Eli right now?",
  "How many points does Jak have?",
  "Good morning.",
  "Run the greenhouse misters for 30 seconds.",
  "It's going down to 12 tonight. Get the place ready.",
  "Are any of the animals outside the fence?",
];
// What to try on a display somewhere else on the place.
const PLACE_SUGGESTIONS: Record<string, string[]> = {
  barn: ["Jordan fed the horses.", "We used two bales of hay.", "What chores are left today?"],
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const deviceEl = $("device");
const screenEl = $("screen");
const idleEl = $("idle");
const appHost = $("app-host");
const captionEl = $("caption");
const heardEl = $("heard");
const saidEl = $("said");
const lightbar = $("lightbar");
const micBtn = $<HTMLButtonElement>("mic");
const micLabel = $("mic-label");
const askForm = $<HTMLFormElement>("ask-form");
const askInput = $<HTMLInputElement>("ask-input");
const handsFreeEl = $<HTMLInputElement>("handsfree");
const voiceNote = $("voice-note");
const mcpLog = $("mcp-log");
const modelLog = $("model-log");
const passcodeForm = $<HTMLFormElement>("passcode-form");
const passcodeInput = $<HTMLInputElement>("passcode");
const passcodeNote = $("passcode-note");
const themeEl = $<HTMLSelectElement>("theme");
const speakersEl = $("speakers");
const speakerList = $("speaker-list");
const speakerChip = $("speaker-chip");

/** Someone the picker offers: a person in the household, or a voice Alexa doesn't know. */
interface Speaker {
  /** What the header says: a person's short name, or "guest". */
  said: string;
  name: string;
  role: string;
}
const GUEST: Speaker = { said: "guest", name: "Someone Alexa doesn't recognize", role: "Guest" };

const state = {
  /** Who's talking now; the first person in the household until someone picks. */
  speaker: null as Speaker | null,
  speakers: [] as Speaker[],
  messages: [] as Msg[],
  /** What someone did on the screen since the assistant last spoke. */
  screenNotes: [] as string[],
  busy: false,
  /** Who's calling tools right now, for the traffic log. */
  actor: "screen" as "assistant" | "screen" | "page",
};

// ---------- The device frame ----------

const stageEl = deviceEl.parentElement!;
screenEl.style.width = `${SCREEN_W}px`;
screenEl.style.height = `${SCREEN_H}px`;

/**
 * One of two devices also fits the height it's given: what's left after its
 * label, the talk bar, and, in a tall column (two devices side by side), the
 * suggestions and a few rows of the traffic log. Stacked on a phone or a
 * tablet, it's the screen and the talk bar alone.
 */
function roomForDevice(): number {
  const roomy = innerHeight > 520 && innerHeight > innerWidth * 0.85;
  document.documentElement.classList.toggle("roomy", roomy);
  const talk = document.querySelector<HTMLElement>(".talk")!;
  const stageChrome = stageEl.offsetHeight - deviceEl.offsetHeight;
  let panel = talk.offsetHeight;
  if (roomy) panel += 8 + $("chips").offsetHeight + 8 + 150;
  // The gap between the stage and the panel, and the space under the panel (see .embedded .layout).
  return Math.max(90, innerHeight - stageChrome - panel - 10 - 12);
}

function fit() {
  const room = embedded ? roomForDevice() : Infinity;
  // The bezel is drawn outside the device, inside the stage's padding.
  const width = embedded ? stageEl.clientWidth - 30 : deviceEl.clientWidth;
  const scale = Math.min(1, width / SCREEN_W, room / SCREEN_H);
  screenEl.style.transform = `scale(${scale})`;
  deviceEl.style.height = `${SCREEN_H * scale}px`;
  if (embedded) {
    deviceEl.style.width = `${SCREEN_W * scale}px`;
    // The traffic log fills the rest, down to the log box's padding and the space under the panel.
    mcpLog.style.maxHeight = `${Math.max(60, innerHeight - mcpLog.getBoundingClientRect().top - 10 - 12)}px`;
  }
}
new ResizeObserver(fit).observe(embedded ? stageEl : deviceEl);
if (embedded) addEventListener("resize", fit);

function tick() {
  $("idle-clock").textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: householdTimeZone() });
}
setInterval(tick, 15_000);

function setLight(s: "idle" | "listening" | "thinking" | "speaking") {
  lightbar.dataset.state = s;
}

let captionTimer: ReturnType<typeof setTimeout> | undefined;
function caption(heard: string, said: string) {
  heardEl.textContent = heard ? `"${heard}"` : "";
  saidEl.textContent = said;
  captionEl.hidden = !heard && !said;
  clearTimeout(captionTimer);
  if (said) captionTimer = setTimeout(() => (captionEl.hidden = true), 9000 + said.length * 40);
}

// ---------- Logs ----------

function addLog(list: HTMLElement, who: string, text: string, meta = "", tone = "") {
  const li = document.createElement("li");
  if (tone) li.className = tone;
  const time = document.createElement("span");
  time.className = "when";
  time.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const tag = document.createElement("span");
  // A data attribute, not a class: a class named "screen" would pick up the device screen's styles.
  tag.className = "who";
  tag.dataset.who = who;
  tag.textContent = who;
  const body = document.createElement("span");
  body.className = "what";
  body.textContent = text;
  const m = document.createElement("span");
  m.className = "meta";
  m.textContent = meta;
  li.append(time, tag, body, m);
  list.prepend(li);
  while (list.children.length > 80) list.lastElementChild?.remove();
}

/** The MCP client's own requests, as they go over the wire. */
const loggingFetch: typeof fetch = async (input, init) => {
  // Who's calling, as it was when the call went out: tools the assistant runs together finish in any order.
  const actor = state.actor;
  const started = performance.now();
  let label = init?.method ?? "GET";
  if (typeof init?.body === "string") {
    try {
      const msg = JSON.parse(init.body) as { method?: string; params?: { name?: string; uri?: string; arguments?: unknown } };
      if (msg.method) {
        label = msg.method;
        if (msg.method === "tools/call") label += ` ${msg.params?.name} ${JSON.stringify(msg.params?.arguments ?? {})}`;
        if (msg.method === "resources/read") label += ` ${msg.params?.uri}`;
      }
    } catch {
      // Not JSON-RPC; log the method alone.
    }
  }
  const res = await fetch(input, init);
  const ms = Math.round(performance.now() - started);
  const speaker = new Headers(init?.headers).get(SPEAKER_HEADER);
  const as = speaker ? ` · as ${decodeURIComponent(speaker)}` : "";
  // Screens ask the household's change counter every few seconds; those stay out of the log unless one fails.
  const poll = label.startsWith("tools/call household_version") && res.ok;
  if (label !== "GET" && !poll) addLog(mcpLog, actor, label, `${res.status} · ${ms} ms${as}`, res.ok ? "" : "bad");
  return res;
};

// ---------- MCP ----------

const client = new Client({ name: "corral-echo-show-simulator", version: "0.1.0" });
/**
 * The headers on every MCP request. The transport reads these afresh for
 * each request, so changing the speaker here takes effect on the next call,
 * from the assistant and the screens alike, with no reconnecting.
 */
const mcpHeaders: Record<string, string> = {};
let modelTools: ModelTool[] = [];
const uiByTool = new Map<string, string>();
const uiHtml = new Map<string, string>();
let instructions = "";

function householdTimeZone(): string {
  return /time zone is ([A-Za-z_]+\/[A-Za-z_/]+)/.exec(instructions)?.[1] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** One of this server's household routes, for the household this page is on. */
function householdUrl(path: string): URL {
  const url = new URL(path, location.origin);
  if (householdParam) url.searchParams.set("household", householdParam);
  return url;
}

async function connect() {
  state.actor = "page";
  await client.connect(new StreamableHTTPClientTransport(householdUrl("/mcp"), { fetch: loggingFetch, requestInit: { headers: mcpHeaders } }));
  instructions = client.getInstructions() ?? "";
  const { tools } = await client.listTools();
  for (const t of tools) {
    const ui = (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
    // A tool only screens may call is the screen's business, not the assistant's.
    if (ui?.visibility && !ui.visibility.includes("model")) continue;
    const uri = getToolUiResourceUri(t);
    if (uri) uiByTool.set(t.name, uri);
    const { $schema: _drop, ...schema } = t.inputSchema as Record<string, unknown>;
    modelTools.push({ name: t.name, description: t.description ?? t.title ?? t.name, input_schema: schema as ModelTool["input_schema"] });
  }
  for (const uri of new Set(uiByTool.values())) {
    const res = await client.readResource({ uri });
    const page = res.contents[0] as { text?: string } | undefined;
    if (page?.text) uiHtml.set(uri, page.text);
  }
  await loadSpeakers();
  state.actor = "screen";
  tick();
}

// ---------- Who's speaking ----------

/** The household's people from its own people tool, plus a guest; the first person speaks until someone picks. */
async function loadSpeakers() {
  try {
    const res = await client.callTool({ name: "people", arguments: {} });
    const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "[]";
    const people = JSON.parse(text) as { name: string; shortName: string; roles: string[] }[];
    state.speakers = [...people.map((p) => ({ said: p.shortName, name: p.name, role: p.roles[0] ?? "" })), GUEST];
  } catch {
    state.speakers = [];
  }
  if (!state.speakers.length) return;
  speakerList.replaceChildren(
    ...state.speakers.map((s, i) => {
      const label = document.createElement("label");
      label.className = "speaker";
      label.dataset.tone = String(i % 6);
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "speaker";
      input.value = s.said;
      input.addEventListener("change", () => input.checked && void setSpeaker(s));
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = s === GUEST ? "?" : (s.said[0] ?? "?").toUpperCase();
      const name = document.createElement("span");
      name.className = "speaker-name";
      name.textContent = s === GUEST ? s.name : s.said;
      const role = document.createElement("span");
      role.className = "speaker-role";
      role.textContent = s.role;
      label.append(input, avatar, name, role);
      return label;
    }),
  );
  speakersEl.hidden = false;
  // The household's first member, who set up the Echo: a parent in the sample, so every suggestion works from the start.
  await setSpeaker(state.speakers[0]!, { quiet: true });
}

let greetTimer: ReturnType<typeof setTimeout> | undefined;

/** Puts `s` on every MCP call from here on, says so on the device, and shows the current screen as they'd see it. */
async function setSpeaker(s: Speaker, opts: { quiet?: boolean } = {}) {
  const changed = state.speaker?.said !== s.said;
  state.speaker = s;
  mcpHeaders[SPEAKER_HEADER] = encodeURIComponent(s.said);
  for (const input of speakerList.querySelectorAll<HTMLInputElement>("input[name=speaker]")) input.checked = input.value === s.said;
  const tone = String(Math.max(0, state.speakers.indexOf(s)) % 6);
  const avatar = $("speaker-avatar");
  avatar.textContent = s === GUEST ? "?" : (s.said[0] ?? "?").toUpperCase();
  speakerChip.dataset.tone = tone;
  speakerChip.hidden = false;
  // Alexa greets someone it knows by name for a moment, then keeps just the name in the corner.
  const settled = s === GUEST ? "Guest" : s.said;
  $("speaker-text").textContent = opts.quiet ? settled : s === GUEST ? "I don't know this voice" : `Hi, ${s.said}`;
  speakerChip.classList.toggle("greeting", !opts.quiet);
  clearTimeout(greetTimer);
  greetTimer = setTimeout(() => {
    $("speaker-text").textContent = settled;
    speakerChip.classList.remove("greeting");
  }, 2600);
  if (!changed) return;
  if (!opts.quiet) addLog(modelLog, "page", `Now speaking: ${s === GUEST ? "a guest (a voice Alexa doesn't recognize)" : `${s.name}, ${s.role}`}`);
  await refreshScreen();
}

/** What the assistant is told about the speaker, before each thing they say. */
function speakerNote(): string | null {
  const s = state.speaker;
  if (!s) return null;
  return s === GUEST ? "(Alexa doesn't recognize this voice: a guest.)" : `(Alexa recognized the voice: ${s.name}${s.role ? `, ${s.role}` : ""}.)`;
}

// ---------- Screens (MCP Apps) ----------

/** The screen on the device, and the tool call that showed it, to show again as someone else would see it. */
let mounted: { uri: string; bridge: AppBridge; ready: Promise<void>; tool: string; args: Record<string, unknown> } | null = null;

function hostContext() {
  return {
    theme: themeEl.value as "dark" | "light",
    displayMode: "fullscreen" as const,
    availableDisplayModes: ["fullscreen" as const],
    containerDimensions: { width: SCREEN_W, height: SCREEN_H },
    platform: "web" as const,
    locale: "en-US",
    timeZone: householdTimeZone(),
    deviceCapabilities: { touch: true, hover: false },
    // Keep the screen's content clear of the caption and light bar.
    safeAreaInsets: { top: 0, right: 0, bottom: 10, left: 0 },
  };
}

/** Shows a tool's screen with its result, reusing the one already up when it's the same screen. */
async function showScreen(tool: string, uri: string, args: Record<string, unknown>, result: ToolResult) {
  const html = uiHtml.get(uri);
  if (!html) return;
  if (!mounted || mounted.uri !== uri) {
    await mounted?.bridge.close().catch(() => {});
    appHost.replaceChildren();
    const iframe = document.createElement("iframe");
    iframe.title = "Screen";
    iframe.setAttribute("sandbox", "allow-scripts");
    appHost.append(iframe);
    const bridge = new AppBridge(client, { name: "Echo Show simulator", version: "0.1.0" }, { serverTools: {}, logging: {}, updateModelContext: { text: {} } }, { hostContext: hostContext() });
    let ready!: () => void;
    const readyP = new Promise<void>((r) => (ready = r));
    bridge.oninitialized = () => ready();
    bridge.onupdatemodelcontext = async ({ content }) => {
      for (const c of content ?? []) {
        if (c.type !== "text") continue;
        // The screen's note ends with a plain sentence after its YAML header.
        const line = c.text.split("\n---\n").pop()?.trim() ?? c.text;
        state.screenNotes.push(line);
        addLog(modelLog, "screen", line);
      }
      return {};
    };
    bridge.onrequestdisplaymode = async () => ({ mode: "fullscreen" });
    await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    iframe.srcdoc = html;
    mounted = { uri, bridge, ready: readyP, tool, args };
    idleEl.hidden = true;
  }
  mounted.tool = tool;
  mounted.args = args;
  await mounted.ready;
  await mounted.bridge.sendToolInput({ arguments: args });
  await mounted.bridge.sendToolResult(result as Parameters<AppBridge["sendToolResult"]>[0]);
}

themeEl.addEventListener("change", () => void mounted?.bridge.sendHostContextChange({ theme: themeEl.value as "dark" | "light" }));

/** The screen that's up, called again as whoever's speaking now: a private event opens up for its owner, the farm hand's day is the ranch's. */
async function refreshScreen() {
  if (!mounted) return;
  const { tool, uri, args } = mounted;
  const was = state.actor;
  state.actor = "page";
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    if (!result.isError) await showScreen(tool, uri, args, result);
  } catch {
    // The screen keeps what it had; its own refresh tries again.
  } finally {
    state.actor = was;
  }
}

// ---------- The assistant ----------

// ---------- The demo passcode ----------

const PASSCODE_KEY = "corral-echo-passcode";
// For a browser that won't store it: kept for this visit.
let visitPasscode: string | null = null;
// The question that was waiting on the passcode, asked again once it's in.
let waitingQuestion: string | null = null;
// Starting the household over was waiting on the passcode.
let waitingStartOver = false;

class PasscodeNeeded extends Error {}

function passcode(): string | null {
  try {
    return localStorage.getItem(PASSCODE_KEY) ?? visitPasscode;
  } catch {
    return visitPasscode;
  }
}

function rememberPasscode(value: string | null) {
  visitPasscode = value;
  try {
    if (value) localStorage.setItem(PASSCODE_KEY, value);
    else localStorage.removeItem(PASSCODE_KEY);
  } catch {
    // The visit's copy is enough.
  }
}

function askForPasscode(note: string) {
  passcodeNote.textContent = note;
  passcodeForm.hidden = false;
  passcodeForm.scrollIntoView({ block: "nearest" });
  passcodeInput.focus();
}

async function callModel(): Promise<Reply> {
  const started = performance.now();
  const timeZone = householdTimeZone();
  const res = await fetch("/echo/model", {
    method: "POST",
    headers: { "content-type": "application/json", ...(passcode() ? { "x-demo-passcode": passcode()! } : {}) },
    body: JSON.stringify({
      messages: state.messages,
      tools: modelTools,
      context: { instructions, timeZone, now: new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }), ...(place ? { place } : {}) },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Reply & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    if (body.error?.code === "passcode") {
      const tried = passcode() !== null;
      if (tried) rememberPasscode(null);
      const note = tried ? "That passcode didn't work. Check it and try again." : "Enter the demo passcode to start.";
      askForPasscode(note);
      throw new PasscodeNeeded(note);
    }
    throw new Error(body.error?.message ?? "The assistant didn't answer.");
  }
  const ms = Math.round(performance.now() - started);
  const u = body.usage;
  const tokens = u ? `${u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} in (${u.cache_read_input_tokens ?? 0} cached), ${u.output_tokens} out` : "";
  const uses = body.content.filter((b) => b.type === "tool_use").map((b) => (b.type === "tool_use" ? `${b.name} ${JSON.stringify(b.input)}` : ""));
  const words = body.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
  addLog(modelLog, "claude", uses.length ? `calls ${uses.join(", ")}` : `says "${words}"`, `${body.model} · ${ms} ms · ${tokens}`);
  return body;
}

/**
 * The reply as it goes back into the conversation. If the main model
 * declined partway and the fallback model finished, the blocks the fallback
 * replaced (before the last fallback marker) don't go back.
 */
function echoable(content: Block[]): Block[] {
  const last = content.map((b) => b.type as string).lastIndexOf("fallback");
  if (last < 0) return content;
  return content.filter((b, i) => i > last || !["thinking", "redacted_thinking", "tool_use"].includes(b.type));
}

async function runTool(use: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const args = (use.input ?? {}) as Record<string, unknown>;
  try {
    const result = await client.callTool({ name: use.name, arguments: args });
    const uri = uiByTool.get(use.name);
    if (uri && !result.isError) await showScreen(use.name, uri, args, result);
    const text = (result.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { type: "tool_result", tool_use_id: use.id, content: (text || JSON.stringify(result.structuredContent ?? {})).slice(0, 20_000), is_error: Boolean(result.isError) };
  } catch (err) {
    return { type: "tool_result", tool_use_id: use.id, content: err instanceof Error ? err.message : "That tool didn't answer.", is_error: true };
  }
}

async function ask(text: string) {
  text = text.trim();
  if (!text || state.busy) return;
  state.busy = true;
  stopSpeaking();
  setLight("thinking");
  caption(text, "");
  const before = state.messages.length;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  // Who said it, as Alexa+ would know from the voice: each turn says, since the speaker can change mid-conversation.
  const who = speakerNote();
  if (who) content.push({ type: "text", text: who });
  const notes = state.screenNotes.splice(0);
  if (notes.length) content.push({ type: "text", text: `(On the screen since you last spoke: ${notes.join(" ")})` });
  content.push({ type: "text", text });
  state.messages.push({ role: "user", content });
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await callModel();
      const blocks = echoable(reply.content);
      state.messages.push({ role: "assistant", content: blocks as Anthropic.Beta.BetaContentBlockParam[] });
      const uses = blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const said = blocks.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
      if (reply.stop_reason === "tool_use" && uses.length) {
        if (said) caption(text, said);
        // Every result goes back together, in one message. The calls run side by side, so the log says the assistant made each of them until they're all back.
        state.actor = "assistant";
        const results = await Promise.all(uses.map(runTool)).finally(() => (state.actor = "screen"));
        state.messages.push({ role: "user", content: results });
        continue;
      }
      respond(text, reply.stop_reason === "refusal" ? "Sorry, I can't help with that one." : said || "Done.");
      return;
    }
    respond(text, "That took more steps than I'd like. Try asking another way.");
  } catch (err) {
    // An unanswered turn would leave the conversation half-finished: take it back.
    state.messages.length = before;
    state.screenNotes.unshift(...notes);
    if (err instanceof PasscodeNeeded) {
      waitingQuestion = text;
      caption(text, err.message);
      setLight("idle");
      return;
    }
    respond(text, err instanceof Error ? err.message : "Something went wrong.");
  } finally {
    state.busy = false;
  }
}

function respond(heard: string, said: string) {
  caption(heard, said);
  speak(said);
}

// ---------- Speaking ----------

function voice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  return voices.find((v) => /Aria|Jenny|Samantha|Google US English/.test(v.name)) ?? voices.find((v) => v.lang === "en-US") ?? voices[0];
}

function speak(text: string) {
  if (!("speechSynthesis" in window) || !text) return setLight("idle");
  const u = new SpeechSynthesisUtterance(text);
  const v = voice();
  if (v) u.voice = v;
  u.rate = 1.04;
  u.onstart = () => {
    setLight("speaking");
    pauseListening();
  };
  u.onend = u.onerror = () => {
    setLight("idle");
    resumeListening();
  };
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- Listening ----------

interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
const RecognitionCtor = ((window as unknown as { SpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition) as (new () => Recognition) | undefined;

let recognition: Recognition | null = null;
let listening = false;
let pausedForSpeech = false;
const WAKE = /\b(?:hey\s+)?alexa\b[\s,.!?]*(.*)$/i;

function startListening(handsFree: boolean) {
  if (!RecognitionCtor) return;
  recognition?.stop();
  const r = new RecognitionCtor();
  r.lang = "en-US";
  r.continuous = handsFree;
  r.interimResults = true;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i]!;
      const words = result[0]?.transcript ?? "";
      if (!result.isFinal) {
        if (!handsFree || WAKE.test(words)) caption(handsFree ? (WAKE.exec(words)?.[1] ?? "") : words, "");
        continue;
      }
      if (!handsFree) return void ask(words);
      const command = WAKE.exec(words)?.[1]?.trim();
      if (command) void ask(command);
    }
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") voiceNote.textContent = "The microphone is blocked for this page. Type instead, or allow it in the browser.";
  };
  r.onend = () => {
    listening = false;
    micBtn.setAttribute("aria-pressed", "false");
    micLabel.textContent = "Talk";
    if (lightbar.dataset.state === "listening") setLight("idle");
    if (handsFreeEl.checked && !pausedForSpeech) setTimeout(() => startListening(true), 300);
  };
  recognition = r;
  r.start();
  listening = true;
  micBtn.setAttribute("aria-pressed", "true");
  micLabel.textContent = handsFree ? "Listening for Alexa" : "Listening";
  if (!handsFree) setLight("listening");
}

function pauseListening() {
  if (!handsFreeEl.checked) return;
  pausedForSpeech = true;
  recognition?.stop();
}

function resumeListening() {
  if (!pausedForSpeech) return;
  pausedForSpeech = false;
  if (handsFreeEl.checked) startListening(true);
}

if (!RecognitionCtor) {
  micBtn.disabled = true;
  handsFreeEl.disabled = true;
  voiceNote.textContent = "Talking needs Chrome or Edge; typing works everywhere.";
}

micBtn.addEventListener("click", () => {
  if (listening && !handsFreeEl.checked) return recognition?.stop();
  stopSpeaking();
  startListening(false);
});
handsFreeEl.addEventListener("change", () => {
  if (handsFreeEl.checked) startListening(true);
  else recognition?.stop();
});
askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = askInput.value;
  askInput.value = "";
  void ask(text);
});
passcodeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = passcodeInput.value.trim();
  if (!value) return passcodeInput.focus();
  rememberPasscode(value);
  passcodeInput.value = "";
  passcodeForm.hidden = true;
  const question = waitingQuestion;
  waitingQuestion = null;
  if (question) void ask(question);
  if (waitingStartOver) void startOver();
});
// Saved on the other device in the two-device view: this one has it too.
addEventListener("storage", (e) => {
  if (e.key === PASSCODE_KEY && e.newValue) passcodeForm.hidden = true;
});
if (document.body.dataset.passcode === "required" && !passcode()) askForPasscode("This demo needs a passcode before it can talk.");
function newConversation() {
  state.messages = [];
  state.screenNotes = [];
  stopSpeaking();
  caption("", "");
  addLog(modelLog, "page", "New conversation");
}
$("reset").addEventListener("click", newConversation);

/** Starts the shared household over for every device on it (a fresh demo take), then this one's conversation and screen. */
async function startOver() {
  waitingStartOver = false;
  const res = await fetch(householdUrl("/household/reset"), { method: "POST", headers: passcode() ? { "x-demo-passcode": passcode()! } : {} }).catch(() => null);
  if (res?.status === 401) {
    const tried = passcode() !== null;
    if (tried) rememberPasscode(null);
    waitingStartOver = true;
    return askForPasscode(tried ? "That passcode didn't work. Check it and try again." : "Enter the demo passcode to start the household over.");
  }
  if (!res?.ok) return caption("", "Couldn't start the household over. Try again.");
  newConversation();
  // The household starts over from its seed, which may name different people than it did.
  await loadSpeakers();
  addLog(modelLog, "page", "Started the household over");
  await home().catch(() => {});
}
$("start-over").addEventListener("click", () => void startOver());
$<HTMLAnchorElement>("two-devices").href = `/echo?devices=2${householdParam ? `&household=${encodeURIComponent(householdParam)}` : ""}`;

// In the two-device view, the page around both devices starts their conversations over and shows the passcode box.
addEventListener("message", (e) => {
  if (e.source !== parent || e.origin !== location.origin) return;
  const msg = e.data as { type?: string; action?: string; note?: string } | null;
  if (msg?.type !== "corral-echo") return;
  if (msg.action === "new-conversation") {
    newConversation();
    void loadSpeakers();
  }
  if (msg.action === "home") void home().catch(() => {});
  if (msg.action === "passcode") askForPasscode(msg.note ?? "Enter the demo passcode.");
});

$("device-model").textContent = show.name;
if (embedded) {
  document.body.classList.add("embedded");
  $("device-label").hidden = false;
  $("device-place").textContent = place || "Kitchen";
  $("device-show").textContent = show.name;
  document.title = `${place || "Kitchen"} ${show.name}: Corral for Alexa+`;
}
const tries = PLACE_SUGGESTIONS[place.toLowerCase()] ?? SUGGESTIONS;
for (const s of embedded ? tries.slice(0, 3) : tries) {
  const b = document.createElement("button");
  b.type = "button";
  const text = typeof s === "string" ? s : s.text;
  const as = typeof s === "string" ? null : s.as;
  if (as) {
    const who = document.createElement("span");
    who.className = "chip-as";
    who.textContent = as;
    b.append(who, " ");
  }
  b.append(text);
  if (as) b.setAttribute("aria-label", `As ${as}: ${text}`);
  b.addEventListener("click", async () => {
    // Said by someone in particular: switch to them first, as if they'd walked up and spoken.
    const speaker = as ? state.speakers.find((p) => p.said === as) : undefined;
    if (state.busy) return;
    if (speaker && speaker !== state.speaker) await setSpeaker(speaker);
    void ask(text);
  });
  $("chips").append(b);
}

// ---------- The demo, played for a recording ----------

/**
 * One beat of the demo: who says it, what they say, whether it's only said
 * when the assistant has just asked something (a yes to its question), and how
 * long to let the screen sit before the next beat, so a viewer can read it.
 */
interface DemoBeat {
  as: string;
  say: string;
  ifAsked?: boolean;
  linger?: number;
  /** Longer still when a recording taps through the screen's tabs here (?taps=1). */
  taps?: number;
  /** Part of the short demo too (?demo=short), the headline beats only. */
  short?: boolean;
}

/**
 * The demo, in the order the video tells it. Every answer comes from the real
 * model, live. The animals wander off after 6 PM in the sample, so the freeze
 * beat finds them outside the fence in an evening take.
 */
const DEMO: DemoBeat[] = [
  { as: "Nick", say: "What's going on tonight?", linger: 6000, taps: 14000, short: true },
  { as: "Jak", say: "I emptied the dishwasher." },
  { as: "Eli", say: "Can I have a sleepover at Ava's on Friday?", short: true },
  { as: "Eli", say: "Yes please.", ifAsked: true, short: true },
  { as: "Nick", say: "Anything waiting for me?", linger: 4000, short: true },
  { as: "Nick", say: "Approve the sleepover.", short: true },
  { as: "Nick", say: "Run the greenhouse misters for 30 seconds.", short: true },
  { as: "Nick", say: "Yes.", ifAsked: true, linger: 6000, short: true },
  { as: "Jak", say: "Can you turn on the coop heat lamp?", short: true },
  { as: "Jak", say: "Yes please.", ifAsked: true },
  { as: "Nick", say: "It's going down to 12 tonight. Get the place ready.", linger: 3000, short: true },
  { as: "Nick", say: "Yes, do all of that.", ifAsked: true, linger: 4000, short: true },
  // Alexa offers the low propane; Nick has it ordered, and the Supplies screen shows it on order with its day.
  { as: "Nick", say: "Order the propane.", short: true },
  { as: "Nick", say: "Yes.", ifAsked: true, linger: 4000, short: true },
  { as: "Nick", say: "Do all of that on its own whenever it's going to freeze.", linger: 3000, short: true },
  { as: "Nick", say: "Yes.", ifAsked: true, linger: 5000, short: true },
];

/** A recording that taps through the screen's tabs itself asks for longer pauses where it does (?taps=1). */
const tapping = new URLSearchParams(location.search).has("taps");

const playButton = $<HTMLButtonElement>("play-demo");
let demo: { stop: boolean } | null = null;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until Alexa has finished saying her answer (or 45 seconds, whichever is first). */
async function untilQuiet() {
  if (!("speechSynthesis" in window)) return;
  const until = Date.now() + 45_000;
  while ((speechSynthesis.speaking || speechSynthesis.pending) && Date.now() < until) await pause(250);
}

/** Plays the demo from a fresh household: each beat as its speaker, with the real model, at a pace a recording can follow. */
async function playDemo(short = false) {
  if (demo) {
    demo.stop = true;
    return;
  }
  const run = { stop: false };
  demo = run;
  playButton.textContent = "Stop the demo";
  handsFreeEl.checked = false;
  recognition?.stop();
  try {
    await startOver();
    if (!passcodeForm.hidden) return; // It needs the passcode first; the card is showing.
    await pause(2500);
    for (const beat of short ? DEMO.filter((b) => b.short) : DEMO) {
      if (run.stop) break;
      // A yes is only said to a question.
      if (beat.ifAsked && !saidEl.textContent?.trim().endsWith("?")) continue;
      const speaker = state.speakers.find((p) => p.said === beat.as);
      if (speaker && speaker !== state.speaker) {
        await setSpeaker(speaker);
        await pause(1400);
      }
      while (state.busy) await pause(200);
      await ask(beat.say);
      await untilQuiet();
      if (!passcodeForm.hidden) break;
      await pause((beat.linger ?? 2500) + (tapping ? (beat.taps ?? 0) : 0));
    }
  } finally {
    demo = null;
    playButton.textContent = "Play the demo";
  }
}

playButton.addEventListener("click", () => void playDemo());
if (embedded) playButton.hidden = true;

// ---------- Start ----------

/** The add-on's screen is the kitchen board until someone asks for something else. */
async function home() {
  const today = [...uiByTool.keys()].find((n) => n === "show_today");
  if (!today) return;
  state.actor = "page";
  const result = await client.callTool({ name: today, arguments: {} });
  state.actor = "screen";
  await showScreen(today, uiByTool.get(today)!, {}, result);
}

try {
  await connect();
  await home();
  // /echo?demo=1 plays the demo on its own, for recording a take; ?demo=short plays only its headline beats.
  const take = params.get("demo");
  if ((take === "1" || take === "short") && !embedded) {
    caption("", "Starting the demo...");
    await pause(3000);
    void playDemo(take === "short");
  }
} catch (err) {
  caption("", `Couldn't reach the server: ${err instanceof Error ? err.message : err}`);
}
