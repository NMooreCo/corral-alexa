import type { AutomationView } from "../../src/ranch/automations.ts";
import type { RanchView } from "../../src/ranch/views.ts";
import { escape, sizeButton } from "../shared/screen.ts";
import type { Home } from "./main.ts";
import { weatherLine } from "./ranch.ts";

/**
 * The Automations tab: each of the ranch's automations, what starts it,
 * what it switches, when it runs next and what it did last, with a switch
 * to turn it on or off. The switch uses the same set_automation tool the
 * assistant does, so the household's rules about who may change it apply.
 */

const pending = new Set<string>();

const KIND_ICONS: Record<AutomationView["kind"], string> = {
  // A snowflake, a clock and a gauge.
  freeze: `<path d="M12 2v20M4 7l16 10M20 7 4 17"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2"/>`,
  schedule: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  reading: `<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>`,
};

function rule(a: AutomationView): string {
  const busy = pending.has(a.id) ? "disabled" : "";
  const last = a.lastRun ? `Last: ${a.lastRun.at}${a.lastRun.did.length ? `, ${a.lastRun.did.join(", ")}` : ""}${a.lastRun.failed.length ? `. ${a.lastRun.failed.join(" ")}` : ""}` : "";
  return `<li class="rule ${a.enabled ? "on" : "off"}">
    <div class="rule-top">
      <svg class="kind" viewBox="0 0 24 24" aria-hidden="true">${KIND_ICONS[a.kind]}</svg>
      <span class="title">${escape(a.name)}</span>
      <button type="button" class="switch" role="switch" aria-checked="${a.enabled}" aria-label="${escape(`${a.name}: ${a.enabled ? "on" : "off"}`)}" data-automation="${escape(a.id)}" ${busy}></button>
    </div>
    <p class="when">${escape(a.when)}</p>
    <ul class="then">${a.then.map((t) => `<li>${escape(t)}</li>`).join("")}</ul>
    <p class="meta">${escape([a.next ? `Next: ${a.next}` : "Off", last].filter(Boolean).join(" · "))}</p>
  </li>`;
}

export function automationsHtml(view: RanchView, home: Home): string {
  const on = view.automations.filter((a) => a.enabled).length;
  return `
    <header>
      <div>
        <h1>Automations</h1>
        <p class="household">${escape(`${on} of ${view.automations.length} on`)}</p>
      </div>
      <div class="header-end">
        ${weatherLine(view)}
        ${sizeButton(home.screen)}
      </div>
    </header>
    ${view.automations.length ? `<ul class="rules">${view.automations.map(rule).join("")}</ul>` : `<p class="empty">No automations yet. Ask for one, like "run the misters every morning at 7".</p>`}`;
}

/** A tap on the Automations tab; true when it was one of its own. */
export function automationsClick(target: HTMLElement, home: Home): boolean {
  const b = target.closest<HTMLButtonElement>("button[data-automation]");
  if (!b?.dataset.automation) return false;
  void flip(b.dataset.automation, home);
  return true;
}

async function flip(id: string, home: Home) {
  const a = home.ranch()?.automations.find((x) => x.id === id);
  if (!a || pending.has(id)) return;
  const enabled = !a.enabled;
  pending.add(id);
  // Show it at once; the tool's answer, read back below, has the last word.
  a.enabled = enabled;
  home.screen.rerender();
  const text = await home.screen.act("set_automation", { automation: id, enabled });
  pending.delete(id);
  if (text !== null) {
    home.screen.toast(`${a.name} ${enabled ? "on" : "off"}`);
    // Tell the assistant, so "is freeze protection on?" right after has the answer.
    home.screen.tell("switched automation", { automation: a.name, enabled: String(enabled) }, `On the screen: ${a.name} turned ${enabled ? "on" : "off"}.`);
  }
  await home.screen.refreshNow();
}
