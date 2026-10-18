# Product feedback and friction log

Written while building, so each entry is what actually happened. For the Devpost submission's Product Feedback, Feature Requests and Friction Log fields.

## Product feedback

### Alexa+ MCP Toolkit documentation

- **Used for:** the account-linking contract (OAuth 2.1, PKCE S256, `resource` on authorize and token, refresh tokens), where Alexa+ reads protected resource metadata, the 500 ms round-trip budget, MCP Apps support for visuals, and the `addon.json` fields.
- **Worked well:** the account-linking page is a precise checklist; building to it first meant the bridge linked to a real Corral on the first try. Choosing MCP as the integration standard means the same server also works in other assistants without changes.
- **Needs work:** which tools are partner-only isn't said on the setup pages (see F1); Alexa's discovery differs from the MCP spec in two places (F2, F3); there's no published list of Alexa's redirect URIs, which makes the fixed client a chicken-and-egg step (F4).
- **Onboarding:** we couldn't reach "hello world" on a real Alexa+, since the CLI, Local Inspector and web simulator are gated. Everything up to that point (spec, auth, latency) was buildable from the docs alone.
- **Build again?** Yes. MCP-first is the right call: one server, every assistant.

### MCP specification (2025-11-25, Streamable HTTP)

- **Used for:** the bridge's MCP server, serving 2025-11-25 to Alexa+ and 2026-07-28 to current clients from one endpoint, stateless.
- **Worked well:** stateless Streamable HTTP fits serverless hosting exactly; authorization (RFC 9728 metadata, RFC 8707 resource indicators) maps cleanly onto an OAuth library.
- **Needs work:** serving two protocol eras means two discovery stories (`initialize` versus `server/discover`) and two sets of headers.

### MCP TypeScript SDK v2

- **Used for:** `McpServer` and `createMcpHandler` on Cloudflare Workers.
- **Worked well:** one factory serves both protocol eras; the Workers export condition picks an edge-safe JSON Schema validator automatically.
- **Needs work:** the move from the single v1 package to `@modelcontextprotocol/server`, `core` and `client` isn't obvious from npm alone (F7).

### MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

- **Used for:** the Today screen (an interactive calendar, chores and whereabouts view), a screen-only refresh tool, full screen, host fonts and model-context updates, and a stand-in host for previewing on Echo Show sizes.
- **Worked well:** `App` and `AppBridge` are small and clear; the Patterns page (app-only tools, polling with teardown, display modes, CSP) answered every design question.
- **Needs work:** see F7; and the patterns live in a separate page from the API reference, so they're easy to miss.

## Feature requests

| Request | Why it matters | Priority |
|---|---|---|
| A public sandbox of the web simulator (or the Local Inspector) for hackathons and independent developers | Builders can't see how their MCP App renders on an Echo Show, or how Alexa+ chooses their tools, before partnership | Critical |
| Read path-specific protected resource metadata (RFC 9728 section 3.1) as well as the root document | Standard MCP servers and OAuth libraries serve only the path-specific one, so every server needs a workaround | Important |
| Publish Alexa's account-linking redirect URIs, or support Client ID Metadata Documents | Removes the create-placeholder-then-update dance for the fixed client | Important |
| Say whether a `WWW-Authenticate` header on a 401 is ignored or breaks linking | It's the MCP spec's primary discovery signal; servers shouldn't have to strip it for one client | Important |
| An Alexa+ identity for shared devices (a household screen rather than one person) in account linking | A kitchen Echo is used by the whole family; linking it as one adult's account reads that adult's private things aloud | Nice to have |

## Friction log

### F1. Finding out the add-on tools are partner-only

- **Task:** install the Alexa AI CLI to create an MCP add-on.
- **Steps:** followed "Set Up Your Development Environment": an IAM user allowed to assume `AddOn3PDeveloperToolsRead`, then `aws codeartifact login` and `npm install -g @alexa-ai/cli`.
- **Expected:** a CLI to install, or a note that access must be granted first.
- **Actual:** the page reads as self-serve; only the docs home page and the hackathon FAQ say the tools are for select partners, with no way to apply. `@alexa-ai/*` isn't on the public registry.
- **Severity:** High (time spent on a dead end).
- **Workaround:** the simulated-experience path the FAQ points to.
- **Suggestion:** a banner on every MCP Toolkit page saying who can use it and how to ask.

### F2. Protected resource metadata at the root only

- **Task:** let Alexa+ discover the bridge's authorization server.
- **Steps:** configured Cloudflare's `workers-oauth-provider` with the resource `https://alexa.corral.narralogy.ai/mcp`.
- **Expected:** Alexa+ reads the path-specific document the library serves at `/.well-known/oauth-protected-resource/mcp`, as RFC 9728 and the MCP spec describe.
- **Actual:** the Alexa docs require the document at the root, `/.well-known/oauth-protected-resource`, where the library answers 404.
- **Severity:** Medium.
- **Workaround:** the bridge answers the root path itself before the library sees the request.
- **Suggestion:** try the path-specific document too.

### F3. No `WWW-Authenticate` on a 401

- **Task:** answer an unlinked call so Alexa+ starts account linking.
- **Expected:** the MCP spec's 401 with a `WWW-Authenticate` challenge pointing at the metadata.
- **Actual:** the quickstart says the server returns 401 "without a `WWW-Authenticate` header", and lists the header as not supported yet. It isn't clear whether its presence is ignored or breaks linking.
- **Severity:** Medium.
- **Workaround:** the bridge strips the header on `/mcp` (spec-following clients fall back to the well-known address).
- **Suggestion:** say "ignored" if it is, so servers can keep the spec's challenge.

### F4. The fixed client's redirect URIs

- **Task:** create Alexa's OAuth client on the bridge.
- **Expected:** Alexa's redirect URIs in the docs, so the client can be made complete in one step.
- **Actual:** they're shown only after `alexa-ai configure-account-linking`, which needs the client id first.
- **Severity:** Low.
- **Workaround:** create the client with a placeholder redirect, then update it (`pnpm alexa:client create`, then `redirects`).
- **Suggestion:** publish the redirect URIs, or accept CIMD.

### F5. Local Inspector described but not available

- **Task:** check the Today screen in Alexa's device frames.
- **Expected:** `@alexa-ai/addon-local-inspector`, a local proxy, installable from the docs.
- **Actual:** not on the public registry; it comes with the gated tooling.
- **Severity:** Medium.
- **Workaround:** built a stand-in MCP Apps host with Echo Show 5, 8 and 15 frames (`/preview`).
- **Suggestion:** publish the inspector on its own; it runs locally and needs no partner access.

### F6. Small inconsistencies in the account-linking pages

- **Actual:** the client secret is "optional" in one place and required in the checklist; the Local Inspector page's example `initialize` uses protocol `2025-06-18` while the toolkit requires `2025-11-25`.
- **Severity:** Low.
- **Suggestion:** align them.

### F7. MCP Apps 2.x needs the v2 MCP SDK

- **Task:** add an MCP App to a server built on `@modelcontextprotocol/sdk` 1.x.
- **Actual:** `@modelcontextprotocol/ext-apps` 2.x imports its types from `@modelcontextprotocol/server` (v2), so with the v1 SDK installed the helpers' types don't line up, without a clear error.
- **Severity:** Low.
- **Workaround:** moved to the v2 SDK (`@modelcontextprotocol/server` 2.3.1).
- **Suggestion:** a note in the MCP Apps quickstart naming the SDK version each release pairs with.

### F8. A new Bedrock account has no Claude quota

- **Task:** call Claude Opus 5.5 on Amazon Bedrock from the simulator, through Bedrock's Messages API endpoint with a Bedrock API key.
- **Steps:** a new AWS account; created a Bedrock API key; called `anthropic.claude-opus-5-5`; then tried Opus 4.8 and Haiku 4.5; upgraded the account from the Free plan to Paid.
- **Expected:** a first call that works, or an error that names the fix.
- **Actual:** Opus 5.5 and 4.8 answered "not available for this account"; Haiku 4.5 first needed a use-case form, then answered ThrottlingException. After the upgrade, every Claude model's tokens-per-minute and requests-per-minute quota still showed 0. Nothing on the model catalog page, in the API key flow or in the error said a quota request was the next step.
- **Severity:** High (the AWS integration was built and tested but couldn't go live in time to know).
- **Workaround:** made the provider a setting; the demo runs on the Claude API until the quota arrives.
- **Suggestion:** give new accounts a small default Claude quota, or say "your quota for this model is 0; request an increase" in the error and on the model's page.

### F9. The quota form and what it covers

- **Task:** ask for a small Opus 5.5 quota for a demo.
- **Actual:** the form won't accept less than the AWS default (30,000,000 tokens a minute), so a modest ask isn't possible; there are two Opus 5.5 token quotas (global and regional cross-region) and it isn't clear which one the Messages API endpoint draws on; no requests-per-minute quota is listed for Opus 5.5 even though older models have one. Both requests went to Pending with no estimate.
- **Severity:** Medium.
- **Workaround:** requested both token quotas at the minimum the form allows.
- **Suggestion:** let the form take any value up to the default, and say which quota each endpoint uses.

### F10. Testing sandboxed MCP Apps screens

- **Task:** check the screens in the simulator with browser automation (clicks and screenshots), as part of verifying each change.
- **Actual:** a screen runs in a sandboxed `srcdoc` frame (`allow-scripts`, no same origin), as it should, so automation can't click inside it or read its DOM, and screenshots of it sometimes came back blank. A bug that hid the screen looked the same as the capture failing.
- **Severity:** Low.
- **Workaround:** tested taps through the bridge in unit tests, and read `AppBridge`'s debug messages in the console to confirm a screen initialized and received its data.
- **Suggestion:** a test harness for MCP Apps (drive a screen through `AppBridge` and read what it rendered), or a documented debug mode for hosts.
