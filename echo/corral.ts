import type { Extension, ScreenInfo, Simulator, Suggestion, ToolInfo } from "alexa-plus-simulator/ui";

/**
 * Corral's extension for the open Alexa+ simulator: what this demo adds to
 * the simulated Echo. Who's speaking (Alexa+ knows each person's voice), the
 * demo passcode, Amazon Polly's voice, the household's own clock (evening and
 * the next morning), starting the household over, the alerts a device says on
 * its own, the scripted demo, and the two-device page's messages. Everything
 * else (the MCP client, the screens, listening and speaking, the traffic, the
 * readiness check) is the simulator's.
 */

export interface CorralOptions {
  /** The sample household this page works in (see household.ts). */
  household: string;
  /** Where this device is, on the two-device page ("Barn"); "" for the single page. */
  place: string;
  /** One of two devices on the two-device page. */
  embedded: boolean;
  /** The server wants the demo passcode before the model or the voice answer. */
  passcodeRequired: boolean;
  /** Amazon Polly says the answers. */
  polly: boolean;
}

/** Someone the picker offers: a person in the household, or a voice Alexa doesn't know. */
interface Speaker {
  /** What the header says: a person's short name, or "guest". */
  said: string;
  name: string;
  role: string;
}
const GUEST: Speaker = { said: "guest", name: "Someone Alexa doesn't recognize", role: "Guest" };
/** Who Alexa recognized, on every MCP request. Only the sample household reads it (sample mode has no sign-in). */
const SPEAKER_HEADER = "x-demo-person";
const PASSCODE_KEY = "corral-echo-passcode";

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
/** What to try on a display somewhere else on the place. */
const PLACE_SUGGESTIONS: Record<string, string[]> = {
  barn: ["Jon fed the horses.", "We used two bales of hay.", "What chores are left today?"],
};

/**
 * One beat of the demo: who says it, what they say, whether it's only said
 * when the assistant has just asked something (a yes to its question), and how
 * long to let the screen sit before the next beat, so a viewer can read it.
 */
interface DemoBeat {
  as: string;
  say: string;
  /** Instead of a line: say what the household just heard about on its own (an alert), waiting for one if it hasn't come yet. */
  alert?: boolean;
  ifAsked?: boolean;
  linger?: number;
  /** Longer still when a recording taps through the screen's tabs here (?taps=1). */
  taps?: number;
  /** Part of the short demo too (?demo=short), the headline beats only. */
  short?: boolean;
  /** The next morning: the household moves on to it (keeping the night before) before this beat. */
  morning?: boolean;
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
  // The barn speaks up: Hunter slips out a couple of minutes into the evening.
  { as: "", say: "", alert: true, linger: 2500, short: true },
  { as: "Nick", say: "It's going down to 12 tonight. Get the place ready.", linger: 3000, short: true },
  { as: "Nick", say: "Yes, do all of that.", ifAsked: true, linger: 4000, short: true },
  { as: "Nick", say: "Do all of that on its own whenever it's going to freeze.", linger: 3000, short: true },
  { as: "Nick", say: "Yes.", ifAsked: true, linger: 5000, short: true },
  { as: "Holly", say: "I brought Hunter and Pepper in.", linger: 3000, short: true },
  // The next morning: the briefing's cards say what happened overnight, and the day ahead.
  { as: "Nick", say: "Good morning.", morning: true, linger: 6000, taps: 12000, short: true },
];

/** Which part of the demo to play: all of it, the evening only, or the morning after only (?part=evening or morning). */
export type DemoPart = "all" | "evening" | "morning";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** The screen a tool names, in the MCP Apps form or the older flat key. */
function screenUri(t: ToolInfo): string | undefined {
  const meta = t._meta as { ui?: { resourceUri?: unknown; visibility?: unknown }; "ui/resourceUri"?: unknown } | undefined;
  const uri = meta?.ui?.resourceUri ?? meta?.["ui/resourceUri"];
  return typeof uri === "string" ? uri : undefined;
}

function forModel(t: ToolInfo): boolean {
  const visibility = (t._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes("model");
}

/** The Corral extension, and what the page's own script needs from it (the scripted demo). */
export function corral(o: CorralOptions): { extension: Extension; playDemo: (short: boolean, part: DemoPart, tapping: boolean) => Promise<void> } {
  let sim!: Simulator;

  /** One of this server's household routes, for the household this page is on. */
  const householdUrl = (path: string) => {
    const url = new URL(path, location.origin);
    url.searchParams.set("household", o.household);
    return url;
  };

  // ---------- The demo passcode ----------

  // For a browser that won't store it: kept for this visit.
  let visitPasscode: string | null = null;
  // The question that was waiting on the passcode, asked again once it's in.
  let waitingQuestion: string | null = null;
  // Starting the household over was waiting on the passcode.
  let waitingStartOver = false;

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

  const gated = (): Record<string, string> => {
    const p = passcode();
    return p ? { "x-demo-passcode": p } : {};
  };

  const passcodeForm = el("form", "passcode");
  passcodeForm.hidden = true;
  const passcodeCard = el("div", "passcode-card");
  const passcodeLabel = el("label", "", "Demo passcode");
  passcodeLabel.htmlFor = "passcode";
  const passcodeRow = el("div", "passcode-row");
  const passcodeInput = el("input");
  Object.assign(passcodeInput, { id: "passcode", type: "password", autocomplete: "off", spellcheck: false });
  passcodeInput.setAttribute("autocapitalize", "off");
  const passcodeSave = el("button", "", "Save");
  passcodeSave.type = "submit";
  const passcodeNote = el("p", "passcode-note");
  passcodeRow.append(passcodeInput, passcodeSave);
  passcodeCard.append(passcodeLabel, passcodeRow, passcodeNote);
  passcodeForm.append(passcodeCard);

  function askForPasscode(note: string) {
    passcodeNote.textContent = note;
    passcodeForm.hidden = false;
    passcodeForm.scrollIntoView({ block: "nearest" });
    passcodeInput.focus();
  }

  passcodeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = passcodeInput.value.trim();
    if (!value) return passcodeInput.focus();
    rememberPasscode(value);
    passcodeInput.value = "";
    passcodeForm.hidden = true;
    const question = waitingQuestion;
    waitingQuestion = null;
    if (question) void sim.ask(question);
    if (waitingStartOver) void startOver();
  });
  // Saved on the other device in the two-device view: this one has it too.
  addEventListener("storage", (e) => {
    if (e.key === PASSCODE_KEY && e.newValue) passcodeForm.hidden = true;
  });

  // ---------- Who's speaking ----------

  let speakers: Speaker[] = [];
  let speaker: Speaker | null = null;
  let greetTimer: ReturnType<typeof setTimeout> | undefined;

  const speakersBox = el("fieldset", "speakers");
  speakersBox.hidden = true;
  const speakersHint = el("p", "hint", "Alexa+ knows each person's voice, and the family's rules follow them: a kid's plans wait for a parent, private events stay private.");
  const speakerList = el("div", "speaker-list");
  speakersBox.append(el("legend", "", "Who's speaking"), speakersHint, speakerList);

  const chip = el("div", "speaker-chip");
  chip.hidden = true;
  chip.setAttribute("aria-live", "polite");
  const chipAvatar = el("span", "avatar");
  const chipText = el("span");
  chip.append(chipAvatar, chipText);

  /** The household's people from its own people tool, plus a guest; the first person speaks until someone picks. */
  async function loadSpeakers() {
    try {
      const res = await sim.callTool("people", {});
      const text = (res.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "[]";
      const people = JSON.parse(text) as { name: string; shortName: string; roles: string[] }[];
      speakers = [...people.map((p) => ({ said: p.shortName, name: p.name, role: p.roles[0] ?? "" })), GUEST];
    } catch {
      speakers = [];
    }
    if (!speakers.length) return;
    speakerList.replaceChildren(
      ...speakers.map((s, i) => {
        const label = el("label", "speaker");
        label.dataset.tone = String(i % 6);
        const input = el("input");
        input.type = "radio";
        input.name = "speaker";
        input.value = s.said;
        input.addEventListener("change", () => input.checked && void setSpeaker(s));
        const avatar = el("span", "avatar", s === GUEST ? "?" : (s.said[0] ?? "?").toUpperCase());
        avatar.setAttribute("aria-hidden", "true");
        label.append(input, avatar, el("span", "speaker-name", s === GUEST ? s.name : s.said), el("span", "speaker-role", s.role));
        return label;
      }),
    );
    speakersBox.hidden = false;
    // The household's first member, who set up the Echo: a parent in the sample, so every suggestion works from the start.
    await setSpeaker(speakers[0]!, { quiet: true });
  }

  /** Puts `s` on every MCP call from here on, says so on the device, and shows the current screen as they'd see it. */
  async function setSpeaker(s: Speaker, opts: { quiet?: boolean } = {}) {
    const changed = speaker?.said !== s.said;
    speaker = s;
    for (const input of speakerList.querySelectorAll<HTMLInputElement>("input[name=speaker]")) input.checked = input.value === s.said;
    chipAvatar.textContent = s === GUEST ? "?" : (s.said[0] ?? "?").toUpperCase();
    chip.dataset.tone = String(Math.max(0, speakers.indexOf(s)) % 6);
    chip.hidden = false;
    // Alexa greets someone it knows by name for a moment, then keeps just the name in the corner.
    const settled = s === GUEST ? "Guest" : s.said;
    chipText.textContent = opts.quiet ? settled : s === GUEST ? "I don't know this voice" : `Hi, ${s.said}`;
    chip.classList.toggle("greeting", !opts.quiet);
    clearTimeout(greetTimer);
    greetTimer = setTimeout(() => {
      chipText.textContent = settled;
      chip.classList.remove("greeting");
    }, 2600);
    if (!changed) return;
    if (!opts.quiet) sim.log("page", `Now speaking: ${s === GUEST ? "a guest (a voice Alexa doesn't recognize)" : `${s.name}, ${s.role}`}`);
    await sim.refreshScreen();
  }

  // ---------- The household's clock ----------

  /** How far the household's clock is from this device's: a household can run at another hour (evening, for the demo). */
  let skewMs = 0;
  let evening = false;
  let morning = false;
  const eveningBtn = el("button", "", "Make it evening");
  eveningBtn.type = "button";
  eveningBtn.title = "Runs this household at 8:15 PM, when the sample's dogs wander off, and starts it over";
  const morningBtn = el("button", "", "Next morning");
  morningBtn.type = "button";
  morningBtn.title = "Moves this household on to 6:45 the next morning, keeping everything from the night before";

  /** Reads the household's clock from /household, and says on the button what it's set to. */
  async function readClock() {
    const res = await fetch(householdUrl("/household"), { cache: "no-store" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { clock?: { now?: string; evening?: boolean; morning?: boolean } } | null;
    if (body?.clock?.now && !Number.isNaN(Date.parse(body.clock.now))) skewMs = Date.parse(body.clock.now) - Date.now();
    evening = Boolean(body?.clock?.evening);
    morning = Boolean(body?.clock?.morning);
    eveningBtn.textContent = evening ? "Back to the real time" : "Make it evening";
  }

  /** The home screen: today, unless the device has no screen. */
  async function home() {
    if (sim.device.surface === "none") return;
    await sim.show("show_today").catch(() => {});
  }

  /**
   * Sets the household's clock: evening or back to the real time start the
   * household over at that hour; the next morning keeps the night before. True
   * when it worked.
   */
  async function setClock(mode: "evening" | "morning" | "now"): Promise<boolean> {
    const res = await fetch(householdUrl("/household/clock"), {
      method: "POST",
      headers: { "content-type": "application/json", ...gated() },
      body: JSON.stringify({ mode }),
    }).catch(() => null);
    if (res?.status === 401) {
      const tried = passcode() !== null;
      if (tried) rememberPasscode(null);
      askForPasscode(tried ? "That passcode didn't work. Check it and try again." : "Enter the demo passcode to set the household's clock.");
      return false;
    }
    if (!res?.ok) {
      sim.caption("", "Couldn't set the household's clock. Try again.");
      return false;
    }
    await readClock();
    sim.newConversation();
    await loadSpeakers();
    sim.log("page", mode === "evening" ? "Set the household's clock to evening" : mode === "morning" ? "Moved the household on to the next morning" : "Set the household's clock back to the real time");
    await home();
    return true;
  }
  eveningBtn.addEventListener("click", () => void setClock(evening ? "now" : "evening"));
  morningBtn.addEventListener("click", () => void setClock("morning"));

  // ---------- Starting the household over ----------

  const startOverBtn = el("button", "", "Start the household over");
  startOverBtn.type = "button";

  /** Starts the household over for every device on it (a fresh demo take), then this one's conversation and screen. */
  async function startOver() {
    waitingStartOver = false;
    const res = await fetch(householdUrl("/household/reset"), { method: "POST", headers: gated() }).catch(() => null);
    if (res?.status === 401) {
      const tried = passcode() !== null;
      if (tried) rememberPasscode(null);
      waitingStartOver = true;
      return askForPasscode(tried ? "That passcode didn't work. Check it and try again." : "Enter the demo passcode to start the household over.");
    }
    if (!res?.ok) return sim.caption("", "Couldn't start the household over. Try again.");
    sim.newConversation();
    // The household starts over from its seed, which may name different people than it did.
    await loadSpeakers();
    sim.log("page", "Started the household over");
    await home();
  }
  startOverBtn.addEventListener("click", () => void startOver());

  // ---------- Speaking up ----------

  /**
   * A device that speaks up on its own: an animal leaving the fence, an
   * automation that ran. Stateless MCP can't push, so the page asks the
   * screen-only `alerts` tool every few seconds, as screens ask for the
   * household's change counter. On the two-device page the barn speaks up;
   * the kitchen leaves it to the barn. While the demo plays, alerts wait for
   * its alert beat, so they never talk over a conversation.
   */
  const ALERT_EVERY_MS = 3_000;
  const speaksUp = !o.embedded || o.place.toLowerCase() === "barn";
  const heldAlerts: string[] = [];
  let alertCursor: string | undefined;
  let watching = false;

  const banner = el("div", "alert");
  banner.setAttribute("role", "status");
  banner.hidden = true;
  const bannerIcon = el("span", "alert-icon");
  bannerIcon.setAttribute("aria-hidden", "true");
  const bannerWords = el("div");
  const bannerText = el("p", "alert-text");
  bannerWords.append(el("p", "alert-kicker", "Heads up"), bannerText);
  banner.append(bannerIcon, bannerWords);

  async function watchAlerts() {
    if (!speaksUp || !sim.tools().some((t) => t.name === "alerts")) return;
    for (;;) {
      await pause(ALERT_EVERY_MS);
      if (sim.busy) continue;
      try {
        const result = await sim.callTool("alerts", alertCursor ? { since: alertCursor } : {}, { quiet: true });
        const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
        if (!result.isError && text) {
          const answer = JSON.parse(text) as { alerts: { text: string }[]; cursor: string };
          alertCursor = answer.cursor;
          heldAlerts.push(...answer.alerts.map((a) => a.text));
        }
      } catch {
        // The next ask tries again.
      }
      if (heldAlerts.length && !demo && !sim.busy && sim.light === "idle") await speakUp(heldAlerts.splice(0).join(" "));
    }
  }

  /** The next alert, waiting up to `ms` for one. */
  async function nextAlert(ms: number): Promise<string | null> {
    const until = Date.now() + ms;
    while (!heldAlerts.length && Date.now() < until) await pause(250);
    return heldAlerts.length ? heldAlerts.splice(0).join(" ") : null;
  }

  /** A soft two-note chime, before the device says something on its own. */
  function chime() {
    try {
      const audio = new AudioContext();
      const start = audio.currentTime;
      [880, 1318.5].forEach((hz, i) => {
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        const at = start + i * 0.18;
        tone.frequency.value = hz;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.16, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
        tone.connect(gain).connect(audio.destination);
        tone.start(at);
        tone.stop(at + 0.55);
      });
      setTimeout(() => void audio.close(), 1200);
    } catch {
      // No sound here; the banner and the voice still say it.
    }
  }

  /** Says an alert out loud with a banner over the screen, and keeps it for the assistant's next turn. */
  async function speakUp(text: string) {
    chime();
    sim.setLight("notify");
    bannerText.textContent = text;
    banner.hidden = false;
    sim.log("page", `Said on its own: ${text}`);
    sim.note(`(You said on your own since they last spoke: ${text})`);
    await pause(700);
    // Measures said the way people say them.
    await sim.say(`Heads up: ${text.replace(/\b(\d+) ft\b/g, "$1 feet").replace(/\b(\d+) m\b/g, "$1 meters")}`, { light: "notify" });
    await pause(1800);
    banner.hidden = true;
  }

  // ---------- The demo, played for a recording ----------

  const playButton = el("button", "", "Play the demo");
  playButton.type = "button";
  let demo: { stop: boolean } | null = null;

  /** Plays the demo from a fresh household: each beat as its speaker, with the real model, at a pace a recording can follow. */
  async function playDemo(short = false, part: DemoPart = "all", tapping = false) {
    if (demo) {
      demo.stop = true;
      return;
    }
    const run = { stop: false };
    demo = run;
    playButton.textContent = "Stop the demo";
    // Hands-free would hear the demo's own voice.
    const handsFree = sim.root.querySelector<HTMLInputElement>("#handsfree");
    if (handsFree?.checked) {
      handsFree.checked = false;
      handsFree.dispatchEvent(new Event("change"));
    }
    try {
      // The demo is an evening at the ranch whatever the time, so the household's clock is set to evening (which starts it over).
      // The morning part on its own goes on from wherever the household is.
      if (part !== "morning") {
        if (evening && !morning) await startOver();
        else if (!(await setClock("evening"))) return;
        if (!passcodeForm.hidden) return; // It needs the passcode first; the card is showing.
        await pause(2500);
      }
      const beats = (short ? DEMO.filter((b) => b.short) : DEMO).filter((b) => (part === "evening" ? !b.morning : part === "morning" ? b.morning : true));
      for (const beat of beats) {
        if (run.stop) break;
        if (beat.alert) {
          const text = await nextAlert(60_000);
          if (text) await speakUp(text);
          await pause(beat.linger ?? 2500);
          continue;
        }
        if (beat.morning && !morning) {
          if (!(await setClock("morning"))) break;
          await pause(2500);
        }
        // A yes is only said to a question, wherever in her answer she asked it.
        if (beat.ifAsked && !sim.lastSaid.includes("?")) continue;
        const who = speakers.find((p) => p.said === beat.as);
        if (who && who !== speaker) {
          await setSpeaker(who);
          await pause(1400);
        }
        while (sim.busy) await pause(200);
        await sim.ask(beat.say);
        await sim.untilQuiet();
        if (!passcodeForm.hidden) break;
        await pause((beat.linger ?? 2500) + (tapping ? (beat.taps ?? 0) : 0));
      }
    } finally {
      demo = null;
      // What came in while the demo held it isn't news anymore.
      heldAlerts.length = 0;
      playButton.textContent = "Play the demo";
    }
  }
  playButton.addEventListener("click", () => void playDemo());

  // ---------- The two-device page ----------

  // In the two-device view, the page around both devices starts their conversations over and shows the passcode box.
  addEventListener("message", (e) => {
    if (e.source !== parent || e.origin !== location.origin) return;
    const msg = e.data as { type?: string; action?: string; note?: string } | null;
    if (msg?.type !== "corral-echo") return;
    if (msg.action === "new-conversation") {
      sim.newConversation();
      void loadSpeakers();
      void readClock();
    }
    if (msg.action === "home") void home();
    if (msg.action === "passcode") askForPasscode(msg.note ?? "Enter the demo passcode.");
  });

  const extension: Extension = (s) => {
    sim = s;
    sim.ui.device.append(passcodeForm);
    sim.ui.panel.append(speakersBox);
    sim.ui.screen.append(chip, banner);
    const twoDevices = el("a", "", "Two devices");
    twoDevices.href = `/echo?devices=2&household=${encodeURIComponent(o.household)}`;
    sim.ui.footer.append(startOverBtn, playButton, eveningBtn, morningBtn, twoDevices);
    if (o.embedded) playButton.hidden = true;
    if (!o.embedded) {
      const tour = el(
        "p",
        "hint tour",
        'In a minute: press Make it evening, ask "What\'s going on tonight?", tap Animals on the screen and wait for the Echo to speak up. Then try the suggestions marked Eli and Nick. Or press Play the demo.',
      );
      sim.ui.header.append(tour);
    }
    const tries: Suggestion[] = (PLACE_SUGGESTIONS[o.place.toLowerCase()] ?? SUGGESTIONS).map((s) =>
      typeof s === "string"
        ? s
        : {
            text: s.text,
            label: s.as,
            // Said by someone in particular: switch to them first, as if they'd walked up and spoken.
            run: async () => {
              if (sim.busy) return;
              const who = speakers.find((p) => p.said === s.as);
              if (who && who !== speaker) await setSpeaker(who);
              void sim.ask(s.text);
            },
          },
    );
    sim.ui.suggestions(tries);
    if (o.passcodeRequired && !passcode()) askForPasscode("This demo needs a passcode before it can talk.");

    return {
      headers: (kind) => (kind === "model" ? gated() : speaker ? { [SPEAKER_HEADER]: encodeURIComponent(speaker.said) } : {}),
      connected: async () => {
        await loadSpeakers();
        await readClock();
        // Once, however many times the simulator reconnects.
        if (!watching) {
          watching = true;
          void watchAlerts();
        }
      },
      // Who said it, as Alexa+ would know from the voice: each turn says, since the speaker can change mid-conversation.
      beforeTurn: () =>
        speaker ? [speaker === GUEST ? "(Alexa doesn't recognize this voice: a guest.)" : `(Alexa recognized the voice: ${speaker.name}${speaker.role ? `, ${speaker.role}` : ""}.)`] : [],
      modelContext: () => (o.place ? { place: o.place } : {}),
      modelFailed: (failure, question) => {
        if (failure.code !== "passcode") return false;
        const tried = passcode() !== null;
        if (tried) rememberPasscode(null);
        const note = tried ? "That passcode didn't work. Check it and try again." : "Enter the demo passcode to start.";
        askForPasscode(note);
        waitingQuestion = question;
        sim.caption(question, note);
        return true;
      },
      ...(o.polly ? { speak: pollySpeak } : {}),
      now: () => new Date(Date.now() + skewMs),
      timeZone: () => /time zone is ([A-Za-z_]+\/[A-Za-z_/]+)/.exec(sim.instructions)?.[1],
      // The screen's note ends with a plain sentence after its YAML header.
      screenNote: (text) => text.split("\n---\n").pop()?.trim() ?? text,
      refresh: (screen: ScreenInfo) => {
        const tools = sim.tools();
        if (tools.find((t) => t.name === screen.tool)?.annotations?.readOnlyHint) return undefined;
        // A change that opened this screen (switching a device, an order) isn't made again for the new speaker:
        // the screen is shown again by a tool that only reads, on the tab it opened on.
        const reader = tools.find((t) => t.annotations?.readOnlyHint && forModel(t) && screenUri(t) === screen.uri);
        if (!reader) return null;
        const takesView = Boolean((reader.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.view);
        const tab = screen.result.structuredContent?.tab;
        return { tool: reader.name, arguments: takesView && typeof tab === "string" ? { view: tab } : {} };
      },
    };
  };

  /** Amazon Polly says it, through this server's /echo/voice; the simulator falls back to the browser's voice when it can't. */
  async function pollySpeak(text: string, started: () => void, signal: AbortSignal): Promise<void> {
    const res = await fetch("/echo/voice", {
      method: "POST",
      headers: { "content-type": "application/json", ...gated() },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) throw new Error(`The voice answered ${res.status}.`);
    const url = URL.createObjectURL(await res.blob());
    try {
      const audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            audio.pause();
            resolve();
          },
          { once: true },
        );
        audio.onplay = started;
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("The voice didn't play."));
        audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { extension, playDemo };
}
