import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Household } from "./household.ts";
import type { Ranch } from "./ranch/index.ts";
import { SERVER_INFO, buildServer } from "./server.ts";

/** Serves one MCP request (either protocol era) from `household`, and its ranch when it has one. */
export function serveMcp(request: Request, household: Household, ranch?: Ranch): Promise<Response> {
  return createMcpHandler(() => buildServer(household, ranch), { onerror: (err) => console.error("mcp:", err.message) }).fetch(request);
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * The routes every mode has: what this is, and a health check. In sample
 * mode a browser that opens the address itself (the demo's, as the video
 * shows it) goes on to the simulated Echo Show; anything else asking for
 * the address gets what this is, as JSON.
 */
export function siteRoute(request: Request, backend: "sample" | "corral"): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    // The answer depends on Accept, so a cache keeps the two apart.
    if (backend === "sample" && /\btext\/html\b/i.test(request.headers.get("accept") ?? "")) {
      return new Response(null, { status: 302, headers: { location: new URL(`/echo${url.search}`, url).toString(), vary: "accept" } });
    }
    return json(200, { ...SERVER_INFO, mcp: `${url.origin}/mcp`, backend }, { vary: "accept" });
  }
  if (url.pathname === "/health") return new Response("ok");
  return null;
}

export function notFound(): Response {
  return json(404, { error: { code: "not_found", message: "Nothing here. The MCP server is at /mcp." } });
}
