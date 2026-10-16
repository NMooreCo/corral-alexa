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
| `corral` | A real Corral at `CORRAL_URL`, through its own MCP server | The caller's Corral token, sent as `Authorization: Bearer ...` |

The sample answers Corral's tools with the same arguments and the same JSON as Corral, so everything here runs and demos with no account. It acts as a shared kitchen screen: it sees what the adults see except private events (Busy), check-offs and list changes happen right away, and anything it puts on the calendar goes to a parent to approve. Its changes last as long as the worker instance.

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
| `src/index.ts` | The worker: routes, picking the household, serving `/mcp` with the MCP SDK's `createMcpHandler` |
| `src/server.ts` | The MCP server: Corral's tools, the `show_today` tool and the Today screen resource |
| `src/household.ts` | The contract both households answer, and the shapes of Corral's answers |
| `src/corral.ts` | A real Corral, reached through its MCP server with the caller's credential |
| `src/sample/` | The sample household and its data |
| `widgets/today/` | The Today screen (MCP Apps, built into one HTML file) |
| `preview/` | The stand-in host behind `/preview` |
| `scripts/` | Building the screens, and the smoke check |

## Check it

```bash
pnpm check
```

Builds the screens, typechecks, and runs the tests: the sample household's answers, the 2025-11-25 handshake and tool list Alexa+ sees, the Today screen resource, the current protocol for up-to-date clients, and carrying calls to a real Corral (with its refusals and a turned-down credential).

## What's next

- Alexa+ account linking: OAuth 2.1 with PKCE, protected resource metadata at the root, a fixed client for Alexa, and Corral's sign-in behind it.
- Linking an Echo as a household screen rather than as one person.
- More screens: the chore board for the barn, a list, the week.
- An Alexa+ add-on package and certification checklist.

## License

MIT. See [LICENSE](LICENSE).
