import { AuthorizationError, OAuthError, OAuthProvider, authorizationErrorRedirect, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { CorralHousehold } from "../corral.ts";
import type { Env } from "../env.ts";
import { json, notFound, serveMcp, siteRoute } from "../http.ts";
import { adminRoute } from "./admin.ts";
import { messagePage } from "./pages.ts";
import { CORRAL_SCOPES, CorralTokenError, corralAuthorizeUrl, corralClient, corralServer, exchangeCorralCode, pkce, refreshCorralTokens, type CorralTokens } from "./upstream.ts";

/**
 * Account linking for Alexa+, which is OAuth 2.1 with PKCE: this server is
 * the authorization server Alexa talks to, and Corral is where people sign in.
 *
 * Alexa sends the person to /authorize; this server hands them straight to
 * Corral's consent page, where they sign in, pick their household and what to
 * allow; Corral sends them back to /callback, and this server finishes with
 * Alexa. Corral's tokens stay inside the grant, encrypted, and every MCP call
 * goes to Corral with them, so Corral keeps deciding who sees and does what.
 *
 * Alexa can't register itself, so its client is made once through
 * /admin/clients and no one else can register. With no other client to guard
 * against, there's no consent page here: Corral's is the one people see.
 */

/** What a grant keeps: the person's Corral tokens. */
export interface LinkProps {
  corral: CorralTokens;
}

const DAY = 24 * 60 * 60;

/** This server's token for Alexa lasts as long as the Corral token behind it, so Alexa refreshes both together. */
function ttl(expiresAt: number | undefined): number {
  if (!expiresAt) return 3600;
  return Math.min(3600, Math.max(60, expiresAt - Math.floor(Date.now() / 1000) - 60));
}

function scopesFor(request: AuthRequest): string[] {
  const asked = request.scope.filter((s) => (CORRAL_SCOPES as readonly string[]).includes(s));
  return asked.length ? asked : [...CORRAL_SCOPES];
}

function redirect(location: string, headers = new Headers()): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

export function linkingProvider(base: string): OAuthProvider<Env> {
  const resource = `${base}/mcp`;
  const callback = `${base}/callback`;

  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const { corral } = (ctx as unknown as { props: LinkProps }).props;
        // The Corral token behind this one has run out: a bare 401 sends Alexa to refresh both.
        if (corral.expiresAt && corral.expiresAt <= Math.floor(Date.now() / 1000)) return json(401, { error: "invalid_token", error_description: "Expired." });
        return serveMcp(request, new CorralHousehold({ baseUrl: env.CORRAL_URL!, token: corral.accessToken }));
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        const url = new URL(request.url);
        const oauth = env.OAUTH_PROVIDER!;
        if (url.pathname === "/authorize") return authorize(request, env, callback);
        if (url.pathname === "/callback") return finish(request, env, callback);
        return (await adminRoute(request, env, oauth)) ?? siteRoute(request, "corral") ?? notFound();
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    scopesSupported: [...CORRAL_SCOPES],
    // Alexa asks for what this lists, all at once: it doesn't come back for more later.
    requiredScopes: [...CORRAL_SCOPES],
    resourceMetadata: { resource, authorization_servers: [base], bearer_methods_supported: ["header"], resource_name: "Corral" },
    // A link lives while it's used, like Corral's own connections, which end after 30 idle days.
    refreshTokenTTL: 30 * DAY,
    refreshTokenIdleTTL: 30 * DAY,
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      const { corral } = props as LinkProps;
      if (grantType === "authorization_code") return { accessTokenTTL: ttl(corral.expiresAt) };
      if (grantType !== "refresh_token") return;
      if (!corral.refreshToken) throw new OAuthError("invalid_grant", { description: "Corral's sign-in can't be renewed. Link the account again." });
      const server = await corralServer(env.CORRAL_URL!);
      let fresh: CorralTokens;
      try {
        fresh = await refreshCorralTokens(server, await corralClient(env, server, callback), corral.refreshToken);
      } catch (err) {
        // Revoked or gone for good ends this link; anything else is worth a retry.
        if (err instanceof CorralTokenError && (err.code === "invalid_grant" || err.status === 401)) {
          throw new OAuthError("invalid_grant", { description: "Corral access ended. Link the account again." });
        }
        throw new OAuthError("temporarily_unavailable", { description: "Corral didn't answer. Try again shortly.", statusCode: 503 });
      }
      const next: LinkProps = { corral: { ...fresh, refreshToken: fresh.refreshToken ?? corral.refreshToken, scope: fresh.scope.length ? fresh.scope : corral.scope } };
      return { newProps: next, accessTokenTTL: ttl(fresh.expiresAt) };
    },
    // Only while building, and only when turned on: a script can use a Corral personal access token directly.
    resolveExternalToken: async ({ token, env }) =>
      env.ACCEPT_CORRAL_TOKENS === "true" && token.startsWith("crl_pat_") ? { props: { corral: { accessToken: token, scope: [] } } satisfies LinkProps, audience: resource } : null,
    onError: ({ code, description, status }) => {
      if (status >= 500) console.error(`oauth: ${code}: ${description}`);
    },
  });
}

/**
 * RFC 9728 metadata at the root, where Alexa+ looks for it. The provider
 * serves it only under /mcp (where MCP clients look) and answers 404 here,
 * so this is answered before the provider sees the request.
 */
export function protectedResource(base: string): Response {
  return json(
    200,
    { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [...CORRAL_SCOPES], bearer_methods_supported: ["header"], resource_name: "Corral" },
    { "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
  );
}

async function authorize(request: Request, env: Env, callback: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER!;
  let auth: AuthRequest;
  try {
    auth = await oauth.parseAuthRequest(request);
  } catch (err) {
    if (!(err instanceof AuthorizationError)) throw err;
    // Back to the client only once its redirect address is known to be its own.
    return err.redirectTo ? redirect(err.redirectTo) : messagePage(400, "This link can't be used", err.description);
  }
  try {
    const server = await corralServer(env.CORRAL_URL!);
    const client = await corralClient(env, server, callback);
    const { verifier, challenge } = await pkce();
    const { state, headers } = await oauth.beginUpstream(auth, { data: { verifier } });
    return redirect(corralAuthorizeUrl(server, client, { state, codeChallenge: challenge, scope: scopesFor(auth) }), headers);
  } catch (err) {
    console.error("link: couldn't start Corral's sign-in:", err instanceof Error ? err.message : err);
    return redirect(authorizationErrorRedirect(auth, "temporarily_unavailable", "Corral's sign-in isn't reachable just now."));
  }
}

async function finish(request: Request, env: Env, callback: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER!;
  let resumed: Awaited<ReturnType<typeof oauth.finishUpstream<{ verifier: string }>>>;
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  } catch {
    return messagePage(400, "This sign-in has run out", "Start linking again from the Alexa app. Signing in has to finish in the same browser, within ten minutes.");
  }
  const { request: original, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  const decline = (code: "access_denied" | "server_error" | "temporarily_unavailable", why?: string) => redirect(authorizationErrorRedirect(original, code, why), headers);

  const said = params.get("error");
  if (said) return decline(said === "access_denied" ? "access_denied" : "server_error");
  const code = params.get("code");
  if (!code) return decline("server_error", "Corral sent no code back.");

  let tokens: CorralTokens;
  try {
    const server = await corralServer(env.CORRAL_URL!);
    tokens = await exchangeCorralCode(server, await corralClient(env, server, callback), code, data.verifier);
  } catch (err) {
    console.error("link: Corral's code didn't exchange:", err instanceof Error ? err.message : err);
    return decline(err instanceof CorralTokenError && err.status < 500 ? "access_denied" : "temporarily_unavailable");
  }
  // What Corral granted (the person may have unticked some), else what was asked.
  const granted = tokens.scope.filter((s) => (CORRAL_SCOPES as readonly string[]).includes(s));
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    // Corral doesn't say who signed in; each link is its own, and Corral replaces an app's earlier connection itself.
    userId: `link-${crypto.randomUUID()}`,
    metadata: { linkedAt: new Date().toISOString() },
    scope: granted.length ? granted : scopesFor(original),
    props: { corral: tokens } satisfies LinkProps,
  });
  return redirect(redirectTo, headers);
}
