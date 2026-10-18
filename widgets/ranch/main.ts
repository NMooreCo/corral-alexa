import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Device } from "../../src/ranch/types.ts";
import type { MapPin, RanchView } from "../../src/ranch/views.ts";
import { escape, sizeButton, startScreen, type Screen } from "../shared/screen.ts";
import "../shared/base.css";
import "./style.css";

/**
 * The Ranch screen: the property drawn as a map (fence, zones, a pin for each
 * collar, anything outside the fence standing out) and a tile for every
 * device, by place. Tiles switch devices through the same set_device tool the
 * assistant uses, so each device's limits still apply, and a run counts down
 * on the tile whether it started here or by voice.
 */

const root = document.getElementById("app")!;
const pending = new Set<string>();
/** A device whose safe state is on, waiting for a second tap to switch it off. */
const confirming = new Map<string, ReturnType<typeof setTimeout>>();
let ended = new Set<string>();

const screen: Screen<RanchView> = await startScreen<RanchView>({
  name: "corral-ranch",
  read: (r) => {
    const v = r.structuredContent as RanchView | undefined;
    return v && v.map && Array.isArray(v.places) ? v : null;
  },
  render,
  refresh: () => screen.app.callServerTool({ name: "refresh_ranch", arguments: {} }) as Promise<CallToolResult>,
  refreshMs: 20_000,
});

// ---------- Words ----------

function short(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${seconds} s`;
}

function left(endsAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(endsAt) - Date.now()) / 1000));
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- Icons (a word for what a device is, drawn; anything unknown gets a dot) ----------

const ICONS: Record<string, string> = {
  valve: `<path d="M12 3c3.5 4.6 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.4 6-11Z"/>`,
  heater: `<path d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.6.7-2.8 1.5-3.7.2 1.6 1 2.6 2 2.7C11 8.5 11 5.5 12 3Z"/><path d="M7 20h10"/>`,
  "tank heater": `<path d="M4 9h16v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z"/><path d="M8 13c1.3-1 2.7 1 4 0s2.7 1 4 0"/>`,
  lamp: `<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>`,
  sensor: `<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Z"/>`,
  soil: `<path d="M12 20v-7M12 13c0-3 2-5 6-5 0 3-2 5-6 5ZM12 15c0-2.5-1.7-4-5-4 0 2.5 1.7 4 5 4Z"/><path d="M5 20h14"/>`,
  tank: `<rect x="5" y="7" width="14" height="11" rx="5.5"/><path d="M9 7V5h6v2"/>`,
  waterer: `<path d="M4 11h16l-1.5 8h-13Z"/><path d="M12 3c1.6 2 2.5 3.3 2.5 4.5a2.5 2.5 0 0 1-5 0C9.5 6.3 10.4 5 12 3Z"/>`,
};

function icon(kind: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind] ?? `<circle cx="12" cy="12" r="5"/>`}</svg>`;
}

// ---------- The map ----------

function pin(p: MapPin): string {
  const cls = ["pin", p.outside ? "outside" : "", p.batteryLow ? "low" : "", p.stale ? "stale" : ""].filter(Boolean).join(" ");
  const label = `${p.animal}${p.batteryLow ? ` ${p.battery}%` : ""}`;
  const below = p.y < 90;
  return `<g class="${cls}" transform="translate(${p.x} ${p.y})">
    <title>${escape(`${p.animal} (${p.species}): ${p.where}. Collar ${p.battery}%, seen ${p.lastSeen}.`)}</title>
    ${p.outside ? `<circle class="ring" r="30"/>` : ""}
    <circle class="dot" r="15"/>
    <text class="initial" y="7">${escape(p.animal.charAt(0))}</text>
    <text class="name" y="${below ? 46 : -24}">${escape(label)}</text>
  </g>`;
}

function map(view: RanchView): string {
  const m = view.map;
  return `<svg class="map" viewBox="0 0 ${m.width} ${m.height}" role="img" aria-label="${escape(`Map of the property. ${view.animals.outside.length ? `Outside the fence: ${view.animals.outside.join(", ")}.` : "Every animal is inside the fence."}`)}">
    <rect class="ground" x="0" y="0" width="${m.width}" height="${m.height}" rx="18"/>
    ${m.zones.map((z) => `<path class="zone ${escape(z.style)}" d="${z.d}"/>`).join("")}
    <path class="fence" d="${m.fence}"/>
    ${m.zones.map((z) => `<text class="zone-name" x="${z.x}" y="${z.y}">${escape(z.name)}</text>`).join("")}
    ${m.pins.map(pin).join("")}
    <g class="north" transform="translate(${m.width - 40} ${m.height - 60})"><path d="M0 -26 L12 10 L0 3 L-12 10 Z"/><text y="34">N</text></g>
    <g class="scale" transform="translate(24 ${m.height - 20})"><path d="M0 0 H${m.scale.length}"/><path d="M0 -8 V8 M${m.scale.length} -8 V8"/><text x="${m.scale.length / 2}" y="-14">${escape(m.scale.label)}</text></g>
  </svg>`;
}

// ---------- Device tiles ----------

function readings(d: Device): string {
  if (!d.readings.length) return "";
  // Several percentages of the same kind (calibrated soil beds) read best as bars; several raw numbers, as a tight list.
  if (d.readings.length > 3 && d.readings.every((r) => r.unit === "%")) {
    return `<ul class="bars">${d.readings
      .map((r) => {
        const pct = r.unit === "%" && r.value !== null ? r.value : null;
        return `<li class="${r.low || r.fault ? "warn" : ""}"><span class="label">${escape(r.label)}</span><span class="bar"><span style="width:${pct ?? 0}%"></span></span><span class="value">${escape(r.fault ? "Fault" : r.text)}</span></li>`;
      })
      .join("")}</ul>`;
  }
  return `<dl class="readings${d.readings.length > 3 ? " many" : ""}">${d.readings.map((r) => `<div class="${r.low || r.high || r.fault ? "warn" : ""}"><dt>${escape(r.label)}</dt><dd>${escape(r.text)}</dd></div>`).join("")}</dl>`;
}

function controls(d: Device): string {
  if (!d.switchable || !d.reachable) return "";
  const busy = pending.has(d.id) ? "disabled" : "";
  if (d.state === "on" && d.run) return `<div class="controls"><button type="button" data-device="${escape(d.id)}" data-state="off" ${busy}>Stop</button></div>`;
  if (d.limits.maxRunS) {
    const presets = (d.limits.presetsS?.length ? d.limits.presetsS : [d.limits.defaultRunS ?? d.limits.maxRunS]).filter((s) => s <= d.limits.maxRunS!);
    const play = `<svg class="play" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1 L9 5 L2 9 Z"/></svg>`;
    return `<div class="controls">${presets.map((s) => `<button type="button" data-device="${escape(d.id)}" data-state="on" data-seconds="${s}" aria-label="Run for ${escape(short(s))}" ${busy}>${play}${escape(short(s))}</button>`).join("")}</div>`;
  }
  const off = d.state === "on";
  const ask = confirming.has(d.id);
  return `<div class="controls"><button type="button" class="${off ? "" : "primary"}${ask ? " confirm" : ""}" data-device="${escape(d.id)}" data-state="${off ? "off" : "on"}" ${busy}>${off ? (ask ? "Tap again to turn off" : "Turn off") : "Turn on"}</button></div>`;
}

function stateLine(d: Device): string {
  if (!d.reachable) return `<span class="state unknown">Not answering</span>`;
  if (!d.switchable) return "";
  if (d.state === "on" && d.run) return `<span class="state on">Running <span class="countdown" data-ends="${escape(d.run.endsAt)}" data-device="${escape(d.id)}">${clock(left(d.run.endsAt))}</span></span>`;
  return `<span class="state ${d.state === "on" ? "on" : "off"}">${d.state === "on" ? "On" : "Off"}</span>`;
}

function tile(d: Device): string {
  const warn = d.attention.length > 0;
  return `<li class="tile${warn ? " warn" : ""}${d.reachable ? "" : " gone"}${d.state === "on" ? " is-on" : ""}">
    <div class="tile-top">${icon(d.kind)}<span class="title">${escape(d.name)}</span>${d.live ? `<span class="badge solid">Live</span>` : ""}</div>
    <div class="tile-state">${stateLine(d)}<span class="place-tag">${escape(d.place)}</span></div>
    ${readings(d)}
    ${warn ? `<p class="attention">${escape(d.attention[0]!)}</p>` : ""}
    ${controls(d)}
  </li>`;
}

function running(view: RanchView): string {
  const all = view.places.flatMap((p) => p.devices);
  const runs = all.filter((d) => d.run).length;
  const on = all.filter((d) => d.state === "on").length;
  return runs ? `${runs} running` : `${on} on`;
}

function render(view: RanchView) {
  ended = new Set();
  const w = view.weather;
  root.innerHTML = `
    <header>
      <div>
        <h1>Ranch</h1>
        <p class="household">${escape([view.household, view.attention ? `${view.attention} to look at` : "All's well"].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="header-end">
        ${w ? `<span class="weather${w.freeze ? " freeze" : ""}"><strong>${escape(w.now)}</strong> ${escape(w.conditions)} · ${escape(w.tonight)}${w.freeze ? ` <span class="badge warn">Freeze</span>` : ""}</span>` : ""}
        ${sizeButton(screen)}
      </div>
    </header>
    <div class="ranch">
      <section class="map-card" aria-labelledby="h-map">
        <h2 id="h-map">Animals <span class="count">${escape(view.animals.outside.length ? `${view.animals.outside.length} outside the fence` : "all inside the fence")}</span></h2>
        ${map(view)}
        <p class="meta">${escape([view.animals.outside.length ? `Outside: ${view.animals.outside.join(", ")}` : "", view.animals.lowBattery.length ? `Low collar battery: ${view.animals.lowBattery.join(", ")}` : "", view.animals.live ? "" : view.animals.feed].filter(Boolean).join(" · "))}</p>
      </section>
      <section class="devices" aria-labelledby="h-devices">
        <h2 id="h-devices">Devices <span class="count">${escape(running(view))}</span></h2>
        <ul class="tiles">${view.places.flatMap((p) => p.devices).map(tile).join("")}</ul>
      </section>
    </div>`;
}

// Runs count down every second, between refreshes; when one ends, ask for the real state.
setInterval(() => {
  for (const el of root.querySelectorAll<HTMLElement>(".countdown[data-ends]")) {
    const s = left(el.dataset.ends!);
    el.textContent = clock(s);
    if (s === 0 && !ended.has(el.dataset.device!)) {
      ended.add(el.dataset.device!);
      setTimeout(() => void screen.refreshNow(), 1200);
    }
  }
}, 1000);

root.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("[data-action=fullscreen]")) return void screen.toggleFullscreen();
  const b = target.closest<HTMLButtonElement>("button[data-device]");
  if (b?.dataset.device && b.dataset.state) void flip(b.dataset.device, b.dataset.state as "on" | "off", b.dataset.seconds ? Number(b.dataset.seconds) : undefined);
});

async function flip(id: string, state: "on" | "off", seconds?: number) {
  const view = screen.view();
  const d = view?.places.flatMap((p) => p.devices).find((x) => x.id === id);
  if (!view || !d || pending.has(id)) return;
  // Switching off something whose safe state is on (a heater) takes a second tap.
  if (state === "off" && d.limits.failsafe === "on" && !confirming.has(id)) {
    confirming.set(
      id,
      setTimeout(() => {
        confirming.delete(id);
        screen.rerender();
      }, 4000),
    );
    return screen.rerender();
  }
  clearTimeout(confirming.get(id));
  confirming.delete(id);
  pending.add(id);
  // Show it at once; the tool's answer, read back below, has the last word.
  d.state = state;
  d.run = state === "on" && seconds ? { secondsLeft: seconds, endsAt: new Date(Date.now() + seconds * 1000).toISOString(), endsLabel: "" } : null;
  screen.rerender();
  const text = await screen.act("set_device", { device: id, state, ...(seconds ? { seconds } : {}) });
  pending.delete(id);
  if (text !== null) {
    const summary = (JSON.parse(text) as { summary?: string }).summary ?? `${d.name} ${state}`;
    screen.toast(summary);
    // Tell the assistant, so "is the barn heater on?" right after has the answer.
    screen.tell("switched", { device: d.name, state }, `On the screen: ${summary}.`);
  }
  await screen.refreshNow();
}
