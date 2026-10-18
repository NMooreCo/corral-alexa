import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ApprovalsView, CorralRequest } from "../../src/approvals.ts";
import { escape, sizeButton, startScreen, withoutToday, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/**
 * Requests waiting for a yes: what someone may approve or decline, with a
 * big Approve and a Decline on each, and their own requests still waiting.
 * A tap decides through the same decide_approval tool the assistant uses, so
 * only someone who approves requests can, and approving makes the change.
 */

const root = document.getElementById("app")!;
/** Requests being decided right now, so a second tap does nothing. */
const pending = new Set<string>();
/** What was decided on this screen, kept in view after it leaves the list. */
const decided: { request: CorralRequest; decision: "approve" | "decline" }[] = [];

const screen: Screen<ApprovalsView> = await startScreen<ApprovalsView>({
  name: "corral-approvals",
  read: (r) => {
    const v = r.structuredContent as ApprovalsView | undefined;
    return v && Array.isArray(v.toDecide) ? v : null;
  },
  render,
  refresh: () => screen.app.callServerTool({ name: "show_approvals", arguments: {} }) as Promise<CallToolResult>,
});

const zone = () => screen.context()?.timeZone;
const initial = (name: string) => escape((name.trim()[0] ?? "?").toUpperCase());

function render(view: ApprovalsView) {
  const decides = view.requests === undefined;
  const waiting = view.toDecide.filter((r) => !decided.some((d) => d.request.id === r.id));
  const done = decided.filter((d) => !waiting.some((r) => r.id === d.request.id));
  const nothing = !waiting.length && !done.length && !view.yoursWaiting.length;
  root.innerHTML = `
    <header>
      <div>
        <h1>${decides ? "Waiting for you" : "Requests"}</h1>
        <p class="household">${escape([decides ? (waiting.length ? `${waiting.length} to decide` : "Nothing to decide") : view.yoursWaiting.length ? `${view.yoursWaiting.length} waiting for a yes` : "", view.household].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="header-end">${sizeButton(screen)}</div>
    </header>
    ${
      nothing
        ? `<section class="clear"><span class="mark" aria-hidden="true"></span><p class="title">${decides ? "Nothing's waiting for you." : "Nothing of yours is waiting."}</p>${view.requests ? `<p class="meta">${escape(view.requests)}</p>` : ""}</section>`
        : ""
    }
    ${
      waiting.length || done.length
        ? `<section aria-labelledby="h-decide">
            <h2 id="h-decide">To decide</h2>
            <ul class="requests">
              ${waiting.map(card).join("")}
              ${done.map(({ request, decision }) => `<li class="request decided ${decision === "approve" ? "approved" : "declined"}"><span class="avatar" aria-hidden="true">${initial(request.from)}</span><div class="body"><p class="who">${escape(request.from)} asked</p><p class="asks">${escape(request.asks)}</p></div><span class="badge solid">${decision === "approve" ? "Approved" : "Declined"}</span></li>`).join("")}
            </ul>
          </section>`
        : ""
    }
    ${
      view.yoursWaiting.length
        ? `<section aria-labelledby="h-mine">
            <h2 id="h-mine">Yours, waiting</h2>
            <ul class="mine">${view.yoursWaiting
              .map((r) => `<li><p class="asks">${escape(r.asks)}</p><p class="meta">Waiting for ${escape(r.decidedBy)} · asked ${escape(withoutToday(r.since, zone()))}</p></li>`)
              .join("")}</ul>
          </section>`
        : ""
    }`;
}

function card(r: CorralRequest): string {
  const busy = pending.has(r.id);
  return `<li class="request${busy ? " pending" : ""}">
    <span class="avatar" aria-hidden="true">${initial(r.from)}</span>
    <div class="body">
      <p class="who">${escape(r.from)} asks <span class="meta">· ${escape(withoutToday(r.since, zone()))}</span></p>
      <p class="asks">${escape(r.asks)}</p>
    </div>
    <div class="actions">
      <button type="button" class="approve" data-request="${escape(r.id)}" data-decision="approve" ${busy ? "disabled" : ""}>Approve</button>
      <button type="button" class="decline" data-request="${escape(r.id)}" data-decision="decline" ${busy ? "disabled" : ""}>Decline</button>
    </div>
  </li>`;
}

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const button = target.closest<HTMLButtonElement>("button[data-request]");
  const decision = button?.dataset.decision;
  if (button?.dataset.request && (decision === "approve" || decision === "decline")) void decide(button.dataset.request, decision);
});

async function decide(id: string, decision: "approve" | "decline") {
  const request = screen.view()?.toDecide.find((r) => r.id === id);
  if (!request || pending.has(id)) return;
  pending.add(id);
  screen.rerender();
  const text = await screen.act("decide_approval", { request: id, decision });
  pending.delete(id);
  if (text !== null) {
    decided.push({ request, decision });
    const summary = (JSON.parse(text) as { summary?: string }).summary ?? `${decision === "approve" ? "Approved" : "Declined"} ${request.from}'s request`;
    screen.toast(summary);
    // Tell the assistant, so "is it on the calendar?" right after has the answer.
    screen.tell(decision === "approve" ? "approved" : "declined", { from: request.from, request: request.asks }, `On the screen: ${summary}.`);
  }
  await screen.refreshNow();
}
