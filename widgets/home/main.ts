import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RanchView } from "../../src/ranch/views.ts";
import type { TodayView } from "../../src/today.ts";
import { escape, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "../today/style.css";
import "../ranch/style.css";
import "./style.css";
import { animalsHtml } from "./animals.ts";
import { automationsClick, automationsHtml } from "./automations.ts";
import { TABS, isRanchTab, railTabs, type Tab } from "./rail.ts";
import { ranchClick, ranchHtml, startCountdowns } from "./ranch.ts";
import { todayClick, todayHtml } from "./today.ts";

/**
 * The household's home screens as one, with a rail of tabs down the side:
 * Today, the Ranch, the Animals and the Automations. show_today opens it on
 * Today and show_ranch on the Ranch (or the tab it names), and a tap moves
 * between tabs right here, through the screens' own refresh tools, without
 * asking the assistant. On a server without a ranch, Today stands alone.
 */

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
/** Whether a background read of the ranch is on its way (see fillRanch). */
let fillingRanch = false;

const screen: Screen<HomeView> = await startScreen<HomeView>({
  name: "corral-home",
  read: (r) => {
    const v = r.structuredContent as Record<string, unknown> | undefined;
    const refresh = REFRESH in r;
    if (v && Array.isArray(v.events)) {
      state.today = v as unknown as TodayView;
      if (!refresh) state.tab = "today";
      // Today says whether there's a ranch; until the ranch has answered, each of Today's answers asks it again.
      if (state.today.hasRanch) fillRanch();
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

/** The rail; the ranch's tabs whenever this server has a ranch, before the ranch itself has answered. */
function rail(): string {
  const outside = state.ranch?.animals.outside.length ?? 0;
  return `<nav class="rail" aria-label="Screens">${railTabs(state)
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

/**
 * Reads the ranch in the background, one ask at a time, so its tabs open straight onto it and the
 * Animals tab can show how many are outside the fence. The tabs are on the rail already; one opened
 * before this answers shows the ranch loading, then the ranch.
 */
function fillRanch() {
  if (state.ranch || fillingRanch) return;
  fillingRanch = true;
  screen.app
    .callServerTool({ name: "refresh_ranch", arguments: {} })
    .then((r) => {
      const v = r.structuredContent as Record<string, unknown> | undefined;
      if (r.isError || !v?.map || state.ranch) return;
      state.ranch = v as unknown as RanchView;
      render();
    })
    .catch(() => {})
    .finally(() => (fillingRanch = false));
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
