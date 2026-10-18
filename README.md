# Corral for Alexa+

Alexa can set a timer. It can't tell you whether it's Dad's weekend, who has the 4:00 pickup, whether the dog got her pill, or that you're down to two bags of horse feed. [Corral](https://corral.narralogy.ai) can. It's the household platform one family and ranch run on every day: the shared calendar, chores and who did them, shopping lists, where everyone is, kids' points, and supplies.

**Corral for Alexa+** puts that household inside Alexa+. It's a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) on Cloudflare Workers that gives Alexa+ Corral's tools, draws interactive screens for the Echo Show with [MCP Apps](https://modelcontextprotocol.io/extensions/apps), and links each Alexa account to Corral with OAuth 2.1, so every family's rules come along: private events stay private, a kid's change waits for a parent, and the farm hand only hears about the ranch.

**Try it**

- **[The simulated Echo Show](https://alexa-demo.corral.narralogy.ai/echo)**: talk to it (or type), watch it call Corral's tools over MCP, tap the screens, and pick who's speaking to watch the family's rules follow the person. It runs on a made-up household, Juniper Hollow. The demo passcode is in the submission's testing instructions.
- **[Two Echo Shows, one household](https://alexa-demo.corral.narralogy.ai/echo?devices=2)**: a kitchen Echo Show 8 and a barn Echo Show 5 side by side. Check a chore off on one and watch the other catch up.
- **The MCP server**: `https://alexa-demo.corral.narralogy.ai/mcp` (the sample household, open) and `https://alexa.corral.narralogy.ai/mcp` (linked to a real Corral, behind account linking).
- **The Agent Skill**: [`skills/corral-household`](skills/corral-household/SKILL.md), also served as the MCP prompt `household-assistant`.

## What it does

| Ask | What happens |
|---|---|
| "What's going on today?" | The **Today** screen: the calendar with what's on now and next, chores to tap off, and who's where. It keeps itself current. |
| "What's our weekend look like?" | The **Week** screen: seven days, today marked, who's driving. |
| "Leo emptied the dishwasher." | The chore is checked off with credit to Leo, and the screen updates. |
| "We're down to two bags of horse feed." | The count is recorded, the **Supplies** screen shows about three days left, and it offers to put feed on the feed store list. |
| "Add tortillas and salsa." | Both go on the grocery list; the **List** screen shows it, and tapping an item checks it off. |
| "Put the dentist on Thursday at 3:30 for Leo." | It confirms first. A parent's change happens right away; from a kid, or from a shared kitchen device, the event goes to a parent to approve, and it says who. |
| Maya: "Can I have a sleepover at Ava's on Friday?" | It offers to ask, and the request goes to Sam and Alex. Nothing is on the calendar yet. |
| Sam: "Anything waiting for me?" | The **Approvals** screen: Maya's sleepover with Approve and Decline. A tap on Approve puts it on the calendar, and the **Week** screen shows it. |
| (tapping a chore on the screen) | The screen checks it off through Corral and tells the assistant, so "who did the eggs?" right after has the answer. |
| (a chore checked off on the kitchen Echo Show) | The barn Echo Show's screen shows it within a few seconds: every device shares one household, kept through restarts until its day turns over. |

## How it works

```mermaid
flowchart LR
  subgraph Assistants
    A["Alexa+ on an Echo Show"]
    S["Simulated Echo Show<br/>(this repo, /echo)"]
    O["Claude, ChatGPT,<br/>any MCP client"]
  end
  subgraph Bridge["corral-alexa (Cloudflare Worker)"]
    M["MCP server<br/>2025-11-25 and 2026-07-28"]
    U["MCP Apps screens<br/>Today, Week, List, Supplies, Approvals"]
    L["Account linking<br/>OAuth 2.1 + PKCE"]
    P["Sample household<br/>Durable Object, SQLite"]
  end
  B["Claude<br/>Amazon Bedrock or the Claude API"]
  C["Corral's own MCP server<br/>the household's data and rules"]
  A -- "MCP, Streamable HTTP" --> M
  S -- "MCP, Streamable HTTP" --> M
  O --> M
  S -- "/echo/model" --> B
  M --> U
  M -- "linked: the person's Corral token" --> C
  M -- "demo" --> P
  L -. "sign in at Corral" .-> C
```

- **The rules travel with the data.** The bridge never decides who sees or changes what. Linked, every call goes to Corral's own MCP server with the person's own Corral token, and Corral applies the same rules as its app. The sample household answers the same tools with the same JSON, so everything here runs and demos with no account.
- **Rules follow the person.** Alexa+ recognizes family members by voice, and each person links their own Corral account, so who's talking comes from their token and Corral applies their role: a kid's plans wait for a parent, a private event reads as Busy to anyone but its owner, the farm hand sees the ranch calendar. The sample household has the same roles as data. With no sign-in in sample mode, the simulator names the speaker in an `x-demo-person` header; only the sample reads it, a name it doesn't know is a guest, and the linked server ignores it completely.
- **One server, every assistant.** Alexa+ speaks MCP 2025-11-25; current clients speak 2026-07-28. Both are served statelessly from one endpoint with the MCP TypeScript SDK's `createMcpHandler`, so the same server, screens and skill also work in Claude, ChatGPT or Home Assistant.
- **One shared household, kept across sessions.** In the demo, the sample household is a Cloudflare Durable Object (`src/sample/durable.ts`): every `/mcp` request goes to the one object for that household, which serves MCP from inside itself and keeps the household in its own SQLite database. So two Echo Shows, Alexa+ and the simulator, or a judge and a teammate see the same chores, and a restart or deploy keeps them. Its times are laid out around today, so it starts over when the household's day turns over, and `POST /household/reset` starts it over on purpose. Linked to a real Corral, Corral is the shared state and there is no Durable Object.
- **Screens that catch up.** A stateless MCP server can't push to a screen, so the household keeps a change counter and every screen asks it every 3 seconds while it's showing (`household_version`, a tool only screens can call, kept out of the model's tool list). When it moves, the screen refreshes. A change on one device reaches every other screen within a few seconds, on real Echo Shows as in the simulator.

## Built for Alexa+

The real Alexa+ developer tools (the MCP Toolkit, the `alexa-ai` CLI and the web simulator) are open only to select partners, so hackathon entrants can't connect a server to a real Alexa+ ([hackathon FAQ](https://amazonappdev2026.devpost.com/details/faqs)). This server is built to the published Alexa+ contract anyway, so it's ready the day access opens:

| Alexa+ requirement | Here |
|---|---|
| Self-hosted MCP server, spec 2025-11-25, Streamable HTTP | Yes, plus 2026-07-28 for current clients |
| Round trips under 500 ms | Tool calls answer in about 10 to 20 ms from the edge on the sample household; linked to a real Corral at home, 120 to 350 ms measured end to end |
| Visuals through MCP Apps | Five screens, each one self-contained HTML (`text/html;profile=mcp-app`) that declares it reaches no other origin |
| OAuth 2.1 authorization code with PKCE (S256) | Yes ([account linking](#account-linking)) |
| Protected resource metadata at `/.well-known/oauth-protected-resource` | Served at the root, naming `/mcp`, this server and the scopes |
| `resource` on authorize and token; a refresh token with every access token | Yes |
| No dynamic client registration; a fixed client | Alexa's client is made once through `/admin/clients`; nothing else can register |
| 401 without `WWW-Authenticate` | `/mcp` answers a bare 401 before linking |
| Tools designed for one-shot extraction and voice | Short, specific descriptions; read tools default to today; changes answer `done` or `waiting_for_approval` with who approves |

## The simulated Echo Show

[`/echo`](https://alexa-demo.corral.narralogy.ai/echo) stands in for Alexa+ on an Echo Show 8, as the FAQ invites: **the page is a real MCP client** of this server. It sends `initialize`, `tools/list`, `resources/read` and `tools/call` over Streamable HTTP, and shows every call in a live traffic log beside the device.

- **Who's speaking:** pick anyone in the household, or someone Alexa doesn't recognize, the way Alexa+ knows voices. The device greets them by name, every MCP call from then on (the assistant's and the screens' taps alike) carries who it is, and the screen redraws as they'd see it: Sam's private appointment opens up for Sam, the farm hand's day is the ranch's, a guest can look but not change anything. It starts as the household's first member, a parent, so every suggestion works; the suggestions marked Maya and Sam switch to them first, which plays the approval demo in two taps.
- **Listening and speaking:** push-to-talk, or hands-free after "Alexa", with the browser's speech recognition and voices. Typing works everywhere.
- **Deciding:** Claude ([below](#the-simulators-model)) picks the tools and says the answer. The page runs the loop: it calls the tools Claude asks for, sends the results back together, and stops at an answer.
- **Screens:** when a tool has an MCP Apps screen, the page renders it on the device as a host would, passes taps back through MCP, and tells Claude what was tapped.
- **The light bar** shows listening, thinking and speaking; captions show what it heard and what it said.
- **Two devices:** [`/echo?devices=2`](https://alexa-demo.corral.narralogy.ai/echo?devices=2) puts a kitchen Echo Show 8 and a barn Echo Show 5 side by side on the same household. Each is the simulator's own page in a frame, so each is its own MCP client with its own conversation and screen; the header shows the household's change counter. Check a chore off on one, by voice or with a tap, and the other's screen shows it within a few seconds. "Start the day over" resets the household and both conversations for a fresh take (with the demo passcode, when the server has one). It's laid out for 1280 by 800 and stacks the two on a phone.

## The simulator's model

The simulator's brain is **Claude Opus 5.5**, called from the Worker at `POST /echo/model` through the official Anthropic TypeScript SDK, from either of two places that speak the same Messages API:

- **Amazon Bedrock** (`anthropic.claude-opus-5-5`): Bedrock's Messages API endpoint, `https://bedrock-mantle.{region}.api.aws/anthropic`, with a Bedrock API key (`BEDROCK_API_KEY`). No AWS request signing is needed, which keeps it Workers-friendly.
- **The Claude API** (`claude-opus-5-5`) with `ANTHROPIC_API_KEY`, or any gateway that speaks its wire format at `ANTHROPIC_BASE_URL`.

`MODEL_PROVIDER` (`bedrock` or `anthropic`) picks one; unset, it's whichever has a key, Bedrock first. The page names the one answering, and each reply in its log shows the model id. Keys are Worker secrets and never reach the browser.

- **Prompt:** a fixed voice-assistant prompt plus the household Agent Skill, marked for prompt caching, then the household's time zone and the current time. Tools are the MCP server's own, as the page listed them.
- **Speed:** low effort, for quick spoken replies.
- **Resilience:** if the main model declines a request, the SDK's refusal-fallback middleware runs it again on Claude Opus 4.8 at the same place.
- **Cost control:** a per-visitor rate limit (a Workers rate-limit binding), an optional demo passcode, and caps on conversation and tool-list size, so it can't be used as a free general chatbot.
- `src/echo/model.ts` is the whole integration; `test/echo.test.ts` checks the request it sends.

## The Agent Skill

[`skills/corral-household`](skills/corral-household/SKILL.md) is an [Agent Skill](https://agentskills.io/) that teaches any agent to run a family's day through Corral's tools by voice: know who's speaking, look before changing, confirm in one sentence, respect approvals (and leave deciding them to the people who give them), keep "Busy" private, credit the right person, speak briefly, and use the screens. It includes everyday requests, a running-low recipe and a tool reference. The server also offers it as the MCP prompt `household-assistant`, and the simulator gives it to Claude.

## Account linking

In linked mode this server is an OAuth 2.1 authorization server for Alexa+, and Corral is where people sign in:

```
Alexa app --> /authorize --> Corral's consent page --> /callback --> back to Alexa with a code --> /token
              (this server)   sign in, pick the household,  (this server keeps Corral's
                              choose what to allow           tokens, encrypted)
```

- **Corral behind it.** `/authorize` hands the person to Corral's consent page as this server's own Corral client (registered with Corral once, automatically), with PKCE and Corral's MCP server as the resource. The `state` is bound to the browser, so a code can't be finished somewhere else.
- **Tokens.** Corral's tokens live inside the grant, encrypted. Alexa's access token lasts as long as the Corral token behind it; when Alexa refreshes, this server refreshes Corral's too. If someone disconnects the app in Corral, the link ends and Alexa asks to link again.
- **Built on** Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): tokens, codes and secrets are stored only as hashes, props are encrypted, and refresh tokens rotate.
- **Proven end to end** against a real Corral: sign-in, consent, code exchange, tool calls with the person's token, and refresh.

### Linking a real Alexa+ (once partner access exists)

1. Set the admin secret once: `pnpm exec wrangler secret put ADMIN_TOKEN --env production` (24 characters or more).
2. Make Alexa's client: `ADMIN_TOKEN=... pnpm alexa:client create https://alexa.corral.narralogy.ai`. Keep the secret it prints; it isn't shown again.
3. Point Alexa at it: `alexa-ai configure-account-linking --addon-id <id> --stage development --client-id <client_id>`, with the secret in `ALEXA_CLIENT_SECRET`, and `https://alexa.corral.narralogy.ai/mcp` as the add-on's MCP endpoint.
4. Give the redirect addresses the CLI shows back to the client: `ADMIN_TOKEN=... pnpm alexa:client redirects https://alexa.corral.narralogy.ai <client_id> <address> ...`, then `alexa-ai deploy`.

## Run it locally

Needs Node 22 and pnpm 9.

```bash
pnpm install
pnpm dev
```

That builds the screens and starts the Worker at `http://127.0.0.1:8795` with the sample household:

- `/echo` is the simulated Echo Show, and `/echo?devices=2` two of them on one household. With no model key, run `pnpm dev --var MODEL_MOCK:true` to answer with a small practice model, or put `ANTHROPIC_API_KEY` or `BEDROCK_API_KEY` in `.dev.vars`.
- The household lives in a local Durable Object, kept in `.wrangler/state` across restarts. `GET /household` says its day and change counter; `curl -X POST http://127.0.0.1:8795/household/reset` starts it over. `?household=<id>` on `/echo` or `/mcp` uses a separate household.
- `/mcp` is the MCP server; point any MCP client at it (for example `npx @modelcontextprotocol/inspector`).
- `/preview` shows any screen in Echo Show 5, 8 and 15 and phone frames, light or dark.
- `pnpm smoke [url]` talks to a running server the way Alexa+ does and prints timings.

## Deploy

Deploys always name an environment, so the sample household can never replace the linked bridge:

| Script | Worker | Address | Answers from |
|---|---|---|---|
| `pnpm ship` | `corral-alexa` | `https://alexa.corral.narralogy.ai` | A real Corral, after account linking |
| `pnpm ship:demo` | `corral-alexa-demo` | `https://alexa-demo.corral.narralogy.ai` | The sample household, with `/echo` and `/preview` |

The demo's simulator needs a model key as a Worker secret (`ANTHROPIC_API_KEY`, plus `ANTHROPIC_BASE_URL` for a gateway, or `BEDROCK_API_KEY`; `MODEL_PROVIDER` in `wrangler.jsonc` says which), and optionally `DEMO_PASSCODE`, which also guards starting the household over. To run your own, change the hostnames, `CORRAL_URL` and the KV id in `wrangler.jsonc`.

The demo's shared household is a SQLite-backed Durable Object, declared with Wrangler's `exports` field (the declarative replacement for `migrations`). The first `pnpm ship:demo` creates the class; it has to be a full `wrangler deploy` (which the script is), not `wrangler versions upload` or a gradual rollout. Production has no Durable Object: its environment sets empty `durable_objects` and `exports`.

## Tests

```bash
pnpm check
```

Builds every page, typechecks (Worker and screens), and runs the tests:

- the sample household's answers;
- who's talking: each role's rules as data (private events, the farm hand, guests, what waits for a parent), approvals from a kid's request through a parent's yes to the calendar, the speaker header in sample mode, and corral mode ignoring it;
- the shared household: sample mode reaching its Durable Object (a fake namespace of real objects on Node's own SQLite), two clients seeing one change, the household kept through a restart, starting over on a new day and on purpose, separate households, corral mode never touching a Durable Object, and Wrangler's resolved config for each environment;
- the 2025-11-25 handshake, tools and prompts Alexa+ sees;
- every screen's resource;
- the current protocol for up-to-date clients;
- account linking end to end against a stand-in Corral (discovery, the hand-off to Corral's sign-in, code and token exchange, calls with the person's token, refresh, revoked access, a declined sign-in, a callback in another browser, an unknown redirect address, the admin route);
- the simulator's model route (what it sends to Bedrock and to the Claude API, which one it picks, the rate limit, the passcode, size caps).

## Layout

| Path | What |
|---|---|
| `src/index.ts` | The Worker: the sample household with `/echo` and `/preview`, or account linking in front of a real Corral |
| `src/server.ts` | The MCP server: Corral's tools, the screen tools and their MCP Apps resources, the skill as a prompt |
| `src/household.ts`, `src/corral.ts`, `src/sample/` | The contract both households answer; a real Corral through its MCP server; the sample household, with its roles in `roles.ts`, shared through its Durable Object (`durable.ts`, `shared.ts`, `store.ts`, `routes.ts`) |
| `src/today.ts`, `src/screens.ts`, `src/approvals.ts` | What each screen shows |
| `src/link/` | Account linking: the OAuth provider, Corral as the sign-in, `/admin/clients` |
| `src/echo/` | The simulator's model route (Claude on Bedrock or the Claude API) and the practice model |
| `widgets/` | The screens (MCP Apps), each built into one HTML file, on `widgets/shared` |
| `echo/`, `preview/` | The simulated Echo Show (`echo/pair` is the two-device view) and the screen preview |
| `skills/corral-household/` | The Agent Skill |
| `docs/feedback.md` | Product feedback and the friction log |

## License

MIT. See [LICENSE](LICENSE).
