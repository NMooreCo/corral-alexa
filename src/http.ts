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
 * What every HTML page this server sends says about itself: it's HTML and
 * nothing else, it sends no address on to other sites (a simulator's address
 * names its household), and only this server's own pages may frame it, as
 * the two-device page frames the simulator.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
  "content-security-policy": "frame-ancestors 'self'",
};

/** An HTML page, with PAGE_HEADERS. */
export function htmlPage(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS } });
}

/** Crawlers have nothing to read here: an MCP server, its sign-in and a demo that costs money to run. */
const ROBOTS = "User-agent: *\nDisallow: /\n";

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
  if (url.pathname === "/robots.txt" && (request.method === "GET" || request.method === "HEAD")) return new Response(ROBOTS, { headers: { "content-type": "text/plain; charset=utf-8" } });
  return null;
}

export function notFound(): Response {
  return json(404, { error: { code: "not_found", message: "Nothing here. The MCP server is at /mcp." } });
}
