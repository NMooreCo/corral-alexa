import type { Env } from "../env.ts";
import { json, serveMcp } from "../http.ts";
import { demoGate, type GateWords } from "../echo/gate.ts";
import { SharedSample } from "./shared.ts";
import { memoryStore } from "./store.ts";
import { SampleRanchHolder } from "./ranch.ts";
import { SPEAKER_HEADER, speakerOf } from "./roles.ts";
import { HouseholdClock } from "../clock.ts";
import { CLOCK_MODES, clockStatus, setSampleClock, type ClockMode } from "./durable.ts";

/** The household everyone shares unless a request names another with ?household=. */
export const DEFAULT_HOUSEHOLD = "demo";

/** ?household=, or the default; null when it isn't a household id (lowercase letters, digits and dashes, up to 40). */
export function householdId(url: URL): string | null {
  const id = url.searchParams.get("household")?.trim().toLowerCase() || DEFAULT_HOUSEHOLD;
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) ? id : null;
}

/**
 * With no SAMPLE_HOUSEHOLDS binding (a test that makes its own Env, or a
 * config without it), each household lives as long as this isolate, as the
 * sample did before it had a Durable Object.
 */
interface LocalSample {
  household: SharedSample;
  ranch: SampleRanchHolder;
  clock: HouseholdClock;
}
const local = new Map<string, LocalSample>();
function localSample(id: string): LocalSample {
  let sample = local.get(id);
  if (!sample) {
    if (local.size >= 32) local.clear();
    const clock = new HouseholdClock();
    local.set(id, (sample = { household: new SharedSample(memoryStore(), { now: clock.now }), ranch: new SampleRanchHolder(), clock }));
  }
  return sample;
}
const localHousehold = (id: string): SharedSample => localSample(id).household;

/** What the household's own changes say when the gate stops them. */
const LIMITED = "That's a lot of changes to the household at once. Give it a minute.";
const CLOCK_GATE: GateWords = { passcode: "Enter the demo passcode to set the household's clock.", limited: LIMITED };
const RESET_GATE: GateWords = { passcode: "Enter the demo passcode to start the household over.", limited: LIMITED };

/**
 * Sample mode's household routes. /mcp goes to the household's Durable
 * Object, which serves MCP from it. /household says its name, day, change
 * counter and clock. POST /household/reset starts it over (for a fresh demo
 * take), and POST /household/clock with {"mode": "evening"} or "now" sets its
 * clock and starts it over at that hour, both after the per-visitor limit
 * and the demo passcode when the server has them.
 */
export async function householdRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && url.pathname !== "/household" && url.pathname !== "/household/reset" && url.pathname !== "/household/clock") return null;
  const id = householdId(url);
  if (!id) return json(400, { error: { code: "bad_household", message: "A household id is lowercase letters, digits and dashes, up to 40 of them." } });
  const object = env.SAMPLE_HOUSEHOLDS?.getByName(id);

  if (url.pathname === "/mcp") {
    if (object) return object.fetch(request);
    const { household, ranch, clock } = localSample(id);
    const { timeZone } = await household.about();
    return serveMcp(request, household.as(speakerOf(request.headers.get(SPEAKER_HEADER))), ranch.ranchFor(env, request.url, timeZone, clock.now));
  }

  if (url.pathname === "/household") {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: { code: "method", message: "GET /household." } }, { allow: "GET, HEAD" });
    const status = object ? await object.status() : { ...localHousehold(id).status(), clock: clockStatus(localSample(id).clock, (await localHousehold(id).about()).timeZone) };
    return json(200, { household: id, ...status }, { "cache-control": "no-store" });
  }

  if (url.pathname === "/household/clock") {
    if (request.method !== "POST") return json(405, { error: { code: "method", message: 'POST /household/clock with {"mode": "evening"}, {"mode": "morning"} or {"mode": "now"}.' } }, { allow: "POST" });
    const stopped = await demoGate(request, env, env.HOUSEHOLD_LIMIT, CLOCK_GATE);
    if (stopped) return stopped;
    const body = (await request.json().catch(() => null)) as { mode?: unknown } | null;
    if (!CLOCK_MODES.includes(body?.mode as ClockMode)) return json(400, { error: { code: "mode", message: 'The mode is "evening", "morning" or "now".' } });
    const mode = body!.mode as ClockMode;
    if (object) return json(200, { household: id, ...(await object.setClock(mode)) });
    const sample = localSample(id);
    const { timeZone } = await sample.household.about();
    setSampleClock(mode, sample, timeZone ?? "UTC");
    return json(200, { household: id, ...sample.household.status(), clock: clockStatus(sample.clock, timeZone) });
  }

  if (request.method !== "POST") return json(405, { error: { code: "method", message: "POST /household/reset to start the household over." } }, { allow: "POST" });
  const stopped = await demoGate(request, env, env.HOUSEHOLD_LIMIT, RESET_GATE);
  if (stopped) return stopped;
  if (!object) localSample(id).ranch.reset();
  const status = object ? await object.reset() : localHousehold(id).reset();
  return json(200, { household: id, ...status });
}
