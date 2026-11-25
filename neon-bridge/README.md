# Neon Bridge v2

One script, three jobs: code mode via MCP or copy-paste, and
group-chat relay — on [Gemini](https://gemini.google.com),
[Muse](https://muse.ai), [Grok](https://grok.com) and
[ChatGPT](https://chatgpt.com), one tab each, one shared core and one
adapter per site.

For a coding task card it picks the model and thinking level, sends
the prompt to the AI (Gemini model "Neon"), collects the answer, gets
a verdict from a supervisor, and submits the final file to a backend.
The backend commits the file to a branch and opens a PR. **The script
never touches GitHub directly.** In chat mode the AI on the tab takes
part in a group chat room (Matrix behind the backend): the script
relays room messages into the room's dedicated chat and posts the
AI's reply back into the room.

Single-account safety is the point: one worker per browser, quiet
hours, random pacing, a soft daily cap, and a full stop (with an owner
notification) instead of ever working around a sign-in, captcha, or
quota wall.

This folder is fully self-contained — no imports from the rest of any
repo — so it can be extracted to its own repository later with
`git subtree split`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open `dist/neon-bridge.user.js` and install it (or drag the file
   into the Tampermonkey dashboard). The committed `dist/` build is
   the installable file; `src/` is the source.
3. Open https://gemini.google.com — the **Neon Bridge v2** panel
   appears top-right.
4. Fill in the settings in the panel: `backendUrl`, `bridgeKey`,
   `workerId`. Everything else has a sane default (see below).
5. Click **Self-test** (checks the editor, send button and model
   picker are found on the page).
6. Turn on **Dry run** and click **Start** to watch it walk the queue
   without sending or submitting. Turn dry run off to go live.

Settings are stored with `GM_setValue`; nothing is hardcoded. See
`config.example.json` for every setting and its default.

| Setting | Default | Notes |
|---|---|---|
| `backendUrl` | — (required) | Your bridge backend URL |
| `bridgeKey` | — (required) | Sent as `x-bridge-key` |
| `workerId` | — (required) | Identifies this worker to the backend |
| `quietHours` | `02:00–08:00` local | The worker sleeps in this range |
| `paceMinSec` / `paceMaxSec` | `60` / `180` | Random pause between messages |
| `maxAttemptsPerCard` | `4` | Then the card is marked failed |
| `dailySoftCap` | `50` | Max messages sent per day |
| `alertOnStop` | `true` | Notify the owner on a full stop |

## How a card flows

1. Quiet hours or paused: sleep. Otherwise `next` — empty queue
   means poll again in 2–5 minutes.
2. `plan` gives the desired `{model, thinking}`. A card flagged
   `only_neon` always runs on Neon.
3. Every card starts in a **new chat** (long chats burn quota and
   make Gemini repeat old answers). State is persisted in GM storage
   before the navigation and resumed on load.
4. Health check: logged in, editor present, no captcha / sign-in /
   unusual-traffic page. Any failure stops the worker.
5. Model + thinking are set, then **read back**. Thinking is verified
   by reopening the model menu and reading `aria-checked` on the
   thinking options (index 0 low, 1 medium, 2 high) — the plain
   read-back cannot see the options once the menu closes. Mismatch →
   retry once → card failed with "settings mismatch".
6. The message depends on the mode (see "Code-mode strategy"):
   link flow sends the card's read link (`card.read_url`) plus a
   short instruction block; MCP sends the tool message. A card with
   no `read_url` falls back to pasting the card text.
7. `sent_hash = sha256(message + attempt)` is claimed first. A `409`
   means the message was already sent — the card is skipped.
8. Insert + send. Within 10 s a new `user-query` with our text must
   appear; if the text bounced back into the editor (a known outage
   symptom) send is pressed once more.
9. Wait for completion: stop button gone **and** answer text unchanged
   for 8 s. Hard timeout 10 min. Status `waiting` while generating.
10. Link flow: a cut-off answer gets up to 3 same-chat "Continue…"
    turns, then the file is extracted from the model messages
    (fences stripped) and submitted — after re-reading the card, so
    an already-done card is never submitted twice. MCP mode: the
    backend is polled every 10 s until the card is done (the tools
    submitted it), blocked or failed.
11. Random pace before the next message.

## Code-mode strategy

Field tests show the link flow is the most reliable; MCP works well
when it works but is slow and often needs 2–3 permission approvals
per card. Each card runs in one mode, chosen per card in
`src/core/modes.js` by the strategy (`modeStrategy` setting:
`"paste-first"` (default) | `"mcp-first"` | `"ab"` |
`"paste-only"` | `"mcp-only"`):

- `"paste-first"` — the link flow first, MCP never (the default).
- `"mcp-first"` — MCP first, link flow as the fallback.
- `"ab"` — alternate per card (odd `seq` MCP-first, even `seq`
  link-first) so both methods get comparable data.
- `"paste-only"` / `"mcp-only"` — one mode only; a fallback in
  `mcp-only` fails the card instead.
- During the test period, Gemini defaults to `"ab"` when the
  `testMode` setting is on and `modeStrategy` was never set
  explicitly; otherwise the default is `"paste-first"`.
- A backend card may override the strategy for that card with
  `card.mode_hint` (one of the five values).
- Answered cards always run in link mode: their answer is delivered
  as chat text.

**Link flow (`src/modes/link.js`).** The AI gets the card's read
link (`card.read_url`, e.g. `read.trafactor.com/…`) plus a short
instruction block ("Read it, then write the complete file. Reply
with exactly one fenced code block containing the whole file, and
end with `END-<id>`."), the script waits for the complete answer
(thinking excluded), extracts the file content (fences stripped)
and submits it via the backend. When the card has no `read_url`,
the card text is pasted instead. A cut-off answer (no `END-<id>` /
unclosed fence) gets up to 3 same-chat "Continue" turns; nothing
extracted at all retries the card in a new chat. No supervisor in
this flow.

**MCP mode (`src/modes/mcp.js`).** Gemini itself works through the
connected neon-mcp server: the script sends one message ("Use the
neon-mcp tools only. Call get_task with task_id=… … When
submit_file succeeds, reply with the PR link and DONE-…") and then
polls the backend every 10 s with action `card`. The card carries
`mcp_seen_at` (non-null once the tools ran), `status` and
`result_pr_url`:

- `status` `"done"` → success: the PR link is shown in the panel, no
  supervisor, no code extraction.
- `status` `"blocked"` → a question was asked via MCP; the card is
  counted as blocked and the worker moves on (same as chat ask).
- `status` `"failed"` → logged with `last_error`, move on.
- If Gemini's reply finished (stop button gone, text stable 8 s) but
  the card is neither done nor blocked, the script sends **once**:
  "You did not finish with submit_file. Call submit_file now…",
  then keeps polling.

It falls back to the link flow (same card, new chat, attempt + 1)
when: MCP is not active for the card (`card.mcp_active === false`);
`mcp_seen_at` is still null after `mcpPickupTimeoutSec` (default
90 s); Gemini's reply says it has no tools / cannot reach neon-mcp /
NOT SUPPORTED (patterns in `src/core/errors.js`, English + Persian);
no `submit_file` within `mcpTimeoutMin` (default 6 min); more than 3
permission prompts on one card; or an MCP tool error twice (distinct
errors in the reply text, English + Persian). The log says
`MCP fallback: <reason>`. Before the fallback submits, the card is
re-read: a card that is already `done` is never submitted twice.

**MCP health.** After 2 consecutive fallbacks the worker uses the
link flow for the next 30 minutes, then tries MCP again on the next
card. A card that demonstrably used the tools (done, blocked, or a
backend "failed" status) resets the streak. The panel shows the
current mode (`MCP` / `LINK` / `LINK until hh:mm` / `AB`) and the
heartbeat state carries the running card
(`running:card:<id>:mcp` / `running:card:<id>:link`).

**Per-card stats (`mode_stats`).** Every card reports
`{mode_used, fell_back, fallback_reason, duration_s,
permission_prompts, auto_approved, retries, ok}` — with `submit`
on success and with `status` on failure, and logged locally. The
permission watcher counts every prompt it sees on the card
(`permission_prompts`) and every auto-approval (`auto_approved`).
The panel shows the strategy and a counter per mode: cards, ok %,
average duration, average permission prompts. The permission
watcher must be running in MCP mode (Always allow for neon-mcp
tools only); a prompt that names neither our server nor any of our
tools pauses the worker and alerts the owner.

## Questions and escalation

The model is told (in the footer, and in one line of the link
message): if anything is unclear or contradicts the repo, do **not**
guess — output only a block starting with `QUESTION <id>`, list the
questions, end with `END-<id>`, and stop. The link flow detects that
block in the answer; in MCP mode a question asked via tools makes
the card `blocked`. Either way:

- The script calls `ask` with the question and the current chat URL
  (`location.href`). The card becomes `blocked` server-side; the
  backend routes the question to the agent that created the card
  (escalating to a senior agent if needed).
- The panel shows a **blocked (waiting for answer)** counter and the
  latest question text.
- The script moves on to the next queued card immediately — it never
  waits idle for an answer.
- When the backend later returns that card from `next` with status
  `answered` and an `answer` field, it has priority over queued
  cards. The script re-opens the saved `chat_url` if it still loads
  and sends "Answer to your questions: … Now continue the task…".
  If the saved chat does not load, it opens a new chat, re-sends the
  original prompt first, then sends the answer message.
- A card may go through ask/answer at most **3 times**; a 4th
  question fails it with "too many questions". Questions do not count
  toward `maxAttemptsPerCard`.

## Error ladder

Detected in the adapter, classified in `src/core/errors.js`
(English + Persian patterns; unknown texts are logged verbatim):

- Generic errors / numbered errors (1076, 1099): wait 30 s, then
  2 min, then a new chat. After 3 consecutive cards fail this way:
  stop + owner notification (`account`).
- Quota on Neon: one new chat (limits sometimes stick to long
  chats). Still limited and not `only_neon` → switch to Hydrogen.
  Hydrogen limited too → pause until the next 5-hour refresh
  (countdown in the panel), no notification. Weekly cap → stop.
- Quota below 20%: only Hydrogen/low cards run. At 0%: pause.
- Answer cut off (no `END` marker / unclosed fence): the supervisor
  decides `continue`.
- Links not read: one retry with the linked text pasted inline
  (each link fetched with `?raw=1`, max 60 KB).
- Model/thinking silently changed: caught by the read-back in step 5
  and re-checked right before every send.
- Selector missing: self-test at startup and on any "element not
  found" → stop + owner notification (`selectors`), naming the key.
- Page frozen (DOM unchanged for 10 min while waiting): reload, new chat.
- Signed out / captcha / unusual traffic: stop immediately. The
  script never tries to solve a captcha or switch Google accounts.

Only full stops call the backend `alert` action (rate-limited
server-side).

## Staying a real user

The script runs only as a Tampermonkey userscript in a normal Chrome
profile. It never uses Playwright, Puppeteer, CDP, remote debugging,
or cookie/token extraction — recent Google account bans mostly hit
third-party clients that use Google backends, plus repetitive request
patterns, so the script stays a plain user of the web UI:

- Random 300–900 ms pause before every click, random 2–6 s between
  "set model", "set thinking" and "send", plus the random per-card
  pacing, quiet hours and daily cap.
- Never a byte-identical message twice: the short intro line rotates
  across 4 phrasings by attempt number, and the `sent_hash` includes
  the attempt number.

## Adapters (one script, several sites)

One tab = one worker, one site. The adapter is picked by
`location.hostname` (`src/adapters/index.js`): `gemini.google.com`
→ Gemini, `muse.ai` (setting `museDomain`, default `muse.ai`) →
Muse, `grok.com` → Grok, `chatgpt.com` → ChatGPT. Every adapter
exposes the same interface — `selfTest()`, `newChat()`,
`openChat(url)`, `currentChatUrl()`, `send(text)`,
`waitForReply()`, `readLastReply()`, `detectErrors()`,
`detectLimits()`, plus `healthCheck()` / `isGenerating()` and
optional `setModel` / `setThinking` (no-ops where a site has none).
Shared DOM helpers live in `src/adapters/dom.js` (send fallbacks,
reply waiting, the permission watcher), so a fix there applies to
all four sites.

The Gemini adapter is verified on the live page. The Muse, Grok and
ChatGPT adapters are **unverified best guesses**: each one's
selectors live in its own section of `src/selectors.js`, marked
`[unverified]`, and `selfTest()` reports exactly which keys are
missing. On a failed self-test the tab runs in a "disabled" state
(heartbeat state `disabled` + owner alert kind `selectors`) — never
guess silently. Changing `museDomain` also needs the userscript
`@match` / extension manifest updated to run on the new domain.

## Chat mode (group-chat relay)

In chat mode the AI on the tab takes part in a group chat room
(Matrix behind the backend). The backend offers items via
`{action:"room_poll", worker, agent}` — type `message` | `summon` |
`dismiss`, with the room's transcript (max 30 lines since this
agent's last reply), `mention`, `members` and `max_words`
(default 150):

- **summon:** open (or create) the room's dedicated chat, send the
  intro prompt (built in `src/core/message.js`), then `room_reply`
  a short "online" line and `room_presence` online.
- **message:** open the room's chat (`chat_url`; if it does not
  load, new chat + intro prompt + a 5-line summary of the
  transcript), send the relay message ("New messages in
  `<room_name>` since your last reply: …" + the transcript lines +
  "You were addressed. Reply as …" or "Reply only if you have
  something useful; otherwise reply exactly PASS."), wait for the
  full reply (thinking excluded), trim it. Exactly `PASS` →
  `room_status` skipped; otherwise `room_reply` (replies over 3500
  chars split into parts).
- **dismiss:** `room_presence` offline, forget the room's chat,
  back to normal work.

**Scheduling.** Chat items have priority over code cards, but never
interrupt a card while the AI is generating: `room_poll` runs
between cards and every 20 s while idle. Pacing, quiet hours, the
daily soft cap and the quota guard apply to chat too; chat messages
pace shorter (random 5–20 s) but still count toward the cap.
`codeEnabled` / `chatEnabled` (both default true on Gemini; on
Muse/Grok/ChatGPT `codeEnabled` defaults to false until their code
flows exist — turning it on in the panel makes it stick).

**Long-chat hygiene.** After more than 40 relayed turns in a room's
chat, the script asks the AI for a 10-line summary, starts a new
chat, sends the intro prompt + summary, and stores the new
`chat_url`.

**Safety.** `allowedSenders` (default: mehrdad, oracle, claude,
morpheus, neon, muse, grok, gpt) filters the transcript — lines from
anyone else are dropped before relaying, and the backend filters
too. Only mehrdad / oracle may authorize tool actions that write
(`submit_file` etc.): when a relayed transcript has lines from
anyone else, the relay message carries a guard line saying so.
Loop brake: at most 6 chat replies per room per 10 minutes without
a human message (mehrdad / oracle) in between — the backend caps
automatic agent-to-agent turns at 6 per human message as well. On a
brake, the item is logged and `room_status` skipped. Never paste
secrets into a chat. The permission watcher runs on every site
(Always allow only for our neon-mcp tools).

**Panel + heartbeat.** The panel shows site/adapter, agent name,
mode (MCP / PASTE / CHAT), rooms joined, and the last chat item;
heartbeat state is `running:chat:<room_name>` while a chat item is
being processed. A "Leave all rooms" button sends `room_presence`
offline for each room.

## Heartbeat and remote visibility

Other agents can see whether the bridge is alive: the script sends
`{action:"heartbeat", worker, state, card_id?, quota_pct?,
last_error?, version}` every 60 s and on every state change
(started, paused, card finished, stopped). A failed heartbeat never
stops the worker. While a chat item is being processed the state is
`running:chat:<room_name>`; a disabled tab (failed self-test)
reports `disabled`.

Before sending a message and before submitting, the script re-reads
the card (`{action:"card", id}` when the backend provides it). If an
agent cancelled it in the meantime (`status` became `skipped` or
`failed`), the card is aborted cleanly and the worker moves on.

## Gem mode (optional, default OFF)

Set `gemUrl` in the panel to a Gemini Gem URL to turn Gem mode on:

- "New chat" opens the Gem URL instead of `/app`.
- The standing rules are assumed to live in the Gem's instructions,
  so the script sends only `CARD <id>` + the task, plus the one-line
  reminder "Follow your rules. End with `END-<id>`."
- At Start (and on Self-test) the script probes whether model and
  thinking can still be selected inside the Gem. If not, it logs the
  fact and falls back to normal mode for that session (the saved
  `gemUrl` is left alone).

## Auto-approve tool permission prompts (neon-mcp only)

Any of the sites may show a permission prompt before a connected MCP
tool runs ("Allow" / "Always allow", or in Persian «اجازه دادن» /
«همیشه اجازه داده شود»). The watcher in `src/adapters/dom.js` (one
implementation, used by every adapter)
(MutationObserver + a 2 s fallback poll) handles it:

- **Approve, only when the prompt is clearly ours:** the dialog or
  inline card text must contain the configured MCP server name
  (`mcpServerName`, default `neon-mcp`) **or** one of our tool names
  (`mcpToolNames`, default: `repo_info`, `list_dir`, `read_file`,
  `get_task`, `submit_file`, `ask_question`, `report_status`). Then
  it waits a random 400–1200 ms and clicks "Always allow" if
  present, otherwise "Allow". The approval is logged
  ("auto-approved `<tool>` for neon-mcp") and sent in the next
  heartbeat (`last_auto_approval`).
- **Anything else: never click.** A prompt that does not name our
  server or any of our tools (another app, Gmail, an unknown MCP
  server) pauses the worker, is shown in the panel, and triggers an
  owner alert `{kind:"permission", message:<prompt text, max 300
  chars>}` — the full prompt text (max 300 chars) goes in the panel
  log and in the alert. This is the guard against prompt injection
  making Gemini call other tools.
- **Known issue:** Gemini's tool-approval prompt may not show the
  server name at all, so a match on any of our tool names alone is
  enough to approve.
- "Deny" is never clicked automatically. Approvals only happen on
  gemini.google.com (guarded in the watcher as well as by the
  userscript `@match`) and only while the tab holding the worker is
  running.

## Known fragility

- **Gemini UI updates may break selectors.** That is what
  `src/selectors.js` (one map, with fallbacks) and the panel's
  self-test are for: when a selector breaks, the worker stops and
  reports the missing key instead of guessing.
- **The tab must stay open and visible.** Use a dedicated window for
  the bridge. Background-tab throttling can slow timers (browsers
  throttle `setTimeout` in background tabs), so completion polling
  and pacing get slower if the tab is hidden — the waits are
  wall-clock based and still work, just later.

## Future: OpenAI-compatible endpoint (not built)

The intended seam for tools like Cline or Claude Code is an
OpenAI-compatible endpoint on the backend,
`POST /v1/chat/completions`, that turns a request into a card and
waits for the result — so "neon" can be called like a normal model.
That endpoint is **not built here**. The seam is already clean:
every backend call goes through `BackendClient` (`src/backend/
client.js`), and the card / verdict shapes in `backend/README.md`
are the contract such an endpoint would sit on top of. No script
changes are needed for it beyond pointing the client at the new
route.

## Prior art

- [Gemini Prompt Queue](https://github.com/nihaltp/uscripts) by
  nihaltp (MIT, per its own userscript header) — a queue userscript
  for Gemini. Borrowed as *ideas* (not code): the `data-testid`
  send/stop button fallbacks, the `title*="Send"` fallback, busy
  indicators (`aria-busy` / `data-loading` / `progressbar`) for
  generation detection, and the Enter-key fallback when no send
  button is found. All code in this repo is original; no AGPL code
  from any project is used.

## File tree

```
neon-bridge/
  src/selectors.js        one map of every selector, with fallbacks
  src/core/               pure logic, no DOM
    hash.js               sha256 + sent_hash
    errors.js             error classification (en + fa)
    extract.js            code-block extraction, stitching, CARD/END
    pacing.js             quiet hours, pace, backoff, quota guard
    message.js            prompt footer, continue message
    permission.js         permission-prompt classification (neon-mcp only)
    modes.js              per-card mode choice + MCP health
    chat.js               chat relay: senders filter, loop brake, split, rotation
    state.js              retry / escalation state machine
  src/modes/mcp.js        MCP mode: tool message + backend poll
  src/modes/link.js       link flow: read link, wait, extract, submit
  src/modes/chat.js       chat mode: summon / message / dismiss per room
  src/adapters/dom.js     shared DOM helpers + permission watcher
  src/adapters/gemini.js  everything that touches the Gemini page
  src/adapters/muse.js    Muse web app (selectors unverified)
  src/adapters/grok.js    grok.com (selectors unverified)
  src/adapters/chatgpt.js chatgpt.com (selectors unverified)
  src/adapters/index.js   adapter selection by hostname
  src/backend/client.js   all HTTP calls (GM_xmlhttpRequest)
  src/ui/panel.js         floating control panel (nb2- prefixed)
  src/main.js             queue loop wiring it all together
  build.mjs               zero-dependency build (concatenates src/)
  dist/neon-bridge.user.js  committed build output — install this
  extension/bridge.js     same blob as dist, for the Chrome extension
  test/*.test.mjs         node --test unit tests for core
  backend/README.md       backend API contract + deploy-your-own
  config.example.json     every setting with its default
```

**Adapters:** all page access lives in `src/adapters/*.js` behind
one interface (health check, model / thinking pickers, send, read
answers, quota). A new site adds one adapter file and one
`selectSite` branch; core never changes.

**Panel:** prefixed `nb2-` throughout, top-right, collapsible, so it
never collides with the v1 "Trafactor Bridge - Gemini" panel. It
never uses blocking dialogs — no `alert()`, `confirm()`, `prompt()`.

## Development

```bash
node --test   # 187 unit tests (hash, extraction/stitching, errors en+fa,
              # pacing/quiet-hours incl. overnight, state transitions,
              # strategy + MCP health, MCP poll decisions, nudge-once,
              # link flow, mode_stats + double-submit guard,
              # adapter selection, chat relay + loop brake + rotation)
node build.mjs  # rebuilds dist/neon-bridge.user.js (committed) and
                # copies it to extension/bridge.js
```

The build fails if the output contains a blocking-dialog call, a
leftover `import`/`export`, or a hardcoded account/repo name.

## Selectors not yet verified

The script was built without access to the live Gemini page. The
selectors marked `spec` in `src/selectors.js` come from verified page
facts; everything below still needs a live check by the owner (open
Gemini, run the panel's **Self-test**, and compare):

- [ ] Model picker button — no verified selector; the adapter first
      tries a button whose text names a known model, then the
      fallback selector.
- [ ] Model menu structure (`[role="menu"]` / menu items) and the
      subtitle containing "Neon 4" / "Hydrogen".
- [ ] Thinking submenu: that the last menu row opens it, that its 3
      options are low / medium / high in that order, and that the
      checkmark is `aria-checked` / `aria-selected` or a check icon.
- [ ] Send fallbacks (`button.send-button`, `aria-label` "ارسال",
      last enabled button in the input area) — only the primary
      `button[aria-label*="Send"]` is from the spec.
- [ ] Stop button selector (used for completion detection).
- [ ] Error toast selector.
- [ ] Usage page (`/usage`) quota parsing — best-effort only; a
      parse failure is logged and the worker continues.
- [ ] `model-thoughts` exclusion actually removing all thinking
      content from collected answers.
- [ ] Whether assigning the same `/app` URL (or the reload fallback
      in the adapter) reliably opens a fresh chat every time.
- [ ] **Muse web app (muse.ai) — all selectors unverified:**
      editor, send button, user/assistant turns, stop button, busy
      indicators, error toast. The DOM is unknown; these are generic
      guesses (`[contenteditable]`, `textarea`, `button[aria-label*=
      "Send"]`, `[data-message-author-role]`).
- [ ] **Grok (grok.com) — all selectors unverified:** editor
      (`textarea[placeholder*="Ask Grok"]`), send button, user/
      assistant turns (`[data-testid="user-message"]` /
      `[data-testid="assistant-message"]`), stop button, busy
      indicators, error toast.
- [ ] **ChatGPT (chatgpt.com) — all selectors unverified:** editor
      (`#prompt-textarea`), send (`button[data-testid="send-button"]`),
      user/assistant turns (`div[data-message-author-role]`), stop
      (`button[data-testid="stop-button"]`), busy indicators, error
      toast.

## Open questions

- What does the backend return for `plan` when a card has no
  settings — is `{model, thinking}` always present, or should the
  script fall back to Neon/medium? (Current code falls back to
  Neon/medium.)
- Does the supervisor's `message_indexes` refer to the 5 messages
  sent, or to the whole conversation? (Current code assumes the
  sent list.)
- On the usage page, is the remaining quota a plain percentage in
  the page text, or does it need a different parse?
- Should a `continue` turn that still ends without `END-<id>` after
  3 continues retry the whole card, or fail it? (Current code
  retries in a new chat when attempts remain.)
- For an `answered` card whose saved chat no longer loads: the
  script re-sends the original prompt, then the answer message.
  Is that the right order, or should the answer message alone carry
  the original prompt as context?
- Does `next` return one card or a list? The script accepts both
  (`{card}` or `{cards: [...]}`) and gives `answered` cards
  priority; the backend may keep returning a single card.
- The v1 panel's exact `workerId` scheme: should v2 workers share
  the backend's worker namespace, or use a separate one?
