import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** "sample" answers from the built-in sample household, open to anyone; "corral" answers from a real Corral, after account linking. */
  BACKEND?: string;
  /** The Corral to reach in corral mode, like https://corral.narralogy.ai. */
  CORRAL_URL?: string;
  /** This server's public address, when it should be pinned rather than read from each request. */
  PUBLIC_URL?: string;
  /** Account linking's grants, tokens and clients (corral mode). Tokens and secrets are stored only as hashes; props are encrypted. */
  OAUTH_KV?: KVNamespace;
  /** Set by the OAuth provider for its routes. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** A long random secret that turns on /admin/clients, for creating Alexa's client. Unset, those routes don't exist. */
  ADMIN_TOKEN?: string;
  /** This server's own client at Corral. Unset, it registers itself with Corral once and keeps what Corral gave it. */
  CORRAL_CLIENT_ID?: string;
  CORRAL_CLIENT_SECRET?: string;
  /** "true" also takes a Corral personal access token at /mcp, for scripts while building. Leave it off in production: MCP servers should take only their own tokens. */
  ACCEPT_CORRAL_TOKENS?: string;
}
