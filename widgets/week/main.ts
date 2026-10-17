import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CorralEvent } from "../../src/household.ts";
import type { WeekView } from "../../src/screens.ts";
import { escape, firstName, sizeButton, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/** Seven days of the family calendar at a glance, with today marked and who's driving. */

const root = document.getElementById("app")!;

const screen: Screen<WeekView> = await startScreen<WeekView>({
  name: "corral-week",
  read: (r) => {
    const v = r.structuredContent as WeekView | undefined;
    return v && Array.isArray(v.days) ? v : null;
  },
  render,
  refresh: () => screen.app.callServerTool({ name: "show_week", arguments: { from: screen.view()?.from } }) as Promise<CallToolResult>,
  refreshMs: 5 * 60_000,
});

/** "Sat, Oct 17, 3:30 PM to 4:45 PM" on Saturday's column is just "3:30 PM to 4:45 PM". */
function time(e: CorralEvent, dayLabel: string): string {
  if (e.when.endsWith("(all day)")) return "All day";
  return e.when.startsWith(`${dayLabel}, `) ? e.when.slice(dayLabel.length + 2) : e.when;
}

function range(view: WeekView): string {
  const first = view.days[0]?.label.replace(/^\w+, /, "");
  const last = view.days.at(-1)?.label.replace(/^\w+, /, "");
  return first && last ? `${first} to ${last}` : "";
}

function render(view: WeekView) {
  const count = view.days.reduce((n, d) => n + d.events.length, 0);
  root.innerHTML = `
    <header>
      <div>
        <h1>${view.from === view.today ? "This week" : "The week"}</h1>
        <p class="household">${escape([range(view), view.household].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="header-end">${sizeButton(screen)}</div>
    </header>
    ${count ? "" : `<p class="empty">Nothing on the calendar these seven days.</p>`}
    <div class="days">
      ${view.days
        .map((d) => {
          const [weekday, , dayNum] = d.label.split(/,? /);
          const isToday = d.date === view.today;
          return `<section class="day${isToday ? " today" : ""}" aria-label="${escape(d.label)}">
            <h2><span>${escape(weekday ?? "")} ${escape(dayNum ?? "")}</span>${isToday ? `<span class="badge solid">Today</span>` : ""}</h2>
            ${
              d.events.length
                ? `<ol>${d.events
                    .map((e) => {
                      const busy = !e.event;
                      const line = [...e.people.filter((p) => !e.drivers.includes(p)).map(firstName), ...e.drivers.map((x) => `${firstName(x)} drives`)].join(", ");
                      return `<li class="${busy ? "busy" : ""}">
                        <span class="time">${escape(time(e, d.label))}</span>
                        <span class="title">${escape(busy ? "Busy" : e.title)}</span>
                        ${line ? `<span class="meta">${escape(line)}</span>` : ""}
                      </li>`;
                    })
                    .join("")}</ol>`
                : `<p class="empty">Free</p>`
            }
          </section>`;
        })
        .join("")}
    </div>`;
}

root.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-action=fullscreen]")) void screen.toggleFullscreen();
});
