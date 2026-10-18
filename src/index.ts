import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Temporal } from "temporal-polyfill";
import type { Env } from "./env.ts";
import { json, notFound, serveMcp, siteRoute } from "./http.ts";
import { linkingProvider, protectedResource } from "./link/provider.ts";
import { localGreenhouse, type Ranch } from "./ranch/index.ts";
import { SampleHousehold } from "./sample/index.ts";
import { sampleRanch } from "./sample/ranch.ts";
import { echoHtml, previewHtml } from "./widgets.generated.ts";
import { mockTurn } from "./echo/mock.ts";
import { echoPage, modelTurn } from "./echo/model.ts";

export type { Env };

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

/**
 * The sample household's ranch, kept like the household so a run started on
 * the misters is still counting down on the next call. Under `pnpm dev:lan`
 * its greenhouse is the real controller on the LAN instead of the simulated one.
 */
let ranch: { key: string; ranch: Ranch } | undefined;

function sampleRanchFor(env: Env, request: Request, timeZone: string): Ranch {
  const greenhouse = localGreenhouse(env, request.url);
  const key = JSON.stringify([timeZone, greenhouse]);
  if (!ranch || ranch.key !== key) ranch = { key, ranch: sampleRanch({ timeZone, ...(greenhouse ? { greenhouse } : {}) }) };
  return ranch.ranch;
}

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
    if (url.pathname === "/mcp") {
      const household = sampleHousehold();
      return serveMcp(request, household, sampleRanchFor(env, request, household.state.timeZone));
    }
    return notFound();
  },
};
