import type { CallToolResult } from "@modelcontextprotocol/server";
import type { BriefingCard, BriefingView } from "../../src/ranch/views.ts";
import { escape, sizeButton, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/**
 * The morning briefing: one card at a time (today, weather, chores,
 * supplies, animals, the greenhouse, devices). Swipe on a touch screen, or
 * use the buttons and arrow keys otherwise. The assistant is told which card
 * is showing, so "what about that one?" has an answer.
 */

const root = document.getElementById("app")!;
let index = 0;
let drawn = "";
let toldTimer: ReturnType<typeof setTimeout> | undefined;
let lastTold = "";

const screen: Screen<BriefingView> = await startScreen<BriefingView>({
  name: "corral-briefing",
  read: (r) => {
    const v = r.structuredContent as BriefingView | undefined;
    return v && Array.isArray(v.cards) ? v : null;
  },
  render,
  refresh: () => screen.app.callServerTool({ name: "show_briefing", arguments: {} }) as Promise<CallToolResult>,
  refreshMs: 5 * 60_000,
});

/** Buttons only where there's no touch to swipe with (or there's a pointer that hovers). */
function wantsButtons(): boolean {
  const caps = screen.context()?.deviceCapabilities;
  return !caps?.touch || Boolean(caps.hover);
}

function card(c: BriefingCard, i: number, count: number): string {
  return `<article class="card${c.warn ? " warn" : ""}" data-index="${i}" aria-roledescription="card" aria-label="${escape(`${c.title}, ${i + 1} of ${count}`)}">
    <p class="kicker">${escape(c.title)}${c.warn ? ` <span class="badge warn">Look</span>` : ""}</p>
    <h2 class="headline">${escape(c.headline)}</h2>
    ${c.lines.length ? `<ul class="lines">${c.lines.map((l) => `<li class="${l.warn ? "warn" : ""}">${escape(l.text)}</li>`).join("")}</ul>` : ""}
  </article>`;
}

function render(view: BriefingView) {
  // The shared clock redraws every few seconds; redrawing an unchanged deck would jump the swipe.
  const key = JSON.stringify([view, screen.context()?.theme, screen.context()?.displayMode, wantsButtons()]);
  if (key === drawn) return;
  drawn = key;
  index = Math.min(index, Math.max(0, view.cards.length - 1));
  const buttons = wantsButtons();
  root.innerHTML = `
    <header>
      <div>
        <h1>${escape(view.greeting)}</h1>
        <p class="household">${escape([view.date, view.household].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="header-end">${sizeButton(screen)}</div>
    </header>
    <div class="deck" role="region" aria-roledescription="carousel" aria-label="Briefing" tabindex="0">
      <div class="track">${view.cards.map((c, i) => card(c, i, view.cards.length)).join("")}</div>
    </div>
    <nav class="pager" aria-label="Cards">
      ${buttons ? `<button type="button" class="step" data-step="-1" aria-label="Previous card">Back</button>` : ""}
      <span class="dots">${view.cards.map((c, i) => `<button type="button" class="dot" data-go="${i}" aria-label="${escape(c.title)}"${i === index ? ` aria-current="true"` : ""}></button>`).join("")}</span>
      ${buttons ? `<button type="button" class="step" data-step="1" aria-label="Next card">Next</button>` : ""}
    </nav>`;
  // The card it opens on is the one the assistant just talked about; only a swipe is news.
  if (!lastTold) lastTold = view.cards[index]?.id ?? "";
  const track = root.querySelector<HTMLElement>(".track")!;
  track.scrollLeft = cardLeft(track, index);
  track.addEventListener("scroll", () => onScroll(track), { passive: true });
  mark();
}

function cards(track: HTMLElement): HTMLElement[] {
  return [...track.querySelectorAll<HTMLElement>(".card")];
}

/** Where the track scrolls to center card i. */
function cardLeft(track: HTMLElement, i: number): number {
  const c = cards(track)[i];
  if (!c) return 0;
  const t = track.getBoundingClientRect();
  const r = c.getBoundingClientRect();
  return track.scrollLeft + (r.left - t.left) - (t.width - r.width) / 2;
}

let scrollTimer: ReturnType<typeof setTimeout> | undefined;
function onScroll(track: HTMLElement) {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const t = track.getBoundingClientRect();
    const middle = t.left + t.width / 2;
    const off = (c: HTMLElement) => {
      const r = c.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - middle);
    };
    const all = cards(track);
    let best = 0;
    all.forEach((c, i) => {
      if (off(c) < off(all[best]!)) best = i;
    });
    if (best !== index) {
      index = best;
      mark();
    }
  }, 90);
}

function go(i: number) {
  const view = screen.view();
  const track = root.querySelector<HTMLElement>(".track");
  if (!view || !track) return;
  index = Math.max(0, Math.min(view.cards.length - 1, i));
  track.scrollTo({ left: cardLeft(track, index), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  mark();
}

/** Marks the showing card and, once it settles, tells the assistant. */
function mark() {
  root.querySelectorAll(".dot").forEach((d, i) => (i === index ? d.setAttribute("aria-current", "true") : d.removeAttribute("aria-current")));
  root.querySelectorAll(".card").forEach((c, i) => c.classList.toggle("current", i === index));
  const c = screen.view()?.cards[index];
  if (!c) return;
  clearTimeout(toldTimer);
  toldTimer = setTimeout(() => {
    if (lastTold === c.id) return;
    lastTold = c.id;
    screen.tell("showing card", { card: c.title, position: `${index + 1} of ${screen.view()?.cards.length ?? 0}` }, `On the screen: the briefing's ${c.title} card. ${c.headline.replace(/[^.!?]$/, "$&.")}`);
  }, 900);
}

root.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const step = t.closest<HTMLElement>("[data-step]");
  if (step) return go(index + Number(step.dataset.step));
  const dot = t.closest<HTMLElement>("[data-go]");
  if (dot) go(Number(dot.dataset.go));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") go(index + 1);
  if (e.key === "ArrowLeft") go(index - 1);
});
