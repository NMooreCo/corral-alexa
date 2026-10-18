import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CorralSupply } from "../../src/household.ts";
import type { SuppliesView } from "../../src/screens.ts";
import { escape, sizeButton, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/** What's left of each tracked supply and how long it lasts; a low one goes on a list in one tap. */

// A month of supply fills the bar; anything past that is plenty.
const FULL_DAYS = 30;
const root = document.getElementById("app")!;
const pending = new Set<string>();

const screen: Screen<SuppliesView> = await startScreen<SuppliesView>({
  name: "corral-supplies",
  read: (r) => {
    const v = r.structuredContent as SuppliesView | undefined;
    return v && Array.isArray(v.supplies) ? v : null;
  },
  render,
  refresh: () => screen.app.callServerTool({ name: "show_supplies", arguments: {} }) as Promise<CallToolResult>,
  refreshMs: 5 * 60_000,
});

function lasts(s: CorralSupply): string {
  if (s.needsFreshCount) return "Needs a fresh count";
  if (s.daysLeft === undefined) return "";
  if (s.daysLeft <= 0) return "Out now";
  return s.daysLeft === 1 ? "About a day left" : `About ${s.daysLeft} days left`;
}

function render(view: SuppliesView) {
  const low = view.supplies.filter((s) => s.low).length;
  root.innerHTML = `
    <header>
      <div>
        <h1>Supplies</h1>
        <p class="household">${escape([low ? `${low} running low` : "Nothing running low", view.household].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="header-end">${sizeButton(screen)}</div>
    </header>
    ${
      view.supplies.length
        ? `<ul class="supplies">${view.supplies
            .map((s) => {
              const fill = s.daysLeft === undefined || s.needsFreshCount ? 0 : Math.max(0.03, Math.min(1, s.daysLeft / FULL_DAYS));
              const offer = s.low && !s.onList && view.lists.length;
              return `<li class="supply${s.low ? " low" : ""}">
                <div class="top">
                  <span class="title">${escape(s.name)}</span>
                  ${s.low ? `<span class="badge warn">Low</span>` : ""}
                  ${s.onList ? `<span class="badge">On ${escape(s.onList)}</span>` : ""}
                </div>
                <div class="amount">${escape(s.onHand)}</div>
                <div class="bar" role="img" aria-label="${escape(lasts(s))}"><span style="width:${(fill * 100).toFixed(0)}%"></span></div>
                <div class="meta">${escape(lasts(s))}</div>
                ${
                  offer
                    ? `<div class="add">${view.lists
                        .map((l) => `<button type="button" data-supply="${escape(s.name)}" data-list="${escape(l)}" ${pending.has(s.name) ? "disabled" : ""}>Add to ${escape(l)}</button>`)
                        .join("")}</div>`
                    : ""
                }
              </li>`;
            })
            .join("")}</ul>`
        : `<p class="empty">No supplies are tracked yet.</p>`
    }`;
}

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const add = target.closest<HTMLButtonElement>("button[data-supply]");
  if (add?.dataset.supply && add.dataset.list) void addToList(add.dataset.supply, add.dataset.list);
});

async function addToList(name: string, list: string) {
  if (pending.has(name)) return;
  pending.add(name);
  screen.rerender();
  const said = await screen.act("add_list_item", { text: name, list });
  if (said !== null) {
    // Someone whose changes need a parent's yes puts it on the list as waiting.
    const answer = JSON.parse(said) as { status?: string; approvers?: string[] };
    if (answer.status === "waiting_for_approval") {
      const who = (answer.approvers ?? []).join(" or ") || "a parent";
      screen.toast(`${name} is on ${list}, waiting for ${who}`);
      screen.tell("asked to add to a list", { supply: name, list }, `On the screen: asked for ${name} on ${list}; it waits for ${who} to approve.`);
    } else {
      screen.toast(`Added ${name} to ${list}`);
      screen.tell("added to a list", { supply: name, list }, `On the screen: added ${name} to ${list}.`);
    }
  }
  pending.delete(name);
  await screen.refreshNow();
}
