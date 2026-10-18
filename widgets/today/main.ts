import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CorralEvent, CorralTask, CorralWhere } from "../../src/household.ts";
import type { TodayView } from "../../src/today.ts";
import { escape, firstName, sizeButton, startScreen, withoutToday, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/**
 * The Today screen: today's calendar, chores and who's where, sized to read
 * from across a kitchen. It keeps itself current, marks what's on now and
 * next, and checks chores off through the same Corral tools the assistant
 * uses, so Corral's rules still apply and the assistant hears what happened.
 */

const root = document.getElementById("app")!;
const pending = new Set<string>();

const screen: Screen<TodayView> = await startScreen<TodayView>({
  name: "corral-today",
  read: (r) => {
    const v = r.structuredContent as TodayView | undefined;
    return v && Array.isArray(v.events) ? v : null;
  },
  render,
  // The screen's own refresh, through a tool only it can call (the assistant never sees it).
  refresh: () => screen.app.callServerTool({ name: "refresh_today", arguments: {} }) as Promise<CallToolResult>,
});

const zone = () => screen.context()?.timeZone;
const eventTime = (when: string) => (when.endsWith("(all day)") ? "All day" : withoutToday(when, zone()));

/** Minutes after midnight for "3:30 PM", or null. */
function minutesOf(clock: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(clock?.trim() ?? "");
  if (!m) return null;
  return ((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]);
}

function nowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: false, timeZone: zone() }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** Which of today's timed events is on now, and which is next. */
function nowAndNext(events: CorralEvent[]): { now: Set<CorralEvent>; next: CorralEvent | null } {
  const now = new Set<CorralEvent>();
  let next: CorralEvent | null = null;
  const t = nowMinutes();
  for (const e of events) {
    const label = eventTime(e.when);
    if (label === "All day" || label.includes(",")) continue;
    const [from, to] = label.split(" to ");
    const start = minutesOf(from);
    const end = minutesOf(to);
    if (start === null || end === null) continue;
    if (start <= t && t < end) now.add(e);
    else if (start > t && !next) next = e;
  }
  return { now, next };
}

function who(t: CorralTask): string {
  if (t.status === "done") return t.doneBy ? `Done by ${firstName(t.doneBy)}` : "Done";
  if (t.assignees[0] === "anyone") return "Anyone";
  return t.assignees.map(firstName).join(" and ");
}

function where(w: CorralWhere): string {
  if (!w.until) return "";
  return `until ${withoutToday(w.until, zone())}${w.then ? `, then ${w.then}` : ""}`;
}

function render(view: TodayView) {
  const left = view.tasks.filter((t) => t.status !== "done" && t.status !== "skipped").length;
  const late = view.tasks.filter((t) => t.status === "overdue").length;
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zone() });
  const clock = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone() });
  const { now, next } = nowAndNext(view.events);
  root.innerHTML = `
    <header>
      <div>
        <h1>${escape(date)}</h1>
        ${view.household ? `<p class="household">${escape(view.household)}</p>` : ""}
      </div>
      <div class="header-end">
        <span class="clock" aria-label="Time">${escape(clock)}</span>
        ${sizeButton(screen)}
      </div>
    </header>
    <div class="columns">
      <section aria-labelledby="h-cal">
        <h2 id="h-cal">Calendar</h2>
        ${
          view.events.length
            ? `<ol class="events">${view.events
                .map((e) => {
                  const busy = !e.event;
                  // "Eli, Jak, Holly drives": whoever drives is named once, as the driver.
                  const line = [...e.people.filter((p) => !e.drivers.includes(p)).map(firstName), ...e.drivers.map((d) => `${firstName(d)} drives`)].join(", ");
                  const badge = now.has(e) ? `<span class="badge solid">Now</span>` : e === next ? `<span class="badge">Next</span>` : "";
                  return `<li class="${busy ? "busy" : ""}${now.has(e) ? " is-now" : ""}">
                    <span class="time">${escape(eventTime(e.when))}${badge}</span>
                    <span class="title">${escape(busy ? "Busy" : e.title)}</span>
                    ${line || e.location ? `<span class="meta">${escape([line, e.location].filter(Boolean).join(" · "))}</span>` : ""}
                  </li>`;
                })
                .join("")}</ol>`
            : `<p class="empty">Nothing on the calendar today.</p>`
        }
      </section>
      <section aria-labelledby="h-chores">
        <h2 id="h-chores">Chores <span class="count">${left ? `${left} left${late ? `, ${late} late` : ""}` : "all done"}</span></h2>
        ${
          view.tasks.length
            ? `<ul class="chores">${view.tasks
                .map(
                  (t) => `<li><button type="button" class="tick chore ${t.status}${pending.has(t.id) ? " pending" : ""}" data-task="${escape(t.id)}" aria-pressed="${t.status === "done"}" ${t.status === "skipped" ? "disabled" : ""}>
                    <span class="box" aria-hidden="true"></span>
                    <span class="title">${escape(t.title)}</span>
                    <span class="meta">${escape(who(t))}${t.status === "done" ? "" : ` · ${escape(withoutToday(t.due, zone()))}`}${t.status === "overdue" ? ` · <strong>Late</strong>` : ""}</span>
                  </button></li>`,
                )
                .join("")}</ul>`
            : `<p class="empty">No chores today.</p>`
        }
      </section>
      <section aria-labelledby="h-where">
        <h2 id="h-where">Who's where</h2>
        ${
          view.whereabouts.length
            ? `<ul class="where">${view.whereabouts
                .map((w) => `<li><span class="name">${escape(firstName(w.name))}</span><span class="place">${escape(w.location)}</span><span class="meta">${escape(where(w))}</span></li>`)
                .join("")}</ul>`
            : `<p class="empty">No one's whereabouts to show.</p>`
        }
      </section>
    </div>`;
}

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const button = target.closest<HTMLButtonElement>("button[data-task]");
  if (button?.dataset.task) void toggle(button.dataset.task);
});

async function toggle(id: string) {
  const view = screen.view();
  const t = view?.tasks.find((x) => x.id === id);
  if (!view || !t || pending.has(id)) return;
  const doing = t.status !== "done";
  pending.add(id);
  // Show it at once; Corral's answer, read back below, has the last word.
  t.status = doing ? "done" : "open";
  screen.rerender();
  const text = await screen.act(doing ? "complete_task" : "undo_task", { task: id });
  if (text !== null) {
    const summary = (JSON.parse(text) as { summary?: string }).summary ?? t.title;
    // Tell the assistant, so "who did the eggs?" right after has the answer.
    screen.tell(doing ? "checked off" : "put back", { task: t.title }, `On the screen: ${summary}.`);
  }
  pending.delete(id);
  await screen.refreshNow();
}
