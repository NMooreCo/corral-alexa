import { createMcpHandler } from "@modelcontextprotocol/server";
import { Temporal } from "temporal-polyfill";
import { CorralHousehold } from "./corral.ts";
import type { Household } from "./household.ts";
import { SampleHousehold } from "./sample/index.ts";
import { SERVER_INFO, buildServer } from "./server.ts";
import { previewHtml } from "./widgets.generated.ts";

export interface Env {
  /** "sample" answers from the built-in sample household; "corral" answers from a real Corral with the caller's own token. */
  BACKEND?: string;
  /** The Corral to reach in corral mode, like https://corral.narralogy.ai. */
  CORRAL_URL?: string;
}

/**
 * The sample household lives as long as this worker instance, so changes made
 * through it stick around for a demo. It starts over when its day changes, to
 * keep its times around today.
 */
let sample: { day: string; household: SampleHousehold } | undefined;

function sampleHousehold(): SampleHousehold {
  const dayOf = (h: SampleHousehold) => Temporal.Now.zonedDateTimeISO(h.state.timeZone).toPlainDate().toString();
  if (!sample || dayOf(sample.household) !== sample.day) {
    const household = new SampleHousehold();
    sample = { day: dayOf(household), household };
  }
  return sample.household;
}

function bearer(request: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1]!.trim() : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const backend = env.BACKEND === "corral" ? "corral" : "sample";
    if (url.pathname === "/" && request.method === "GET") return json(200, { ...SERVER_INFO, mcp: `${url.origin}/mcp`, backend });
    if (url.pathname === "/health") return new Response("ok");
    // The screen preview talks to /mcp from the browser, so it's only for the sample, which needs no credential.
    if (url.pathname === "/preview" && backend === "sample") return new Response(previewHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname !== "/mcp") return json(404, { error: { code: "not_found", message: "Nothing here. The MCP server is at /mcp." } });

    let household: Household;
    if (backend === "corral") {
      // Until account linking is in, the caller brings their own Corral credential and this only carries it.
      const token = bearer(request);
      if (!token) return json(401, { error: { code: "unauthorized", message: "Send your Corral credential as a Bearer token." } });
      if (!env.CORRAL_URL) return json(500, { error: { code: "not_configured", message: "CORRAL_URL isn't set." } });
      household = new CorralHousehold({ baseUrl: env.CORRAL_URL, token });
    } else {
      household = sampleHousehold();
    }

    const handler = createMcpHandler(() => buildServer(household), { onerror: (err) => console.error("mcp:", err.message) });
    return handler.fetch(request);
  },
};
