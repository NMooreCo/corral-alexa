import type { Env } from "../env.ts";

/**
 * Corral as the place people sign in. This server is an ordinary OAuth client
 * of Corral: it sends the person to Corral's consent page, where they sign in,
 * pick their household and what to allow, and it keeps the tokens Corral
 * gives back. Corral checks every later call against what that person allowed.
 */

/** What Corral lets an app ask for, and all this server's tools need. */
export const CORRAL_SCOPES = [
  "calendar:read",
  "calendar:write",
  "tasks:read",
  "tasks:write",
  "tasks:complete",
  "lists:read",
  "lists:write",
  "records:read",
  "records:write",
  "whereabouts:read",
] as const;

export interface CorralServer {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** Corral's MCP server, which its tokens are bound to. */
  resource: string;
}

export interface CorralClient {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** Corral's tokens, kept encrypted in the grant. `expiresAt` is in epoch seconds. */
export interface CorralTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope: string[];
}

/** Corral turned a token request down. `code` is its OAuth error, like invalid_grant. */
export class CorralTokenError extends Error {
  override name = "CorralTokenError";
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Corral refused the token request: ${code} (${status})`);
  }
}

type Fetch = typeof fetch;

const discovered = new Map<string, CorralServer>();

/**
 * Corral's OAuth endpoints, from its authorization server metadata. Only
 * endpoints on Corral's own origin are taken, so a client secret never goes
 * anywhere else; if the metadata can't be read, Corral's usual paths are used.
 */
export async function corralServer(corralUrl: string, fetchImpl: Fetch = fetch): Promise<CorralServer> {
  const base = corralUrl.replace(/\/+$/, "");
  const known = discovered.get(base);
  if (known) return known;
  const fallback: CorralServer = { authorizationEndpoint: `${base}/oauth/authorize`, tokenEndpoint: `${base}/oauth/token`, registrationEndpoint: `${base}/oauth/register`, resource: `${base}/mcp` };
  const origin = new URL(base).origin;
  const ours = (v: unknown) => (typeof v === "string" && URL.canParse(v) && new URL(v).origin === origin ? v : undefined);
  try {
    const res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
    if (!res.ok) return fallback;
    const meta = (await res.json()) as Record<string, unknown>;
    const server: CorralServer = {
      authorizationEndpoint: ours(meta.authorization_endpoint) ?? fallback.authorizationEndpoint,
      tokenEndpoint: ours(meta.token_endpoint) ?? fallback.tokenEndpoint,
      registrationEndpoint: ours(meta.registration_endpoint),
      resource: fallback.resource,
    };
    discovered.set(base, server);
    return server;
  } catch {
    return fallback;
  }
}

/** Forgets what was discovered, for tests. */
export function forgetCorralServers(): void {
  discovered.clear();
}

const CLIENT_KEY = "corral-alexa:corral-client";

/**
 * This server's client at Corral: the one configured, else the one it
 * registered with Corral before (for this callback address), else a new
 * registration, kept for next time.
 */
export async function corralClient(env: Env, server: CorralServer, redirectUri: string, fetchImpl: Fetch = fetch): Promise<CorralClient> {
  if (env.CORRAL_CLIENT_ID) return { clientId: env.CORRAL_CLIENT_ID, clientSecret: env.CORRAL_CLIENT_SECRET, redirectUri };
  const kv = env.OAUTH_KV!;
  const kept = await kv.get<CorralClient & { registrationEndpoint: string }>(CLIENT_KEY, "json");
  if (kept && kept.redirectUri === redirectUri && kept.registrationEndpoint === server.registrationEndpoint) return kept;
  if (!server.registrationEndpoint) throw new Error("Corral takes no app registrations here; set CORRAL_CLIENT_ID and CORRAL_CLIENT_SECRET.");
  const res = await fetchImpl(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Corral for Alexa+",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    }),
  });
  if (!res.ok) throw new Error(`Corral didn't register this server (${res.status}).`);
  const reg = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!reg.client_id) throw new Error("Corral's registration answer had no client_id.");
  const client = { clientId: reg.client_id, clientSecret: reg.client_secret, redirectUri, registrationEndpoint: server.registrationEndpoint };
  await kv.put(CLIENT_KEY, JSON.stringify(client));
  return client;
}

/** Where to send the person to sign in at Corral. */
export function corralAuthorizeUrl(server: CorralServer, client: CorralClient, opts: { state: string; codeChallenge: string; scope: readonly string[] }): string {
  const url = new URL(server.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    scope: opts.scope.join(" "),
    resource: server.resource,
  }).toString();
  return url.toString();
}

export function exchangeCorralCode(server: CorralServer, client: CorralClient, code: string, codeVerifier: string, fetchImpl: Fetch = fetch): Promise<CorralTokens> {
  return tokenRequest(server, client, { grant_type: "authorization_code", code, redirect_uri: client.redirectUri, code_verifier: codeVerifier, resource: server.resource }, fetchImpl);
}

export function refreshCorralTokens(server: CorralServer, client: CorralClient, refreshToken: string, fetchImpl: Fetch = fetch): Promise<CorralTokens> {
  return tokenRequest(server, client, { grant_type: "refresh_token", refresh_token: refreshToken, resource: server.resource }, fetchImpl);
}

async function tokenRequest(server: CorralServer, client: CorralClient, params: Record<string, string>, fetchImpl: Fetch): Promise<CorralTokens> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const body = new URLSearchParams(params);
  if (client.clientSecret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  else body.set("client_id", client.clientId);
  const res = await fetchImpl(server.tokenEndpoint, { method: "POST", headers, body });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!res.ok || !json.access_token) throw new CorralTokenError(json.error ?? "server_error", res.status);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: typeof json.expires_in === "number" ? Math.floor(Date.now() / 1000) + json.expires_in : undefined,
    scope: typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [],
  };
}

/** A PKCE pair: the verifier kept here, the S256 challenge sent to Corral. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
