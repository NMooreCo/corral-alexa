import type { RanchTab, RanchView } from "../../src/ranch/views.ts";
import type { TodayView } from "../../src/today.ts";

/**
 * The home screen's rail of tabs, and when it offers the ranch's. It needs no
 * host, so which tabs show can be tested on its own.
 */

export type Tab = "today" | RanchTab;

export const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: "today", label: "Today", icon: `<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>` },
  { tab: "ranch", label: "Ranch", icon: `<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>` },
  { tab: "animals", label: "Animals", icon: `<circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M8 17c0-3 2-5 4-5s4 2 4 5c0 2-2 2-4 2s-4 0-4-2Z"/>` },
  { tab: "automations", label: "Automations", icon: `<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>` },
];

export const isRanchTab = (t: Tab): t is RanchTab => t !== "today";

/**
 * The rail's tabs: Today always, and the ranch's whenever this server has a
 * ranch. Today's own answer says so, as does a ranch view or opening on one of
 * the ranch's tabs, so they're there from the first look and never wait on the
 * ranch's own read, which a slow greenhouse controller or forecast can hold up
 * for seconds; a tab opened before that read answers says it's loading. A
 * household without a ranch (one linked to a real Corral, say) has Today alone.
 */
export function railTabs(view: { tab: Tab; today: Pick<TodayView, "hasRanch"> | null; ranch: RanchView | null }): typeof TABS {
  const ranch = view.ranch !== null || isRanchTab(view.tab) || view.today?.hasRanch === true;
  return TABS.filter((t) => t.tab === "today" || ranch);
}
