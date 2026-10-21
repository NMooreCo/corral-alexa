import { startSimulator } from "alexa-plus-simulator/ui";
import "alexa-plus-simulator/ui/style.css";
import "./style.css";
import { corral, type DemoPart } from "./corral.ts";
import { visitorHousehold } from "./household.ts";

/**
 * A simulated Alexa+ on an Echo Show: the open Alexa+ simulator, with Corral's
 * extension (corral.ts). The simulator is the MCP client of this server's
 * /mcp; the model behind /echo/model only decides what to say or which tool
 * to call next.
 *
 * /echo is an Echo Show 8 in the kitchen. ?show=5, ?show=8 or ?show=dot picks
 * the device (an Echo Dot has no screen, so everything has to work by voice).
 * /echo?devices=2 puts two of these pages side by side on one household, each
 * with ?embed=1 and a place (?place=Barn&show=5). ?household= names a sample
 * household other than this visitor's own.
 */

const params = new URLSearchParams(location.search);
const SHOWS: Record<string, string> = { "5": "show-5", "8": "show-8", dot: "dot" };
const place = (params.get("place") ?? "").trim().slice(0, 40);
const embedded = params.get("embed") === "1";
// This visitor's own household unless the link names one (see household.ts).
const household = visitorHousehold();
const body = document.body.dataset;
const modelPlace = body.model ?? "Claude";

const { extension, playDemo } = corral({
  household,
  place,
  embedded,
  passcodeRequired: body.passcode === "required",
  polly: body.voice === "polly",
});

const mcpUrl = new URL("/mcp", location.origin);
mcpUrl.searchParams.set("household", household);

const sim = await startSimulator({
  root: document.getElementById("app")!,
  mcpUrl: mcpUrl.toString(),
  modelUrl: "/echo/model",
  modelLabel: modelPlace,
  // The open simulator's readiness check, run from the visitor's browser against this server.
  check: embedded ? false : "browser",
  ...(SHOWS[params.get("show") ?? ""] ? { device: SHOWS[params.get("show")!] } : {}),
  home: { tool: "show_today" },
  title: "Corral for Alexa+",
  lede: "Ask about the Juniper Hollow household: the calendar, chores, lists, who's where, points and supplies. Tap the screen to check chores off.",
  deviceNote: (d) =>
    `A simulated Alexa+ on an ${d.name}${d.surface === "none" ? ", with no screen" : ""}. This page is the open-source Alexa+ simulator with Corral's extension, a real MCP client of this server; ${modelPlace} decides what to do${body.voiced ?? ""}.`,
  compact: embedded,
  ...(embedded ? { place: place || "Kitchen" } : {}),
  // The screens' change counter and the alerts are asked every few seconds; only a failure is news.
  quietTools: ["household_version", "alerts"],
  extensions: [extension],
});

document.title = embedded ? `${place || "Kitchen"} ${sim.device.name}: Corral for Alexa+` : `Corral for Alexa+: simulated ${sim.device.name}`;

// /echo?demo=1 plays the demo on its own, for recording a take; ?demo=short plays only its headline beats.
const take = params.get("demo");
if ((take === "1" || take === "short") && !embedded) {
  sim.caption("", "Starting the demo...");
  await new Promise((r) => setTimeout(r, 3000));
  const part = params.get("part");
  void playDemo(take === "short", part === "evening" || part === "morning" ? (part as DemoPart) : "all", params.has("taps"));
}
