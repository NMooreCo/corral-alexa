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
| A per-request "who's speaking" claim for multi-user devices (signed, in `_meta` or a header), or guidance that each recognized voice links separately | Alexa+ knows voices, but MCP identity is one bearer token per connection, so a family's rules can't follow the person speaking (F12) | Important |
| A standard change signal for stateless MCP servers and MCP Apps (a change token in a tool result's `_meta` that hosts watch or poll) | Every app with shared state on two devices reinvents a poll (F11) | Nice to have |
| A way to mark a tool as an action that updates a screen, as distinct from one that opens a screen | Hosts and previews that open screens by calling their tools with no arguments call actions like `set_device` too (F14) | Nice to have |
| An app-to-host request to open another tool's screen (with arguments), without a model turn | A touch screen needs taps that move between screens instantly; today a screen can only reach another through the model, so ours had to merge into one bundle with tabs (F18) | Important |

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
- **Steps:** read the MCP authorization spec (a 401 with a `WWW-Authenticate` challenge naming the resource metadata), then the Alexa+ account-linking quickstart, then built the 401 on `/mcp`.
- **Expected:** the MCP spec's 401 with a `WWW-Authenticate` challenge pointing at the metadata.
- **Actual:** the quickstart says the server returns 401 "without a `WWW-Authenticate` header", and lists the header as not supported yet. It isn't clear whether its presence is ignored or breaks linking.
- **Severity:** Medium.
- **Workaround:** the bridge strips the header on `/mcp` (spec-following clients fall back to the well-known address).
- **Suggestion:** say "ignored" if it is, so servers can keep the spec's challenge.

### F4. The fixed client's redirect URIs

- **Task:** create Alexa's OAuth client on the bridge.
- **Steps:** read the account-linking pages for Alexa's redirect URIs; found the CLI step that prints them; tried to create the client before running it.
- **Expected:** Alexa's redirect URIs in the docs, so the client can be made complete in one step.
- **Actual:** they're shown only after `alexa-ai configure-account-linking`, which needs the client id first.
- **Severity:** Low.
- **Workaround:** create the client with a placeholder redirect, then update it (`pnpm alexa:client create`, then `redirects`).
- **Suggestion:** publish the redirect URIs, or accept CIMD.

### F5. Local Inspector described but not available

- **Task:** check the Today screen in Alexa's device frames.
- **Steps:** followed the Local Inspector page; ran `npm install @alexa-ai/addon-local-inspector` against the public registry.
- **Expected:** `@alexa-ai/addon-local-inspector`, a local proxy, installable from the docs.
- **Actual:** not on the public registry; it comes with the gated tooling.
- **Severity:** Medium.
- **Workaround:** built a stand-in MCP Apps host with Echo Show 5, 8 and 15 frames (`/preview`), then the full simulated Echo Show (`/echo`).
- **Suggestion:** publish the inspector on its own; it runs locally and needs no partner access.

### F6. Small inconsistencies in the account-linking pages

- **Task:** build account linking from the published pages alone.
- **Steps:** read the account-linking guide, its checklist and the Local Inspector page side by side while writing the OAuth client and the `initialize` handler.
- **Expected:** the pages agree on what's required.
- **Actual:** the client secret is "optional" in one place and required in the checklist; the Local Inspector page's example `initialize` uses protocol `2025-06-18` while the toolkit requires `2025-11-25`.
- **Severity:** Low.
- **Workaround:** followed the stricter of each pair (a client secret; protocol `2025-11-25`).
- **Suggestion:** align them.

### F7. MCP Apps 2.x needs the v2 MCP SDK

- **Task:** add an MCP App to a server built on `@modelcontextprotocol/sdk` 1.x.
- **Steps:** installed `@modelcontextprotocol/ext-apps` 2.0.3 beside the v1 SDK and registered a screen tool with its helpers.
- **Expected:** the helpers' types to fit the server already in use, or a clear version error.
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
- **Steps:** opened Service Quotas for Amazon Bedrock, searched for Opus 5.5, and filled in the increase form for a few thousand tokens a minute.
- **Expected:** a request sized to a demo, against the one quota the Messages API endpoint uses.
- **Actual:** the form won't accept less than the AWS default (30,000,000 tokens a minute), so a modest ask isn't possible; there are two Opus 5.5 token quotas (global and regional cross-region) and it isn't clear which one the Messages API endpoint draws on; no requests-per-minute quota is listed for Opus 5.5 even though older models have one. Both requests went to Pending with no estimate.
- **Severity:** Medium.
- **Workaround:** requested both token quotas at the minimum the form allows.
- **Suggestion:** let the form take any value up to the default, and say which quota each endpoint uses.

### F10. Testing sandboxed MCP Apps screens

- **Task:** check the screens in the simulator with browser automation (clicks and screenshots), as part of verifying each change.
- **Steps:** opened `/echo` under Playwright, asked for the Today screen, then tried to click a chore and capture the screen.
- **Expected:** automation could reach into the screen the way it reaches the rest of the page, or a documented way to drive one.
- **Actual:** a screen runs in a sandboxed `srcdoc` frame (`allow-scripts`, no same origin), as it should, so automation can't click inside it or read its DOM, and screenshots of it sometimes came back blank. A bug that hid the screen looked the same as the capture failing.
- **Severity:** Low.
- **Workaround:** tested taps through the bridge in unit tests, read `AppBridge`'s debug messages in the console to confirm a screen initialized and received its data, and later drove screens through Playwright's frame access with in-page clicks.
- **Suggestion:** a test harness for MCP Apps (drive a screen through `AppBridge` and read what it rendered), or a documented debug mode for hosts.

### F11. No way to tell a screen its data changed

- **Task:** keep a kitchen and a barn Echo Show in step on one household.
- **Steps:** checked a chore off by voice on the barn device and watched the kitchen device's screen; looked for a server-to-screen signal in MCP and MCP Apps.
- **Expected:** a way for the server to tell an open screen its data changed.
- **Actual:** a stateless MCP server can't push: notifications and resource subscriptions need a session, and MCP Apps has no server-to-screen hint. Every screen polls.
- **Severity:** Medium.
- **Workaround:** a screen-only `household_version` tool that each screen asks every 3 seconds while it's visible, refreshing when the counter moves.
- **Suggestion:** a standard change token in a tool result's `_meta` that hosts can watch or poll for the app.

### F12. No standard for who's speaking on a shared device

- **Task:** let the family's rules follow the person talking to a kitchen Echo (a kid's request waits for a parent; a guest changes nothing).
- **Steps:** read the MCP authorization spec and the Alexa+ add-on docs for a per-request identity; modeled voice profiles in the simulator.
- **Expected:** a documented way for Alexa+ to tell an add-on which recognized person is talking.
- **Actual:** MCP identity is the bearer token, one account per connection. Voice ID knows who's talking, but neither MCP nor the Alexa+ docs describe passing a recognized person per request.
- **Severity:** Medium.
- **Workaround:** the simulator sends the speaker in a header that only the sample household reads; linked to a real Corral, each person would link their own account.
- **Suggestion:** a signed per-request speaker claim for multi-user devices, or guidance that each recognized voice links separately.

### F13. Changing a header mid-connection in the MCP client SDK

- **Task:** switch who's speaking in the simulator without dropping its MCP connection.
- **Steps:** built one `StreamableHTTPClientTransport` per device and changed the speaker header between turns.
- **Expected:** a documented way to change a request header for later requests.
- **Actual:** `StreamableHTTPClientTransport` takes `requestInit` once, at construction. Switching the speaker without reconnecting works only because 2.3.1 rebuilds each request's headers from `requestInit.headers`, which isn't documented; reconnecting instead would orphan every `AppBridge` holding the old client.
- **Severity:** Low.
- **Workaround:** a test guards the behavior so an upgrade can't silently pin the first speaker.
- **Suggestion:** document per-request headers, or accept a headers function.

### F14. Actions that update a screen look like screens

- **Task:** let a device switched by voice show its countdown on the Ranch screen.
- **Steps:** gave `set_device` the Ranch screen's resource, then opened every screen tool from our preview host.
- **Expected:** a way to mark a tool as an action that updates a screen, apart from a tool that opens one.
- **Actual:** `set_device` shows the Ranch screen so a run started by voice counts down there, but nothing distinguishes "an action that updates this screen" from "a tool that opens this screen". A host or preview that opens screens by calling their tools with no arguments calls the action too, and gets an error.
- **Severity:** Low.
- **Workaround:** our preview skips screen tools with required arguments.
- **Suggestion:** a `_meta.ui` flag for actions, so hosts know a tool updates a screen rather than opening one.

### F15. `content` versus `structuredContent` for a large view

- **Task:** send the Ranch screen its map without making the model read it.
- **Steps:** returned the full view in `structuredContent` and checked what the spec says belongs in `content`.
- **Expected:** guidance on what Alexa+ passes to the model from a tool result that has a screen.
- **Actual:** the spec says structured content should also come back as text. For the Ranch screen that's kilobytes of map geometry the model shouldn't read, so `show_ranch` sends a short summary as text. It isn't clear whether Alexa+ gives `structuredContent` to the model, which decides whether that's a waste or a necessity.
- **Severity:** Low.
- **Workaround:** a short summary in `content`, and the full view only in `structuredContent`.
- **Suggestion:** say what Alexa+ shows the model from a tool result with a screen.

### F16. Wrangler: a LAN fetch hangs under `global_fetch_strictly_public`

- **Task:** reach our greenhouse controller on the home network from `wrangler dev`.
- **Steps:** set the controller's LAN address, ran `wrangler dev` with the project's compatibility flags, and called the controller's status endpoint with a 3 second `AbortSignal.timeout`.
- **Expected:** the call to succeed, or to fail fast with an error.
- **Actual:** with the flag set, a fetch to a LAN address neither failed nor honored `AbortSignal.timeout`; it hung until the caller gave up, and nothing pointed at the flag, so the controller looked down.
- **Severity:** Medium.
- **Workaround:** `pnpm dev:lan` runs locally without the flag.
- **Suggestion:** fail at once with an error naming the flag.

### F17. Wrangler: Durable Object config across environments, and Windows

- **Task:** add a Durable Object to the demo environment but not to production.
- **Steps:** declared the class and binding at the top level of `wrangler.jsonc`, then gave each environment its own settings; restarted `wrangler dev` on Windows between changes.
- **Expected:** environments to inherit or omit the Durable Object cleanly, and a restart to start fresh.
- **Actual:** `durable_objects` bindings aren't inherited by environments while `exports` and `migrations` are, so an environment with no Durable Object must empty both, and Wrangler still warns about the binding it left out on purpose. The docs prefer `exports`, but most examples still show `migrations`. On Windows, stopping `wrangler dev` left `workerd` processes holding the port, and the next run printed "Ready" while the old one kept answering with old settings.
- **Severity:** Low.
- **Workaround:** emptied `exports` and the binding in production on purpose, and ended stray `workerd` processes by hand before each run.
- **Suggestion:** a way to say "no Durable Object here on purpose", examples that use `exports`, and stopping child processes with `wrangler dev`.

### F18. An MCP App can't open another screen

- **Task:** on an Echo Show, let people tap from the Today screen to the ranch, the animals and the automations.
- **Steps:** built each as its own MCP Apps resource (`ui://corral/today.html`, `ui://corral/ranch.html`), then looked in `@modelcontextprotocol/ext-apps` for a way for one screen to show another tool's screen.
- **Expected:** an app request like "open this tool's screen with these arguments", handled by the host without a model turn.
- **Actual:** a screen can call server tools, update the model's context and send a message to the conversation, but it can't swap to another resource. Sending a message goes through the model, which is slow for a tap and may not happen.
- **Severity:** Medium.
- **Workaround:** merged the Today and Ranch screens into one bundle with a rail of tabs (Today, Ranch, Animals, Automations), each tab fetching its data through the screens' own refresh tools.
- **Suggestion:** an app-to-host request to open another tool's screen, so screens can link to each other without the model.
