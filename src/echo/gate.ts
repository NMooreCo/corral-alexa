import type { Env } from "../env.ts";
import { json } from "../http.ts";

/** The demo passcode and a per-visitor limit, checked before anything that costs money. */
export async function demoGate(request: Request, env: Env, limit: RateLimit | undefined): Promise<Response | undefined> {
  if (env.DEMO_PASSCODE && request.headers.get("x-demo-passcode")?.trim() !== env.DEMO_PASSCODE.trim()) {
    return json(401, { error: { code: "passcode", message: "Enter the demo passcode to talk to the simulator." } });
  }
  if (limit) {
    const who = request.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await limit.limit({ key: who });
    if (!success) return json(429, { error: { code: "rate_limited", message: "That's a lot of questions at once. Give it a minute." } });
  }
  return undefined;
}
