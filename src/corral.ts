import { ToolError, type CorralTool, type Household, type HouseholdAbout } from "./household.ts";

/** What Corral's instructions said about each credential's household, for ten minutes. */
const aboutCache = new Map<string, { at: number; about: HouseholdAbout }>();
const ABOUT_TTL_MS = 10 * 60 * 1000;

/** The protocol this bridge speaks to Corral: one POST per call, no handshake. */
const UPSTREAM_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "corral-alexa", version: "0.1.0" };

/** Corral didn't accept the credential: the person needs to link again. */
export class UpstreamAuthError extends Error {
  override name = "UpstreamAuthError";
}

export interface CorralOptions {
  /** Corral's public address, like https://corral.narralogy.ai. Its MCP server is this plus /mcp. */
  baseUrl: string;
  /** The person's Corral credential: an OAuth access token or a personal access token. */
  token: string;
  fetch?: typeof fetch;
}

/**
 * A real Corral, reached through its own MCP server with the person's
 * credential. Corral checks every call against what that person may see and
 * do, so this only carries calls and answers.
 */
export class CorralHousehold implements Household {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  #id = 0;

  constructor(opts: CorralOptions) {
    this.#url = `${opts.baseUrl.replace(/\/+$/, "")}/mcp`;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The household's name and time zone, from the instructions Corral's MCP server gives (cached briefly). */
  get name(): string | undefined {
    return aboutCache.get(this.#token)?.about.name;
  }

  async about(): Promise<HouseholdAbout> {
    const kept = aboutCache.get(this.#token);
    if (kept && Date.now() - kept.at < ABOUT_TTL_MS) return kept.about;
    try {
      const body = (await this.#rpc("server/discover", {})) as { result?: { instructions?: string } };
      const text = body.result?.instructions ?? "";
      const about: HouseholdAbout = {
        name: /Corral runs the (.+?) household/.exec(text)?.[1],
        timeZone: /time zone is ([A-Za-z_]+\/[A-Za-z_/+-]+)/.exec(text)?.[1],
      };
      aboutCache.set(this.#token, { at: Date.now(), about });
      return about;
    } catch {
      return {};
    }
  }

  async #rpc(method: string, params: Record<string, unknown>, name?: string): Promise<unknown> {
    const res = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": UPSTREAM_VERSION,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.#id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": UPSTREAM_VERSION,
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError("Corral didn't accept this connection's sign-in.");
    if (!res.ok) throw new ToolError("Corral didn't answer just now. Try again in a moment.");
    return res.json();
  }

  async call(tool: CorralTool, args: Record<string, unknown>): Promise<unknown> {
    const body = (await this.#rpc("tools/call", { name: tool, arguments: args }, tool)) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
    if (body.error) throw new ToolError(body.error.message ?? "Corral couldn't do that.");
    const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (body.result?.isError) throw new ToolError(text || "Corral couldn't do that.");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
