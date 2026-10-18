import type { Env } from "../env.ts";
import { json, serveMcp } from "../http.ts";
import { SharedSample } from "./shared.ts";
import { memoryStore } from "./store.ts";
import { SPEAKER_HEADER, speakerOf } from "./roles.ts";

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
const local = new Map<string, SharedSample>();
function localHousehold(id: string): SharedSample {
  let household = local.get(id);
  if (!household) {
    if (local.size >= 32) local.clear();
    local.set(id, (household = new SharedSample(memoryStore())));
  }
  return household;
}

function passcodeOk(request: Request, env: Env): boolean {
  return !env.DEMO_PASSCODE || request.headers.get("x-demo-passcode")?.trim() === env.DEMO_PASSCODE.trim();
}

/**
 * Sample mode's household routes. /mcp goes to the household's Durable
 * Object, which serves MCP from it. /household says its name, day and change
 * counter, and POST /household/reset starts it over (for a fresh demo take),
 * after the demo passcode when the server has one.
 */
export async function householdRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && url.pathname !== "/household" && url.pathname !== "/household/reset") return null;
  const id = householdId(url);
  if (!id) return json(400, { error: { code: "bad_household", message: "A household id is lowercase letters, digits and dashes, up to 40 of them." } });
  const object = env.SAMPLE_HOUSEHOLDS?.getByName(id);

  if (url.pathname === "/mcp") return object ? object.fetch(request) : serveMcp(request, localHousehold(id).as(speakerOf(request.headers.get(SPEAKER_HEADER))));

  if (url.pathname === "/household") {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: { code: "method", message: "GET /household." } }, { allow: "GET, HEAD" });
    const status = object ? await object.status() : localHousehold(id).status();
    return json(200, { household: id, ...status }, { "cache-control": "no-store" });
  }

  if (request.method !== "POST") return json(405, { error: { code: "method", message: "POST /household/reset to start the household over." } }, { allow: "POST" });
  if (!passcodeOk(request, env)) return json(401, { error: { code: "passcode", message: "Enter the demo passcode to start the household over." } });
  const status = object ? await object.reset() : localHousehold(id).reset();
  return json(200, { household: id, ...status });
}
