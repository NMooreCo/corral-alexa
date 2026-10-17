import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CorralEvent, CorralTask, CorralWhere } from "../../src/household.ts";
import type { TodayView } from "../../src/today.ts";
import "./style.css";

/**
 * The Today screen: today's calendar, chores and who's where, sized to read
 * from across a kitchen. It keeps itself current (a refresh every minute
 * while it's on screen), marks what's on now and next, and checks chores off
 * through the same Corral tools the assistant uses, so Corral's rules still
 * apply and the assistant hears what happened.
 */

const REFRESH_MS = 60_000;
const app = new App({ name: "Corral Today", version: "0.2.0" });
const root = document.getElementById("app")!;
const toastEl = document.getElementById("toast")!;
let view: TodayView | null = null;
let context: McpUiHostContext | undefined;
const pending = new Set<string>();
let visible = true;

app.ontoolresult = (result) => show(result as CallToolResult);
app.onhostcontextchanged = (ctx) => applyContext({ ...context, ...ctx });
app.onteardown = async () => {
  clearInterval(refreshTimer);
  clearInterval(clockTimer);
  observer.disconnect();
  return {};
};
await app.connect();
applyContext(app.getHostContext());

// ---------- Host ----------

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  context = ctx;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  document.documentElement.dataset.display = ctx.displayMode ?? "inline";
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
  render();
}

const canFullscreen = () => context?.availableDisplayModes?.includes("fullscreen") ?? false;
const isFullscreen = () => context?.displayMode === "fullscreen";

async function toggleFullscreen() {
  try {
    const { mode } = await app.requestDisplayMode({ mode: isFullscreen() ? "inline" : "fullscreen" });
    applyContext({ ...context, displayMode: mode });
  } catch {
    toast("This screen can't change size here.");
  }
}

function show(result: CallToolResult) {
  const v = result.structuredContent as TodayView | undefined;
  if (v && Array.isArray(v.events)) {
    view = v;
    render();
  }
}

// ---------- Staying current ----------

/** The screen's own refresh, through a tool only it can call (the assistant never sees it). */
async function refresh() {
  try {
    show(await app.callServerTool({ name: "refresh_today", arguments: {} }));
  } catch {
    render();
  }
}

const refreshTimer = setInterval(() => {
  if (visible && document.visibilityState === "visible") void refresh();
}, REFRESH_MS);
// The clock and "now" move even between refreshes.
const clockTimer = setInterval(() => visible && render(), 15_000);
// Scrolled out of a conversation or hidden: stop asking; back in view: catch up at once.
const observer = new IntersectionObserver(([entry]) => {
  const was = visible;
  visible = entry?.isIntersecting ?? true;
  if (visible && !was) void refresh();
});
observer.observe(root);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void refresh());

// ---------- Words and time ----------

const timeZone = () => context?.timeZone;

/** Corral says times like "Fri, Oct 16, 3:30 PM"; today's own date is left off. */
function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timeZone() });
}

function withoutToday(label: string): string {
  const today = todayLabel();
  if (label === today) return "Today";
  return label.startsWith(`${today}, `) ? label.slice(today.length + 2) : label;
}

function eventTime(when: string): string {
  return when.endsWith("(all day)") ? "All day" : withoutToday(when);
}

/** Minutes after midnight for "3:30 PM", or null. */
function minutesOf(clock: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(clock?.trim() ?? "");
  if (!m) return null;
  return ((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]);
}

function nowMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: false, timeZone: timeZone() }).formatToParts(new Date());
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

function firstName(name: string): string {
  return name.split(" ")[0] ?? name;
}

function who(t: CorralTask): string {
  if (t.status === "done") return t.doneBy ? `Done by ${firstName(t.doneBy)}` : "Done";
  if (t.assignees[0] === "anyone") return "Anyone";
  return t.assignees.map(firstName).join(" and ");
}

function where(w: CorralWhere): string {
  if (!w.until) return "";
  return `until ${withoutToday(w.until)}${w.then ? `, then ${w.then}` : ""}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- Drawing ----------

function render() {
  if (!view) return;
  const left = view.tasks.filter((t) => t.status !== "done" && t.status !== "skipped").length;
  const late = view.tasks.filter((t) => t.status === "overdue").length;
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timeZone() });
  const clock = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone() });
  const { now, next } = nowAndNext(view.events);
  root.innerHTML = `
    <header>
      <div>
        <h1>${escape(date)}</h1>
        ${view.household ? `<p class="household">${escape(view.household)}</p>` : ""}
      </div>
      <div class="header-end">
        <span class="clock" aria-label="Time">${escape(clock)}</span>
        ${canFullscreen() ? `<button type="button" class="size" data-action="fullscreen">${isFullscreen() ? "Exit full screen" : "Full screen"}</button>` : ""}
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
                  // "Maya, Leo, Alex drives": whoever drives is named once, as the driver.
                  const line = [...e.people.filter((p) => !e.drivers.includes(p)).map(firstName), ...e.drivers.map((d) => `${firstName(d)} drives`)].join(", ");
                  const badge = now.has(e) ? `<span class="badge now">Now</span>` : e === next ? `<span class="badge next">Next</span>` : "";
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
                  (t) => `<li><button type="button" class="chore ${t.status}${pending.has(t.id) ? " pending" : ""}" data-task="${escape(t.id)}" aria-pressed="${t.status === "done"}" ${t.status === "skipped" ? "disabled" : ""}>
                    <span class="box" aria-hidden="true"></span>
                    <span class="title">${escape(t.title)}</span>
                    <span class="meta">${escape(who(t))}${t.status === "done" ? "" : ` · ${escape(withoutToday(t.due))}`}${t.status === "overdue" ? ` · <strong>Late</strong>` : ""}</span>
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

// ---------- Tapping ----------

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void toggleFullscreen();
  const button = target.closest<HTMLButtonElement>("button[data-task]");
  if (button?.dataset.task) void toggle(button.dataset.task);
});

async function toggle(id: string) {
  const t = view?.tasks.find((x) => x.id === id);
  if (!view || !t || pending.has(id)) return;
  const doing = t.status !== "done";
  pending.add(id);
  // Show it at once; Corral's answer, read back below, has the last word.
  t.status = doing ? "done" : "open";
  render();
  try {
    const res = await app.callServerTool({ name: doing ? "complete_task" : "undo_task", arguments: { task: id } });
    const said = res.content?.find((c) => c.type === "text");
    const text = said && "text" in said ? said.text : "";
    if (res.isError) throw new Error(text || "That didn't work.");
    const summary = (JSON.parse(text) as { summary?: string }).summary ?? t.title;
    // Tell the assistant, so "who did the eggs?" right after has the answer.
    void app
      .updateModelContext({ content: [{ type: "text", text: `---\nscreen: corral-today\naction: ${doing ? "checked off" : "put back"}\ntask: ${JSON.stringify(t.title)}\n---\nOn the screen: ${summary}.` }] })
      .catch(() => {});
  } catch (err) {
    toast(err instanceof Error ? err.message : "That didn't work.");
  } finally {
    pending.delete(id);
    await refresh();
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 5000);
}
