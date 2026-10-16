# Corral for Alexa+

Alexa can set a timer. It can't tell you whether it's Dad's weekend, who has the 4 PM pickup, whether the dog got her pill, or that you're down to two bags of horse feed. [Corral](https://corral.narralogy.ai) can: it's a household platform (calendar, chores, lists, whereabouts, points, supplies) that one family and ranch run on every day.

This repo puts Corral inside Alexa+. It's a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) on Cloudflare Workers that offers Corral's tools to Alexa+ and draws a **Today** screen for the Echo Show with [MCP Apps](https://modelcontextprotocol.io/extensions/apps): today's calendar, the chores (tap one to check it off) and who's where.

```
Alexa+  --MCP 2025-11-25-->  corral-alexa (this repo, a Worker)  --MCP 2026-07-28-->  Corral's /mcp
                              tools, Today screen, sample household                    the household's data and rules
```

The rules travel with the data. This bridge never decides who sees what: every call goes to Corral as the linked person or screen, so private events read as "Busy", a kid's change waits for a parent, and the farm hand only hears about the ranch.

## Run it

Needs Node 22 and pnpm 9.

```bash
pnpm install
pnpm dev
```

That builds the screens and starts the worker at `http://127.0.0.1:8795`:

- `/mcp` is the MCP server. Point any MCP client at it, for example `npx @modelcontextprotocol/inspector`.
- `/preview` is a stand-in MCP Apps host that shows the Today screen in Echo Show sized frames (Echo Show 5, 8 and 15, and a phone), light or dark, and lists what the screen tells the assistant. It's for building; Alexa+ is the real host.

`pnpm smoke` talks to the running server the way Alexa+ does (the 2025-11-25 handshake, then one POST per message) and prints what it finds, with timings.

## Where the answers come from

Set `BACKEND` in `wrangler.jsonc`:

| `BACKEND` | Answers from | Credential |
|---|---|---|
| `sample` (default) | A built-in sample household: Juniper Hollow, a made-up family ranch with two parents, two kids and a farm hand, laid out around today | None |
| `corral` | A real Corral at `CORRAL_URL`, through its own MCP server | Account linking (below) |

The sample answers Corral's tools with the same arguments and the same JSON as Corral, so everything here runs and demos with no account. It acts as a shared kitchen screen: it sees what the adults see except private events (Busy), check-offs and list changes happen right away, and anything it puts on the calendar goes to a parent to approve. Its changes last as long as the worker instance.

## Account linking

In `corral` mode this server is an OAuth 2.1 authorization server for Alexa+, and Corral is where people sign in:

```
Alexa app --> /authorize --> Corral's consent page --> /callback --> back to Alexa with a code --> /token
              (this server)   sign in, pick the household,  (this server keeps Corral's
                              choose what to allow           tokens, encrypted)
```

- **What Alexa+ needs, and gets:** OAuth 2.1 authorization code with PKCE (S256), protected resource metadata at the root (`/.well-known/oauth-protected-resource`, naming `/mcp`, this server and the scopes), authorization server metadata at `/.well-known/oauth-authorization-server`, `resource` honored on authorize and token, a refresh token with every access token, and a bare `401` (no `WWW-Authenticate`) at `/mcp` before linking.
- **One fixed client.** Alexa can't register itself, and nothing else may: there's no registration endpoint. Alexa's client is made once through `/admin/clients`.
- **Corral behind it.** `/authorize` hands the person to Corral's consent page as this server's own Corral client (registered with Corral once, automatically, or set with `CORRAL_CLIENT_ID`), with PKCE and Corral's MCP server as the resource. The `state` is bound to the browser, so a code can't be finished somewhere else.
- **Tokens.** Corral's tokens live inside the grant, encrypted. Alexa's access token lasts as long as the Corral token behind it; when Alexa refreshes, this server refreshes Corral's too. If Corral has revoked access, the link ends and Alexa asks to link again. A link lives while it's used, like Corral's own connections (30 idle days).
- **Built on** Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider): tokens, codes and secrets stored only as hashes, props encrypted, refresh tokens rotated.

### Deploying

`wrangler.jsonc` has two environments, and deploys always name one, so the sample can never replace the linked bridge:

| Script | Worker | Address | Answers from |
|---|---|---|---|
| `pnpm ship` | `corral-alexa` | `https://alexa.corral.narralogy.ai` | Corral, after account linking (`env.production`) |
| `pnpm ship:demo` | `corral-alexa-demo` | `https://alexa-demo.corral.narralogy.ai` | The sample household, open, with `/preview` (`env.demo`) |

Both are Workers custom domains (Cloudflare makes the DNS record and certificate). Production pins `PUBLIC_URL` so its OAuth issuer is always the same, and keeps its grants in its own KV namespace. To run your own, change the hostnames, `CORRAL_URL` and the KV id.

### Linking Alexa+

1. Set the admin secret once: `pnpm exec wrangler secret put ADMIN_TOKEN --env production` (24 characters or more).
2. Make Alexa's client: `ADMIN_TOKEN=... pnpm alexa:client create https://alexa.corral.narralogy.ai`. Keep the secret it prints; it isn't shown again.
3. Point Alexa at it: `alexa-ai configure-account-linking --addon-id <id> --stage development --client-id <client_id>`, with the secret in `ALEXA_CLIENT_SECRET`. Set `accountLinking.enabled` in `addon.json`, with `https://alexa.corral.narralogy.ai/mcp` as the MCP endpoint.
4. Give the redirect addresses the CLI shows back to the client: `ADMIN_TOKEN=... pnpm alexa:client redirects https://alexa.corral.narralogy.ai <client_id> <address> ...`, then `alexa-ai deploy`.

The first link registers the bridge with Corral as "Corral for Alexa+"; people then see it under Corral's connected apps, and disconnecting it there ends the link.

While building, `ACCEPT_CORRAL_TOKENS=true` also takes a Corral personal access token at `/mcp` (for `pnpm smoke` with `CORRAL_TOKEN`). Leave it off in production: MCP servers should take only tokens they issued.

## Tools

The same names, arguments and answers as Corral's own MCP server, with descriptions written for a voice assistant:

| Tool | What it does |
|---|---|
| `calendar` | Events between two dates, for one person, or by words in the title |
| `tasks` | Chores and tasks due, with anything overdue |
| `whereabouts` | Where each person is, until when, and where they go next |
| `people`, `lists`, `points`, `supplies` | Who's in the household, what's on each list, balances, what's running low |
| `add_event`, `add_task` | Add to the calendar or the task list (or ask a parent to) |
| `complete_task`, `undo_task`, `claim_task`, `skip_task` | Check chores off, put them back, take them, skip them |
| `add_list_item`, `check_list_item` | Shopping and to-do lists |
| `update_supply` | Supplies used, added or counted |
| `show_today` | Today on the screen (an MCP Apps tool; its screen is `ui://corral/today.html`) |

## Layout

| Path | What |
|---|---|
| `src/index.ts` | The worker: the sample, or account linking in front of a real Corral |
| `src/server.ts` | The MCP server: Corral's tools, the `show_today` tool and the Today screen resource |
| `src/household.ts` | The contract both households answer, and the shapes of Corral's answers |
| `src/corral.ts` | A real Corral, reached through its MCP server with the person's Corral token |
| `src/link/` | Account linking: the OAuth provider and its routes, Corral as the sign-in, and `/admin/clients` |
| `src/sample/` | The sample household and its data |
| `widgets/today/` | The Today screen (MCP Apps, built into one HTML file) |
| `preview/` | The stand-in host behind `/preview` |
| `scripts/` | Building the screens, and the smoke check |

## Check it

```bash
pnpm check
```

Builds the screens, typechecks, and runs the tests: the sample household's answers, the 2025-11-25 handshake and tool list Alexa+ sees, the Today screen resource, the current protocol for up-to-date clients, and account linking end to end against a stand-in Corral (discovery, the hand-off to Corral's sign-in, the code and token exchange, calls made with the person's Corral token, refresh, revoked access, a declined sign-in, a callback in another browser, a redirect address Alexa's client doesn't have, and the admin route).

## What's next

- Linking an Echo as a household screen rather than as one person (a choice on Corral's consent page).
- More screens: the chore board for the barn, a list, the week.
- An Alexa+ add-on package and certification checklist.

## License

MIT. See [LICENSE](LICENSE).
