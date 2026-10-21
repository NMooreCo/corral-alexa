import "./style.css";
import { visitorHousehold } from "../household.ts";

/**
 * Two simulated Echo Shows on one shared household: an Echo Show 8 in the
 * kitchen and an Echo Show 5 in the barn. Each is the simulator's own page in
 * a frame, so each is its own MCP client with its own conversation and
 * screen; the household itself lives in one Durable Object on the server. A
 * change on one device reaches the other's screen within a few seconds,
 * through the household's change counter. This page only frames the two,
 * shows that counter, and starts the household over for a fresh take.
 */

const PASSCODE_KEY = "corral-echo-passcode";
const DEVICES = [
  { id: "kitchen", place: "Kitchen", show: "8" },
  { id: "barn", place: "Barn", show: "5" },
];

// This visitor's own household unless the link names one; both Echo Shows use it (see ../household.ts).
const household = visitorHousehold();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const syncEl = $("sync");
const nameEl = $("household-name");
const startBtn = $<HTMLButtonElement>("start-over");

function householdUrl(path: string): URL {
  const url = new URL(path, location.origin);
  if (household) url.searchParams.set("household", household);
  return url;
}

$<HTMLAnchorElement>("one-device").href = householdUrl("/echo").toString();

const frames = DEVICES.map((d) => {
  const frame = $<HTMLIFrameElement>(d.id);
  const query = new URLSearchParams({ embed: "1", place: d.place, show: d.show });
  if (household) query.set("household", household);
  frame.src = `/echo?${query}`;
  return frame;
});

function tell(frame: HTMLIFrameElement, action: string, note?: string) {
  frame.contentWindow?.postMessage({ type: "corral-echo", action, note }, location.origin);
}

function passcode(): string | null {
  try {
    return localStorage.getItem(PASSCODE_KEY);
  } catch {
    return null;
  }
}

// ---------- The household's change counter, as both screens see it ----------

let last: number | undefined;

async function watch() {
  if (document.visibilityState !== "visible") return;
  try {
    const res = await fetch(householdUrl("/household"), { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const status = (await res.json()) as { name?: string; version?: number };
    if (typeof status.version !== "number") throw new Error("no version");
    if (last !== undefined && status.version !== last) {
      // Start the pulse over, so every change shows.
      syncEl.classList.remove("pulse");
      void syncEl.offsetWidth;
      syncEl.classList.add("pulse");
    }
    last = status.version;
    if (status.name) nameEl.textContent = status.name;
    syncEl.textContent = `Shared household · change ${status.version}`;
    syncEl.classList.remove("off");
  } catch {
    syncEl.textContent = "Can't reach the household";
    syncEl.classList.add("off");
  }
}
setInterval(() => void watch(), 2000);
document.addEventListener("visibilitychange", () => void watch());
void watch();

// ---------- Starting over ----------

let waitingForPasscode = false;

async function startOver() {
  waitingForPasscode = false;
  startBtn.disabled = true;
  try {
    const pass = passcode();
    const res = await fetch(householdUrl("/household/reset"), { method: "POST", headers: pass ? { "x-demo-passcode": pass } : {} });
    if (res.status === 401) {
      // The kitchen device asks for it; saving it there brings this back (below).
      waitingForPasscode = true;
      tell(frames[0]!, "passcode", pass ? "That passcode didn't work. Check it and try again." : "Enter the demo passcode to start the day over.");
      return;
    }
    if (res.status === 429) {
      // The per-visitor limit: trying again straight away won't help.
      const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      syncEl.textContent = typeof body?.error?.message === "string" ? body.error.message : "That's a lot at once. Give it a minute.";
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    for (const frame of frames) {
      tell(frame, "new-conversation");
      tell(frame, "home");
    }
    await watch();
  } catch {
    syncEl.textContent = "Couldn't start over. Try again.";
  } finally {
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", () => void startOver());
// The passcode saved on the kitchen device reaches this page as a storage event.
addEventListener("storage", (e) => {
  if (e.key === PASSCODE_KEY && e.newValue && waitingForPasscode) void startOver();
});
