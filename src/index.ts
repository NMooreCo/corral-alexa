import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";
import { json, notFound, siteRoute } from "./http.ts";
import { linkingProvider, protectedResource } from "./link/provider.ts";
import { householdRoute } from "./sample/routes.ts";
import { echoHtml, previewHtml } from "./widgets.generated.ts";
import { mockTurn } from "./echo/mock.ts";
import { echoPage, modelTurn } from "./echo/model.ts";

export type { Env };
// The sample household's Durable Object (sample mode only; corral mode never binds it).
export { SampleHouseholdObject } from "./sample/durable.ts";

/** One OAuth provider per public address (in practice, one). */
const providers = new Map<string, OAuthProvider<Env>>();

/**
 * Alexa+ reads the protected resource metadata from its well-known address
 * and doesn't take a challenge header on a 401 yet, so /mcp answers 401 bare.
 * MCP clients that would read the header find the same metadata by its
 * well-known address instead, as the spec has them do when it's missing.
 */
function withoutChallenge(res: Response): Response {
  if (res.status !== 401 || !res.headers.has("www-authenticate")) return res;
  const headers = new Headers(res.headers);
  headers.delete("www-authenticate");
  return new Response(res.body, { status: 401, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (env.BACKEND === "corral") {
      if (!env.CORRAL_URL || !env.OAUTH_KV) return json(500, { error: { code: "not_configured", message: "Corral mode needs CORRAL_URL and the OAUTH_KV binding." } });
      const base = (env.PUBLIC_URL ?? url.origin).replace(/\/+$/, "");
      if (url.pathname === "/.well-known/oauth-protected-resource" && (request.method === "GET" || request.method === "HEAD")) return protectedResource(base);
      let provider = providers.get(base);
      if (!provider) providers.set(base, (provider = linkingProvider(base)));
      const res = await provider.fetch(request, env, ctx);
      return url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") ? withoutChallenge(res) : res;
    }

    // The sample needs no account and no linking.
    const site = siteRoute(request, "sample");
    if (site) return site;
    // The screen preview and the simulated Echo Show talk to /mcp from the browser, which the sample allows without a credential.
    const page = (html: string) => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/preview") return page(previewHtml);
    if (url.pathname === "/echo" && request.method === "GET") return page(echoPage(echoHtml, env));
    if (url.pathname === "/echo/model" && request.method === "POST") return env.MODEL_MOCK === "true" ? mockTurn(request) : modelTurn(request, env);
    // /mcp and the household's own routes, through the household's Durable Object.
    const household = await householdRoute(request, env);
    if (household) return household;
    return notFound();
  },
};
