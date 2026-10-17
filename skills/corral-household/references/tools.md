# Corral's tools

The same names, arguments and answers as Corral's own MCP server. Answers are JSON. A change answers either `{ "status": "done", "summary": ... }` or `{ "status": "waiting_for_approval", "summary": ..., "approvers": [...], "requestId": ... }`.

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

## Screens (MCP Apps)

| Tool | Shows |
|---|---|
| `show_today` | The Today screen: calendar with what's on now and next, chores to tap off, who's where. It keeps itself current. |
| `show_week` | Seven days of the calendar (`from`, default today), today marked, who's driving. |
| `show_list` | One list (`list`, default the first) with items to tap off and the other lists to switch to. |
| `show_supplies` | Each supply's amount, days left and whether it's low; a low one goes on a list in one tap. |
