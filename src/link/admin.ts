import type { ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env.ts";

/**
 * Creating and updating Alexa's client. Alexa+ can't register itself (no
 * dynamic registration), so its client is made here once, its id and secret
 * go into `alexa-ai configure-account-linking`, and the redirect addresses
 * Alexa shows then come back here. Only with ADMIN_TOKEN set; otherwise these
 * routes don't exist.
 */
export async function adminRoute(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response | null> {
  const url = new URL(request.url);
  const m = /^\/admin\/clients(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return null;
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return null;
  if (!(await sameSecret(bearer(request), env.ADMIN_TOKEN))) return json(401, { error: "unauthorized" });
  const id = m[1] ? decodeURIComponent(m[1]) : null;

  if (!id && request.method === "POST") {
    const body = await read(request);
    if (!body) return json(400, { error: "Send JSON with redirect_uris." });
    const client = await oauth.createClient({
      clientName: typeof body.name === "string" && body.name ? body.name : "Alexa+",
      redirectUris: body.redirect_uris,
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    // The secret is shown this once; only its hash is kept.
    return json(201, { ...view(client), client_secret: client.clientSecret });
  }
  if (id && request.method === "GET") {
    const client = await oauth.lookupClient(id);
    return client ? json(200, view(client)) : json(404, { error: "No such client." });
  }
  if (id && request.method === "PUT") {
    const body = await read(request);
    if (!body) return json(400, { error: "Send JSON with redirect_uris." });
    const client = await oauth.updateClient(id, { redirectUris: body.redirect_uris });
    return client ? json(200, view(client)) : json(404, { error: "No such client." });
  }
  return json(405, { error: "Method not allowed." });
}

function view(c: ClientInfo) {
  return { client_id: c.clientId, client_name: c.clientName, redirect_uris: c.redirectUris, token_endpoint_auth_method: c.tokenEndpointAuthMethod };
}

async function read(request: Request): Promise<{ name?: unknown; redirect_uris: string[] } | null> {
  const body = (await request.json().catch(() => null)) as { name?: unknown; redirect_uris?: unknown } | null;
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && URL.canParse(u))) return null;
  return { name: body!.name, redirect_uris: uris as string[] };
}

function bearer(request: Request): string {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
}

/** Compares secrets by their hashes, in time that doesn't depend on where they differ. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([hash(given), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0 && given.length > 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
