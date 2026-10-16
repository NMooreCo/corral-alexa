import { ToolError, type CorralTool, type Household } from "./household.ts";

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

  async call(tool: CorralTool, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": UPSTREAM_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": tool,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.#id,
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
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
    const body = (await res.json()) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
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
