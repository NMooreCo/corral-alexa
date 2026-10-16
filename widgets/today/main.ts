import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CorralTask, CorralWhere } from "../../src/household.ts";
import type { TodayView } from "../../src/today.ts";
import "./style.css";

/**
 * The Today screen: today's calendar, chores and who's where, sized to read
 * from across a kitchen. Tapping a chore checks it off (or back on) through
 * the same Corral tools the assistant uses, so Corral's rules still apply.
 */

const app = new App({ name: "Corral Today", version: "0.1.0" });
const root = document.getElementById("app")!;
const toastEl = document.getElementById("toast")!;
let view: TodayView | null = null;
let timeZone: string | undefined;
const pending = new Set<string>();

app.ontoolresult = (result) => show(result as CallToolResult);
app.onhostcontextchanged = (ctx) => applyContext(ctx);
await app.connect();
applyContext(app.getHostContext());

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.timeZone) timeZone = ctx.timeZone;
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
  render();
}

function show(result: CallToolResult) {
  const v = result.structuredContent as TodayView | undefined;
  if (v && Array.isArray(v.events)) {
    view = v;
    render();
  }
}

// ---------- Words ----------

/** Corral says times like "Fri, Oct 16, 3:30 PM"; today's own date is left off. */
function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
}

function withoutToday(label: string): string {
  const today = todayLabel();
  if (label === today) return "Today";
  return label.startsWith(`${today}, `) ? label.slice(today.length + 2) : label;
}

function eventTime(when: string): string {
  if (when.endsWith("(all day)")) return "All day";
  return withoutToday(when);
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
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone });
  root.innerHTML = `
    <header>
      <h1>${escape(date)}</h1>
      ${view.household ? `<p class="household">${escape(view.household)}</p>` : ""}
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
                  return `<li class="${busy ? "busy" : ""}">
                    <span class="time">${escape(eventTime(e.when))}</span>
                    <span class="title">${escape(busy ? "Busy" : e.title)}</span>
                    ${line || e.location ? `<span class="meta">${escape([line, e.location].filter(Boolean).join(" · "))}</span>` : ""}
                  </li>`;
                })
                .join("")}</ol>`
            : `<p class="empty">Nothing on the calendar.</p>`
        }
      </section>
      <section aria-labelledby="h-chores">
        <h2 id="h-chores">Chores <span class="count">${left ? `${left} left` : "all done"}</span></h2>
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

// ---------- Checking off ----------

root.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-task]");
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
    const summary = (JSON.parse(text) as { summary?: string }).summary;
    // Tell the assistant, so "who did the eggs?" right after has the answer.
    void app.updateModelContext({ content: [{ type: "text", text: `On the screen: ${summary ?? t.title}.` }] }).catch(() => {});
  } catch (err) {
    toast(err instanceof Error ? err.message : "That didn't work.");
  } finally {
    pending.delete(id);
    await refresh();
  }
}

async function refresh() {
  try {
    show(await app.callServerTool({ name: "show_today", arguments: {} }));
  } catch {
    render();
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 5000);
}
