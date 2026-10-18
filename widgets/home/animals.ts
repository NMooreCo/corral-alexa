import type { MapPin, RanchView } from "../../src/ranch/views.ts";
import { escape, sizeButton } from "../shared/screen.ts";
import type { Home } from "./main.ts";
import { map, weatherLine } from "./ranch.ts";

/**
 * The Animals tab: the property map large, and every collar beside it with
 * where it is, its battery and when it last reported. Anyone outside the
 * fence comes first and stands out, then low batteries, then the rest.
 */

function order(p: MapPin): number {
  return p.outside ? 0 : p.batteryLow ? 1 : 2;
}

function collar(p: MapPin): string {
  const cls = [p.outside ? "outside" : "", p.batteryLow ? "low" : "", p.stale ? "stale" : ""].filter(Boolean).join(" ");
  return `<li class="${cls}">
    <span class="initial" aria-hidden="true">${escape(p.animal.charAt(0))}</span>
    <span class="name">${escape(p.animal)}</span>
    <span class="battery${p.batteryLow ? " low" : ""}" aria-label="Collar battery ${p.battery}%"><span class="cell"><span style="width:${Math.max(4, Math.min(100, p.battery))}%"></span></span>${p.battery}%</span>
    <span class="where">${escape(p.where)} · ${escape(p.lastSeen)}</span>
  </li>`;
}

export function animalsHtml(view: RanchView, home: Home): string {
  const pins = [...view.map.pins].sort((a, b) => order(a) - order(b) || a.animal.localeCompare(b.animal));
  const outside = view.animals.outside.length;
  return `
    <header>
      <div>
        <h1>Animals</h1>
        <p class="household">${escape([`${pins.length} collar${pins.length === 1 ? "" : "s"}`, outside ? `${outside} outside the fence` : "all inside the fence", view.animals.live ? "" : view.animals.feed].filter(Boolean).join(" · "))}</p>
      </div>
      <div class="header-end">
        ${weatherLine(view)}
        ${sizeButton(home.screen)}
      </div>
    </header>
    <div class="animals">
      <section class="map-card big" aria-label="Map">${map(view)}</section>
      <ul class="collars" aria-label="Collars">${pins.map(collar).join("")}</ul>
    </div>`;
}
