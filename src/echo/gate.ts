import type { Env } from "../env.ts";
import { json } from "../http.ts";

/** What a gated route says when it stops someone. */
export interface GateWords {
  /** No passcode, or a wrong one. */
  passcode: string;
  /** Over the per-visitor limit. */
  limited: string;
}

/** The simulator's model and voice: said aloud when the model route stops a turn. */
const SIMULATOR: GateWords = {
  passcode: "Enter the demo passcode to talk to the simulator.",
  limited: "That's a lot of questions at once. Give it a minute.",
};

/**
 * The per-visitor limit and the demo passcode, checked before anything that
 * costs money or changes a household. The limit comes first, so every guess at
 * the passcode counts against it, and the passcode is compared in constant time.
 */
export async function demoGate(request: Request, env: Env, limit: RateLimit | undefined, words: GateWords = SIMULATOR): Promise<Response | undefined> {
  if (limit) {
    const { success } = await limit.limit({ key: visitor(request) });
    if (!success) return json(429, { error: { code: "rate_limited", message: words.limited } });
  }
  if (env.DEMO_PASSCODE && !(await samePasscode(request.headers.get("x-demo-passcode") ?? "", env.DEMO_PASSCODE))) {
    return json(401, { error: { code: "passcode", message: words.passcode } });
  }
  return undefined;
}

/** Who's asking, for the per-visitor limits: their address as Cloudflare's edge saw it ("local" under wrangler dev without one). */
function visitor(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

/**
 * Whether a passcode someone gave is the demo's, ignoring stray spaces on
 * either side. Both are hashed and every byte of the two hashes is compared,
 * so how long the check takes says nothing about how much of a guess was
 * right, or how long the passcode is.
 */
export async function samePasscode(given: string, passcode: string): Promise<boolean> {
  const hash = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim())));
  const [a, b] = await Promise.all([hash(given), hash(passcode)]);
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a[i]! ^ b[i]!;
  return differ === 0;
}
