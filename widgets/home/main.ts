import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RanchTab, RanchView } from "../../src/ranch/views.ts";
import type { TodayView } from "../../src/today.ts";
import { escape, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "../today/style.css";
import "../ranch/style.css";
import "./style.css";
import { animalsHtml } from "./animals.ts";
import { automationsClick, automationsHtml } from "./automations.ts";
import { ranchClick, ranchHtml, startCountdowns } from "./ranch.ts";
import { todayClick, todayHtml } from "./today.ts";

/**
 * The household's home screens as one, with a rail of tabs down the side:
 * Today, the Ranch, the Animals and the Automations. show_today opens it on
 * Today and show_ranch on the Ranch (or the tab it names), and a tap moves
 * between tabs right here, through the screens' own refresh tools, without
 * asking the assistant. On a server without a ranch, Today stands alone.
 */

type Tab = "today" | RanchTab;

interface HomeView {
  tab: Tab;
  today: TodayView | null;
  ranch: RanchView | null;
}

/** What each tab's code needs from the screen around it. */
export interface Home {
  screen: Screen<HomeView>;
  zone(): string | undefined;
  today(): TodayView | null;
  ranch(): RanchView | null;
}

const root = document.getElementById("app")!;
const state: HomeView = { tab: (root.dataset.start as Tab | undefined) ?? "today", today: null, ranch: null };
/** A refresh's answer keeps the tab; a tool's answer (the assistant showing a screen) may move it. */
const REFRESH = Symbol("refresh");

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: "today", label: "Today", icon: `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>` },
  { tab: "ranch", label: "Ranch", icon: `<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>` },
  { tab: "animals", label: "Animals", icon: `<circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M8 17c0-3 2-5 4-5s4 2 4 5c0 2-2 2-4 2s-4 0-4-2Z"/>` },
  { tab: "automations", label: "Automations", icon: `<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>` },
];

const isRanchTab = (t: Tab): t is RanchTab => t !== "today";

const screen: Screen<HomeView> = await startScreen<HomeView>({
  name: "corral-home",
  read: (r) => {
    const v = r.structuredContent as Record<string, unknown> | undefined;
    const refresh = REFRESH in r;
    if (v && Array.isArray(v.events)) {
      state.today = v as unknown as TodayView;
      if (!refresh) state.tab = "today";
    } else if (v && v.map && Array.isArray(v.places)) {
      const ranch = v as unknown as RanchView;
      state.ranch = ranch;
      if (!refresh) state.tab = ranch.tab ?? (isRanchTab(state.tab) ? state.tab : "ranch");
    } else return null;
    return { ...state };
  },
  render,
  // The screen's own refresh, through a tool only it can call (the assistant never sees it), for whichever tab is up.
  refresh: async () => {
    const res = (await screen.app.callServerTool({ name: isRanchTab(state.tab) ? "refresh_ranch" : "refresh_today", arguments: {} })) as CallToolResult;
    return Object.assign(res, { [REFRESH]: true });
  },
  refreshMs: 20_000,
});

const home: Home = {
  screen,
  zone: () => screen.context()?.timeZone,
  today: () => state.today,
  ranch: () => state.ranch,
};

/** The rail; the ranch's tabs only once this server has shown it has a ranch. */
function rail(): string {
  const hasRanch = state.ranch !== null || isRanchTab(state.tab);
  const outside = state.ranch?.animals.outside.length ?? 0;
  return `<nav class="rail" aria-label="Screens">${TABS.filter((t) => t.tab === "today" || hasRanch)
    .map(
      (t) => `<button type="button" data-tab="${t.tab}" ${state.tab === t.tab ? `aria-current="page"` : ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg><span>${escape(t.label)}</span>
        ${t.tab === "animals" && outside ? `<span class="dot" aria-label="${outside} outside the fence">${outside}</span>` : ""}
      </button>`,
    )
    .join("")}</nav>`;
}

function pane(): string {
  if (state.tab === "today") return state.today ? todayHtml(state.today, home) : `<p class="empty">Loading today...</p>`;
  if (!state.ranch) return `<p class="empty">Loading the ranch...</p>`;
  if (state.tab === "animals") return animalsHtml(state.ranch, home);
  if (state.tab === "automations") return automationsHtml(state.ranch, home);
  return ranchHtml(state.ranch, home);
}

function render() {
  root.innerHTML = `<div class="home">${rail()}<div class="pane" data-tab="${state.tab}">${pane()}</div></div>`;
}

async function open(tab: Tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  render();
  const label = TABS.find((t) => t.tab === tab)!.label;
  // Tell the assistant, so "what about this one?" is about what's on the screen.
  screen.tell("opened tab", { tab: label }, `On the screen: the ${label} tab.`);
  await screen.refreshNow();
}

startCountdowns(root, home);

// Opened on Today, ask once whether this server has a ranch (and how the animals are), so the rail can offer its tabs.
if (state.tab === "today" && !state.ranch) {
  screen.app
    .callServerTool({ name: "refresh_ranch", arguments: {} })
    .then((r) => {
      const v = r.structuredContent as Record<string, unknown> | undefined;
      if (r.isError || !v?.map || state.ranch) return;
      state.ranch = v as unknown as RanchView;
      render();
    })
    .catch(() => {});
}

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const tab = target.closest<HTMLButtonElement>("button[data-tab]")?.dataset.tab as Tab | undefined;
  if (tab) return void open(tab);
  if (state.tab === "today") todayClick(target, home);
  else if (state.tab === "ranch") ranchClick(target, home);
  else if (state.tab === "automations") automationsClick(target, home);
});
