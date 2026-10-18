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

/** The routes every mode has: what this is, and a health check. */
export function siteRoute(request: Request, backend: "sample" | "corral"): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") return json(200, { ...SERVER_INFO, mcp: `${url.origin}/mcp`, backend });
  if (url.pathname === "/health") return new Response("ok");
  return null;
}

export function notFound(): Response {
  return json(404, { error: { code: "not_found", message: "Nothing here. The MCP server is at /mcp." } });
}
