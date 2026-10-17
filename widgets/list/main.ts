import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ListView } from "../../src/screens.ts";
import { escape, sizeButton, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/** A shopping or to-do list, big enough to read from the counter: tap an item when it's in the cart. */

const root = document.getElementById("app")!;
const pending = new Set<string>();

const screen: Screen<ListView> = await startScreen<ListView>({
  name: "corral-list",
  read: (r) => {
    const v = r.structuredContent as ListView | undefined;
    return v && Array.isArray(v.items) ? v : null;
  },
  render,
  refresh: () => open(screen.view()?.list),
});

function open(list: string | undefined): Promise<CallToolResult> {
  return screen.app.callServerTool({ name: "show_list", arguments: list ? { list } : {} }) as Promise<CallToolResult>;
}

function render(view: ListView) {
  const count = view.items.length;
  root.innerHTML = `
    <header>
      <div>
        <h1>${escape(view.list || "Lists")}</h1>
        ${view.household ? `<p class="household">${escape(view.household)}</p>` : ""}
      </div>
      <div class="header-end">${sizeButton(screen)}</div>
    </header>
    ${
      view.lists.length > 1
        ? `<nav class="tabs" aria-label="Lists">${view.lists.map((l) => `<button type="button" data-list="${escape(l)}" aria-current="${l === view.list}">${escape(l)}</button>`).join("")}</nav>`
        : ""
    }
    <section>
      <h2>${count ? `${count} ${count === 1 ? "thing" : "things"}` : "All done"}</h2>
      ${
        count
          ? `<ul class="items">${view.items
              .map(
                (it) => `<li><button type="button" class="tick${pending.has(it.text) ? " pending" : ""}" data-item="${escape(it.text)}">
                  <span class="box" aria-hidden="true"></span>
                  <span class="title">${escape(it.text)}${it.waitingForApproval ? `<span class="badge warn">Waiting for a parent</span>` : ""}</span>
                  <span class="meta">${escape(it.quantity ?? "")}</span>
                </button></li>`,
              )
              .join("")}</ul>`
          : `<p class="empty">Nothing on ${escape(view.list || "this list")}.</p>`
      }
    </section>`;
}

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const tab = target.closest<HTMLButtonElement>("button[data-list]");
  if (tab?.dataset.list) return void open(tab.dataset.list).then(screen.show);
  const item = target.closest<HTMLButtonElement>("button[data-item]");
  if (item?.dataset.item) void check(item.dataset.item);
});

async function check(text: string) {
  const view = screen.view();
  if (!view || pending.has(text)) return;
  pending.add(text);
  screen.rerender();
  const said = await screen.act("check_list_item", { text, list: view.list });
  if (said !== null) screen.tell("checked off", { list: view.list, item: text }, `On the screen: checked off ${text} on ${view.list}.`);
  pending.delete(text);
  await screen.refreshNow();
}
