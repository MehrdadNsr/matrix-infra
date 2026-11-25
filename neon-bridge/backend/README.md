# Neon Bridge backend — API contract

The userscript talks to exactly one endpoint: the `backendUrl`
configured in its panel. Every call is `POST` with a JSON body and
the header `x-bridge-key: <bridgeKey>`.

> **TODO (owner):** add the function source and SQL for this backend.
> This file is the contract the function must implement; the
> implementation itself is not in this repo yet.

## Auth and errors

- Missing or wrong key → `401`. The script stops and shows
  "key invalid" in the panel.
- `claim` with an already-seen hash → `409` (see below).
- Network errors and `5xx` are retried by the script (3 tries,
  exponential backoff). Other `4xx` are not retried.

## Actions

| Action | Request (JSON) | Response |
|---|---|---|
| `next` | `{action:"next", worker}` | `{ok, card \| null}` — `null` when the queue is empty |
| `plan` | `{action:"plan", id}` | `{ok, settings:{model:"neon"\|"hydrogen", thinking:"low"\|"medium"\|"high", reason}}` |
| `claim` | `{action:"claim", id, sent_hash}` | `200 {ok}`, or `409` when the same message was already sent (the script must not send it) |
| `status` | `{action:"status", id, status:"waiting"\|"failed"\|"skipped"\|"queued", last_error?, model_used?, account_used?, mode_stats?}` | `{ok}` — `mode_stats` (on failure): `{mode_used, fell_back, fallback_reason, duration_s, permission_prompts, auto_approved, retries, ok}`. |
| `supervise` | `{action:"supervise", id, messages:[{role:"user"\|"model", text}]}` | `{ok, verdict:{action:"accept"\|"continue"\|"retry"\|"escalate"\|"fail", message_indexes[], complete, needs_stitch, stale, reason}}` |
| `submit` | `{action:"submit", id, content, model_used?, account_used?, mode_stats?}` | `{ok, pr_url, commit}` — `mode_stats` (on success): `{mode_used, fell_back, fallback_reason, duration_s, permission_prompts, auto_approved, retries, ok}`. |
| `ask` | `{action:"ask", id, question, chat_url}` | `{ok}` — the card becomes status `blocked`; the backend routes the question to the agent that created the card (escalating to a senior agent if needed). The script does nothing else here and never waits for the answer. |
| `heartbeat` | `{action:"heartbeat", worker, state, card_id?, quota_pct?, last_error?, version, last_auto_approval?}` — `state` is `running` \| `paused` \| `stopped` \| `idle`; `last_auto_approval` is e.g. `"auto-approved read_file for neon-mcp"` | `{ok}` — lets other agents see whether the bridge is alive. Sent every 60 s and on every state change. |
| `alert` | `{action:"alert", kind:"stopped"\|"selectors"\|"account"\|"permission", message}` | `{ok}` — the backend emails the owner (rate-limited server-side). Kind `"permission"` means an unknown permission prompt appeared and was left alone; the worker paused instead of approving. The message is the prompt text, capped at 300 chars. |
| `card` | `{action:"card", id}` | `{ok, card}` (or the card object directly). **Required in MCP mode** (the script polls it every 10 s); optional in paste mode, where it is only used before send/submit so the script can abort a card an agent cancelled (`skipped`/`failed`). If the backend does not provide this action, return `400`, `404` or `501` and the script proceeds without the re-read — but MCP mode then falls back to paste on every card. The card object should include `mcp_seen_at` (timestamp or null, set when the MCP tools first run for the card), `status` (`queued` \| `waiting` \| `done` \| `blocked` \| `failed` \| `skipped`), `result_pr_url` (set when `done`), `question` (set when `blocked` via MCP), and `last_error`. |
| `room_poll` | `{action:"room_poll", worker, agent}` | `{ok, item \| null}` — `item`: `{id, room_id, room_name, thread_id?, chat_url?, transcript:[{sender, text, ts}], mention, members:[names], max_words?}`. `type` is `message` \| `summon` \| `dismiss`. The transcript holds room messages since this agent's last reply (max 30). The backend also filters senders (see `allowedSenders` below) and caps automatic agent-to-agent turns at 6 per human message. |
| `room_reply` | `{action:"room_reply", id, text, chat_url}` | `{ok}` — posts the reply into the room as this agent. Long replies arrive as several calls (one per part, ≤3500 chars each), in order. |
| `room_status` | `{action:"room_status", id, status:"working"\|"failed"\|"skipped", error?}` | `{ok}` — progress on a chat item. `skipped` covers PASS replies and loop-brake skips. |
| `room_presence` | `{action:"room_presence", agent, room_id, state:"online"\|"offline"}` | `{ok}` — presence for a room. |
| `alert` | `{action:"alert", kind:"stopped"\|"selectors"\|"account", message}` | `{ok}` — the backend emails the owner (rate-limited server-side). The script calls this only when it fully stops. |

### Card object (`next`)

```json
{
  "id": "card-uuid",
  "seq": 12,
  "batch_id": "batch-uuid",
  "file_path": "src/foo.js",
  "branch": "neon/card-12",
  "commit_message": "Rewrite foo in ESM",
  "prompt": "Rewrite src/foo.js ...",
  "read_links": ["https://.../foo.js"],
  "settings": {"model": "neon", "thinking_level": "medium"},
  "attempts": 0,
  "last_error": null,
  "only_neon": false,
  "status": "queued",
  "read_url": "https://read.example.com/task/card-uuid",
  "mode_hint": "mcp-first",
  "mcp_active": true
}
```

Notes:

- `next` may return a card with `status: "answered"` and an `answer`
  field (plus the `chat_url` where the question was asked). Answered
  cards have priority over queued cards. `next` may return either a
  single `{card}` or `{cards: [...]}`; the script picks the first
  answered card, else the lowest-`seq` queued card.
- `supervise` may return verdict action `"ask"` with a `question`
  field when the model asked a QUESTION or the task is too ambiguous.
  `ask` is a first-class verdict, not an error.
- `read_url` is the link the AI reads in the link flow
  (`read.trafactor.com/…`); when it is missing the script pastes
  the card text instead. `mode_hint` overrides the worker's
  strategy for that card (`paste-first` | `mcp-first` | `ab` |
  `paste-only` | `mcp-only`). `mcp_active: false` makes MCP mode
  fall back to the link flow immediately.
- `message_indexes` in a verdict refer to the `messages` array sent
  in that same `supervise` call, in order.
### Chat item object (`room_poll`)

```json
{
  "id": "chat-uuid",
  "type": "message",
  "room_id": "room-uuid",
  "room_name": "core-team",
  "thread_id": "thread-uuid",
  "chat_url": "https://gemini.google.com/app/c/abc123",
  "transcript": [{ "sender": "mehrdad", "text": "review the PR", "ts": 1730000000 }],
  "mention": true,
  "members": ["mehrdad", "oracle", "neon"],
  "max_words": 150
}
```

Notes:

- `chat_url` is the dedicated chat this agent uses for the room (if
  any). When it is absent, or it no longer loads, the script starts a
  new chat, sends the intro prompt + a 5-line summary of the
  transcript, then relays. After a rotation the script reports the
  new chat URL with the next `room_reply`.
- `allowedSenders` (default: mehrdad, oracle, claude, morpheus,
  neon, muse, grok, gpt) is enforced on both sides. Only mehrdad /
  oracle may authorize tool actions that write; the script adds a
  guard line to the relay when anyone else spoke.
- `complete` says whether the answer is a complete file;
  `needs_stitch` says its parts (across the indexed messages) must be
  joined; `stale` says the model echoed a stale/old answer.
- `submit` is where the backend commits `content` to the card's
  `branch` and opens the PR; `pr_url` is shown in the panel.

## Deploy your own

1. Create a serverless function (or any small HTTP service) that
   implements the table above behind the `x-bridge-key` check.
2. Point it at your card store (see TODO below).
3. Deploy it at a URL only you know, put that URL in the panel as
   `backendUrl`, and set a long random `bridgeKey`.
4. In the panel, set a `workerId` per browser (one worker per
   browser — the script enforces it with a lock, but the backend
   should also treat two workers with the same id as one).

## Future: OpenAI-compatible endpoint (not built)

Tools like Cline or Claude Code should one day be able to call
"neon" like a normal model: `POST /v1/chat/completions` on this
backend, turning a request into a card and waiting for the result.
That endpoint is **not part of this contract yet** — do not build it
from this file alone. When it is built, it sits on top of the card /
verdict shapes above; the userscript needs no changes for it beyond
the new route.

### TODO: function source

<!-- TODO(owner): add the function source here (or link the repo that
     holds it). It must implement every action in the table above and
     nothing else needs to exist on this endpoint. -->

### TODO: SQL / schema

<!-- TODO(owner): add the SQL for the card store. Suggested shape only
     — not implemented anywhere yet:
     - cards(id, seq, batch_id, file_path, branch, commit_message,
       prompt, read_links json, settings json, attempts, last_error,
       only_neon, status, created_at, updated_at)
     - claims(card_id, sent_hash, claimed_at) with a unique
       (card_id, sent_hash) pair, so a duplicate claim returns 409
     - submissions(card_id, commit, pr_url, submitted_at)
     - alerts(kind, message, sent_at) for the server-side rate limit
     on owner emails. -->
