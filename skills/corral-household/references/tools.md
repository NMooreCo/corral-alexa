# Corral's tools

The same names, arguments and answers as Corral's own MCP server. Answers are JSON. A change answers either `{ "status": "done", "summary": ... }` or `{ "status": "waiting_for_approval", "summary": ..., "approvers": [...], "requestId": ... }`.

Every answer is for whoever the connection speaks for: in Alexa+, the person whose voice it recognized, through their own linked Corral account. What they may see and whether a change waits come from their role: a kid's events, tasks for someone else, list items and skips wait for a parent; check-offs never wait; a private event reads as Busy to anyone but its owner; the farm hand sees the ranch calendar; a guest only reads.

## Reading

| Tool | Arguments | Answers |
|---|---|---|
| `calendar` | `from`, `to` (YYYY-MM-DD, default today, at most 62 days), `person`, `search` (words in the title; without dates looks 30 days ahead) | Events: `event` (id; missing on a private one), `occurrence` (for one day of a repeating event), `when` ("Fri, Oct 16, 3:30 PM to 4:45 PM" or "Sat, Oct 17 (all day)"), `title`, `people`, `drivers`, `location`, `calendar` |
| `tasks` | `from`, `to` (at most 31 days), `person`, `include_done` | Tasks and chores, open ones including anything overdue: `id`, `title`, `due`, `status` (`open`, `done`, `skipped`, `overdue`), `assignees` (`["anyone"]` when up for grabs), `doneBy`, `asks` (what it records when done, like eggs collected) |
| `whereabouts` | `person`, `at` (YYYY-MM-DDTHH:MM local, default now) | Per person: `name`, `location`, `until`, `then` (where they go next) |
| `people` | none | `name`, `shortName`, `roles` |
| `lists` | `list` (optional) | Without a list, the list names; with one, `items` with `text`, `quantity`, `waitingForApproval` |
| `points` | none | `balances` (per person, what they have, like "140 points" and "$12.50 of allowance") and `turnsInto` |
| `supplies` | none | `id`, `name`, `onHand` ("6 bags"), `daysLeft`, `runsOut` (a date), `low`, `onList` |
| `approvals` | none | `toDecide` (requests this person may decide, oldest first: `id`, `from`, `asks`, `since`), `yoursWaiting` (their own still waiting: `id`, `asks`, `since`, `decidedBy`), and `requests` when they can't decide here (who does) |

## Changing

| Tool | Arguments | Notes |
|---|---|---|
| `add_event` | `title`, `start` (required), `end`, `people` (names), `calendar`, `location`, `rrule` | May wait for a parent's approval. Names that aren't in the household become guests in the title. |
| `add_task` | `title` (required), `due`, `assignees` (names) | A reminder is a task for whoever it reminds. |
| `complete_task` | `task` (id), `by` (who did it), `values` (what the task asks for, by key) | Check-offs never wait for approval. |
| `undo_task` | `task` | Puts a checked-off chore back. |
| `claim_task` | `task`, `by` | For "I'll do it": takes a chore that's up for grabs. |
| `skip_task` | `task` | Nobody does it this time. |
| `add_list_item` | `text` (required), `list`, `quantity` | |
| `check_list_item` | `text` (required), `list` | Found by its words. |
| `update_supply` | `supply` (name or id), `change` (`used`, `added`, `count`), `amount`, `where` | "Out of" is a count of 0. |
| `decide_approval` | `request` (id from `approvals`), `decision` (`approve` or `decline`) | Only for someone who approves requests, never their own. Approving makes the change it asks for. |

## The ranch

Devices, readings and limits are the household's own configuration; these tools work the same for any of them.

| Tool | Arguments | Answers |
|---|---|---|
| `devices` | `place` (like "Greenhouse" or "Barn"), `device` (a name or id) | Per device: `id`, `name`, `place`, `kind`, `switchable`, `state` (`on`, `off`, `unknown` when it isn't answering, or null for a sensor), `run` ("28 seconds left, until 6:42 PM"), `readings` (label to words, like "Propane": "18%"), `maxRun`, `defaultRun`, `ifUnreachable` (`switches itself off` or `stays on`), `attention`, `note`, `live` (real hardware rather than a simulation) |
| `set_device` | `device` (name or id), `state` (`on` or `off`), `seconds`, `minutes` | `{ "status": "done", "summary": ..., "note"?: ..., "device": ... }`. A run past the device's `maxRun` is refused with the limit. Shows the Ranch screen. Confirm first. |
| `weather` | none | `now` (temperature, feels like, conditions, wind, humidity), `today` (high, low, conditions, precipitation, snow, wind), `tonight` (`low`, `lowestAround`, `freeze`, `hardFreeze`), `days` (the next four), `nextFreeze`, `stale` when it couldn't refresh |
| `trackers` | `animal` (a name, or a kind like "goats") | `animals` (each `animal`, `species`, `collar`, `battery`, `batteryLow`, `signal`, `lastSeen`, `stale`, `insideFence`, `zone`, and `outside.words` like "about 220 ft outside the fence to the north-east, nearest the North pasture"), plus `outsideFence`, `lowBattery` and `stale` as lists of names |

## Screens (MCP Apps)

| Tool | Shows |
|---|---|
| `show_today` | The Today screen: calendar with what's on now and next, chores to tap off, who's where. It keeps itself current. |
| `show_week` | Seven days of the calendar (`from`, default today), today marked, who's driving. |
| `show_list` | One list (`list`, default the first) with items to tap off and the other lists to switch to. |
| `show_supplies` | Each supply's amount, days left and whether it's low; a low one goes on a list in one tap. |
| `show_approvals` | Requests waiting for this person, each with Approve and Decline, and their own requests still waiting. |
| `show_ranch` | A map of the property (fence, zones, a pin per collar, anyone outside the fence standing out) and a tile per device that switches it, with runs counting down. It keeps itself current. |
| `show_briefing` | The morning briefing as swipeable cards; you're told which card is showing. |

`approvals`, `decide_approval` and `show_approvals` follow the shape of Corral's own inbox and request decisions. Corral's MCP server doesn't let connected apps decide requests yet, so a server linked to a real Corral leaves them out; the sample household has them.
