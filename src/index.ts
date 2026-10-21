import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";
import { htmlPage, json, notFound, siteRoute } from "./http.ts";
import { linkingProvider, protectedResource } from "./link/provider.ts";
import { householdRoute } from "./sample/routes.ts";
import { echoHtml, echoPairHtml, previewHtml } from "./widgets.generated.ts";
import { mockTurn } from "./echo/mock.ts";
import { echoPage, modelTurn } from "./echo/model.ts";
import { voiceTurn } from "./echo/voice.ts";
import { shiftClock } from "./clock.ts";

export type { Env };
// The sample household's Durable Object (sample mode only; corral mode never binds it).
export { SampleHouseholdObject } from "./sample/durable.ts";

/** One OAuth provider per public address (in practice, one). */
const providers = new Map<string, OAuthProvider<Env>>();

/**
 * Alexa+ reads the protected resource metadata from its well-known address
 * and a challenge header on a 401 breaks its account linking, so /mcp answers 401 bare.
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
    if (env.BACKEND !== "corral") shiftClock(env.CLOCK_SHIFT_MINUTES);

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
    if (url.pathname === "/preview") return htmlPage(previewHtml);
    // /echo?devices=2 is two Echo Shows, a kitchen's and a barn's, on one shared household: it frames /echo twice, from this origin.
    if (url.pathname === "/echo" && request.method === "GET") return htmlPage(echoPage(url.searchParams.get("devices") === "2" ? echoPairHtml : echoHtml, env));
    if (url.pathname === "/echo/model" && request.method === "POST") return env.MODEL_MOCK === "true" ? mockTurn(request) : modelTurn(request, env);
    // The simulator's voice: Amazon Polly says each answer when it's set up.
    if (url.pathname === "/echo/voice" && request.method === "POST") return voiceTurn(request, env);
    // /mcp and the household's own routes, through the household's Durable Object. There's no sign-in here,
    // so the simulator says who Alexa recognized in a header the household reads per request.
    const household = await householdRoute(request, env);
    if (household) return household;
    return notFound();
  },
};
