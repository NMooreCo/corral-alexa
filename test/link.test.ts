import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { CORRAL_SCOPES, forgetCorralServers, pkce } from "../src/link/upstream.ts";
import { MemoryKV } from "./memory-kv.ts";

const BRIDGE = "https://bridge.example";
const CORRAL = "https://corral.example";
const ALEXA_REDIRECT = "https://alexa.amazon.com/api/skill/link/M3TEST";
const ADMIN_TOKEN = "admin-secret-that-is-long-enough";

let kv: MemoryKV;
let env: Env;
let pending: Promise<unknown>[];
let corral: FakeCorral;

/** Calls this worker, then lets anything it left running finish. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${BRIDGE}${path}`, init), env, ctx);
  await Promise.all(pending.splice(0));
  return res;
}

/**
 * Just enough of Corral: its OAuth metadata, app registration, token
 * endpoint (checking the client, PKCE and refresh tokens) and its MCP server
 * (recording which token each call carried).
 */
class FakeCorral {
  registrations = 0;
  challenge = "";
  mcpTokens: string[] = [];
  tokenRequests: URLSearchParams[] = [];
  refreshAnswer: "ok" | "revoked" = "ok";
  mcpAnswer: "ok" | "refused" | "unauthorized" = "ok";
  granted = "calendar:read tasks:read";

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== CORRAL) throw new Error(`Unexpected call to ${req.url}`);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ issuer: CORRAL, authorization_endpoint: `${CORRAL}/oauth/authorize`, token_endpoint: `${CORRAL}/oauth/token`, registration_endpoint: `${CORRAL}/oauth/register`, code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/oauth/register") {
      this.registrations++;
      const body = (await req.json()) as { redirect_uris: string[] };
      expect(body.redirect_uris).toEqual([`${BRIDGE}/callback`]);
      return Response.json({ client_id: "corral-client", client_secret: "corral-secret" }, { status: 201 });
    }
    if (url.pathname === "/oauth/token") {
      expect(req.headers.get("authorization")).toBe(`Basic ${btoa("corral-client:corral-secret")}`);
      const form = new URLSearchParams(await req.text());
      this.tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")));
        const s256 = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (form.get("code") !== "corral-code" || s256 !== this.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "corral-access-1", refresh_token: "corral-refresh-1", token_type: "Bearer", expires_in: 3600, scope: this.granted });
      }
      if (this.refreshAnswer === "revoked") return Response.json({ error: "invalid_grant" }, { status: 400 });
      const n = Number(form.get("refresh_token")!.split("-").at(-1)) + 1;
      return Response.json({ access_token: `corral-access-${n}`, refresh_token: `corral-refresh-${n}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      this.mcpTokens.push(req.headers.get("authorization") ?? "");
      const rpc = (await req.clone().json()) as { method?: string };
      // What Corral's MCP server says about the household, read once for names and the time zone.
      if (rpc.method === "server/discover") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", instructions: "Corral runs the Test household: its calendar, chores and tasks. The household's time zone is America/Denver; it's now 2026-10-16T10:30-06:00[America/Denver]." } });
      }
      if (this.mcpAnswer === "unauthorized") return new Response("", { status: 401 });
      if (this.mcpAnswer === "refused") return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [{ type: "text", text: "This person can't see lists." }], isError: true } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [{ type: "text", text: JSON.stringify(["Groceries"]) }], isError: false } });
    }
    return new Response("Not found", { status: 404 });
  };
}

beforeEach(() => {
  kv = new MemoryKV();
  pending = [];
  corral = new FakeCorral();
  env = { BACKEND: "corral", CORRAL_URL: CORRAL, OAUTH_KV: kv as unknown as KVNamespace, ADMIN_TOKEN };
  forgetCorralServers();
  vi.stubGlobal("fetch", corral.fetch);
});

afterEach(() => vi.unstubAllGlobals());

async function alexaClient(redirectUris = [ALEXA_REDIRECT]) {
  const res = await call("/admin/clients", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Alexa+", redirect_uris: redirectUris }) });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret: string };
}

/** Alexa's side of linking, through to its tokens. */
async function link(opts: { scope?: string } = {}) {
  const client = await alexaClient();
  const alexa = await pkce();
  const authorize = await call(
    `/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: ALEXA_REDIRECT,
      state: "alexa-state",
      code_challenge: alexa.challenge,
      code_challenge_method: "S256",
      scope: opts.scope ?? "openid calendar:read tasks:read",
      resource: `${BRIDGE}/mcp`,
    })}`,
  );
  expect(authorize.status).toBe(302);
  const toCorral = new URL(authorize.headers.get("location")!);
  corral.challenge = toCorral.searchParams.get("code_challenge")!;
  const cookie = authorize.headers.get("set-cookie")!.split(";")[0]!;

  const back = await call(`/callback?${new URLSearchParams({ code: "corral-code", state: toCorral.searchParams.get("state")! })}`, { headers: { cookie } });
  expect(back.status).toBe(302);
  const toAlexa = new URL(back.headers.get("location")!);

  const token = await call("/token", {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: toAlexa.searchParams.get("code")!, redirect_uri: ALEXA_REDIRECT, code_verifier: alexa.verifier, resource: `${BRIDGE}/mcp` }),
  });
  const tokens = (await token.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  return { client, alexa, authorize, toCorral, cookie, back, toAlexa, token, tokens };
}

async function listTool(accessToken: string) {
  return call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lists", arguments: {} } }),
  });
}

describe("discovery, the way Alexa+ reads it", () => {
  it("serves protected resource metadata at the root, naming /mcp, this server and every scope", async () => {
    const res = await call("/.well-known/oauth-protected-resource");
    expect(await res.json()).toEqual({ resource: `${BRIDGE}/mcp`, authorization_servers: [BRIDGE], scopes_supported: [...CORRAL_SCOPES], bearer_methods_supported: ["header"], resource_name: "Corral" });
  });

  it("serves the same metadata where MCP clients look, under /mcp", async () => {
    const res = await call("/.well-known/oauth-protected-resource/mcp");
    expect(await res.json()).toMatchObject({ resource: `${BRIDGE}/mcp`, authorization_servers: [BRIDGE] });
  });

  it("advertises PKCE with S256 and no dynamic registration", async () => {
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ issuer: BRIDGE, authorization_endpoint: `${BRIDGE}/authorize`, token_endpoint: `${BRIDGE}/token` });
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.registration_endpoint).toBeUndefined();
  });

  it("answers an unlinked call with a bare 401, no challenge header", async () => {
    const res = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.has("www-authenticate")).toBe(false);
  });
});

describe("linking an Alexa account to Corral", () => {
  it("sends the person to Corral's sign-in as this server's own client, with PKCE and Corral's resource", async () => {
    const { toCorral, authorize } = await link();
    expect(toCorral.origin + toCorral.pathname).toBe(`${CORRAL}/oauth/authorize`);
    expect(Object.fromEntries(toCorral.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "corral-client",
      redirect_uri: `${BRIDGE}/callback`,
      code_challenge_method: "S256",
      // What Alexa asked for that Corral knows; "openid" isn't one.
      scope: "calendar:read tasks:read",
      resource: `${CORRAL}/mcp`,
    });
    expect(authorize.headers.get("set-cookie")).toMatch(/^__Host-/);
  });

  it("finishes with Alexa: its code and state back, then tokens with a refresh token, lasting as long as Corral's", async () => {
    const { toAlexa, token, tokens } = await link();
    expect(toAlexa.origin + toAlexa.pathname).toBe(ALEXA_REDIRECT);
    expect(toAlexa.searchParams.get("state")).toBe("alexa-state");
    expect(toAlexa.searchParams.get("iss")).toBe(BRIDGE);
    expect(token.status).toBe(200);
    expect(tokens.refresh_token).toEqual(expect.any(String));
    expect(tokens.expires_in).toBeGreaterThan(3400);
    expect(tokens.expires_in).toBeLessThanOrEqual(3540);
    expect(tokens.scope.split(" ").sort()).toEqual(["calendar:read", "tasks:read"]);
  });

  it("registers with Corral once and keeps that registration", async () => {
    await link();
    await link();
    expect(corral.registrations).toBe(1);
  });

  it("calls Corral with the person's Corral token, never Alexa's", async () => {
    const { tokens } = await link();
    const res = await listTool(tokens.access_token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Groceries");
    expect(corral.mcpTokens.length).toBeGreaterThan(0);
    expect(corral.mcpTokens.every((t) => t === "Bearer corral-access-1")).toBe(true);
  });

  it("says Corral's refusal back to the model, and asks to link again when Corral turns the token down", async () => {
    const { tokens } = await link();
    corral.mcpAnswer = "refused";
    expect(await listTool(tokens.access_token).then((r) => r.text())).toContain("This person can't see lists.");
    corral.mcpAnswer = "unauthorized";
    expect(await listTool(tokens.access_token).then((r) => r.text())).toContain("Link the account again");
  });

  it("renews Corral's tokens when Alexa refreshes, and uses the new one", async () => {
    const { client, tokens } = await link();
    const refreshed = await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // Alexa leaves resource out of a refresh; client_secret_post works as well as Basic.
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, client_secret: client.client_secret }),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(corral.tokenRequests.at(-1)?.get("refresh_token")).toBe("corral-refresh-1");
    await listTool(next.access_token);
    expect(corral.mcpTokens.at(-1)).toBe("Bearer corral-access-2");
  });

  it("ends the link when Corral has revoked access", async () => {
    const { client, tokens } = await link();
    corral.refreshAnswer = "revoked";
    const refreshed = await call("/token", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    expect((await listTool(tokens.access_token)).status).toBe(401);
  });

  it("tells Alexa when the person declines at Corral", async () => {
    const client = await alexaClient();
    const alexa = await pkce();
    const authorize = await call(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: ALEXA_REDIRECT, state: "alexa-state", code_challenge: alexa.challenge, code_challenge_method: "S256", resource: `${BRIDGE}/mcp` })}`);
    const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
    const back = await call(`/callback?${new URLSearchParams({ error: "access_denied", state })}`, { headers: { cookie: authorize.headers.get("set-cookie")!.split(";")[0]! } });
    const toAlexa = new URL(back.headers.get("location")!);
    expect(toAlexa.origin + toAlexa.pathname).toBe(ALEXA_REDIRECT);
    expect(Object.fromEntries(toAlexa.searchParams)).toMatchObject({ error: "access_denied", state: "alexa-state" });
  });

  it("refuses a callback that comes back to a different browser", async () => {
    const client = await alexaClient();
    const alexa = await pkce();
    const authorize = await call(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: ALEXA_REDIRECT, state: "s", code_challenge: alexa.challenge, code_challenge_method: "S256", resource: `${BRIDGE}/mcp` })}`);
    const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
    const res = await call(`/callback?${new URLSearchParams({ code: "corral-code", state })}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This sign-in has run out");
    // A page about signing in is HTML only, passes no address on, and nothing may frame it.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("refuses a redirect address Alexa's client doesn't have, without redirecting", async () => {
    const client = await alexaClient();
    const alexa = await pkce();
    const res = await call(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", state: "s", code_challenge: alexa.challenge, code_challenge_method: "S256" })}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("Alexa's client, made by hand", () => {
  it("needs the admin token, and doesn't exist without one set", async () => {
    const body = JSON.stringify({ redirect_uris: [ALEXA_REDIRECT] });
    expect((await call("/admin/clients", { method: "POST", body })).status).toBe(401);
    expect((await call("/admin/clients", { method: "POST", headers: { authorization: "Bearer wrong-token-wrong-token-wrong" }, body })).status).toBe(401);
    env.ADMIN_TOKEN = undefined;
    expect((await call("/admin/clients", { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body })).status).toBe(404);
  });

  it("takes Alexa's redirect addresses once Alexa shows them", async () => {
    const client = await alexaClient(["https://placeholder.example/cb"]);
    const updated = await call(`/admin/clients/${client.client_id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [ALEXA_REDIRECT, "https://layla.amazon.com/api/skill/link/M3TEST"] }),
    });
    expect(await updated.json()).toMatchObject({ client_id: client.client_id, redirect_uris: [ALEXA_REDIRECT, "https://layla.amazon.com/api/skill/link/M3TEST"] });
    const shown = await (await call(`/admin/clients/${client.client_id}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
    expect(shown).not.toHaveProperty("client_secret");
  });
});

describe("a Corral personal access token at /mcp", () => {
  const pat = "crl_pat_test";

  it("is refused unless turned on for building", async () => {
    expect((await listTool(pat)).status).toBe(401);
    env.ACCEPT_CORRAL_TOKENS = "true";
    expect((await listTool(pat)).status).toBe(200);
    expect(corral.mcpTokens.every((t) => t === `Bearer ${pat}`)).toBe(true);
  });
});
