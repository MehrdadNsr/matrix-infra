# Neon Bridge v2

A Tampermonkey userscript that works through a queue of coding task
cards on [Gemini](https://gemini.google.com). For each card it picks
the model and thinking level, sends the prompt to Gemini (model
"Neon 4"), collects the answer, gets a verdict from a supervisor, and
submits the final file to a backend. The backend commits the file to a
branch and opens a PR. **The script never touches GitHub directly.**

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
5. Model + thinking are set, then **read back**. Mismatch → retry
   once → card failed with "settings mismatch".
6. The message is the card prompt plus a footer asking Gemini to start
   with `CARD <id>`, output exactly one file in one fenced block, and
   end with `END-<id>` (or `CONTINUE` if it must stop early).
7. `sent_hash = sha256(message + attempt)` is claimed first. A `409`
   means the message was already sent — the card is skipped.
8. Insert + send. Within 10 s a new `user-query` with our text must
   appear; if the text bounced back into the editor (a known outage
   symptom) send is pressed once more.
9. Wait for completion: stop button gone **and** answer text unchanged
   for 8 s. Hard timeout 10 min. Status `waiting` while generating.
10. The last 5 messages (thinking removed) go to `supervise`:
    `accept` → extract + stitch + submit; `continue` → same-chat
    "Continue…" (max 3); `retry` → new chat, resend; `escalate` →
    one thinking level up, new chat, resend; `fail` → card failed.
    `ask` is a first-class verdict, not an error — see below.
11. Random pace before the next message.

## Questions and escalation

The model is told in the footer: if anything is unclear or
contradicts the repo, do **not** guess — output only a block starting
with `QUESTION <id>`, list the questions, end with `END-<id>`, and
stop. The supervisor may also return verdict `ask` with a
`question`. Either way:

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
    state.js              retry / escalation state machine
  src/adapters/gemini.js  everything that touches the Gemini page
  src/backend/client.js   all HTTP calls (GM_xmlhttpRequest)
  src/ui/panel.js         floating control panel (nb2- prefixed)
  src/main.js             queue loop wiring it all together
  build.mjs               zero-dependency build (concatenates src/)
  dist/neon-bridge.user.js  committed build output — install this
  test/*.test.mjs         node --test unit tests for core
  backend/README.md       backend API contract + deploy-your-own
  config.example.json     every setting with its default
```

**Adapters:** all Gemini page access lives in
`src/adapters/gemini.js` behind one interface (health check, model /
thinking pickers, send, read answers, quota). An AI Studio or
ChatGPT adapter implements the same interface; core never changes.

**Panel:** prefixed `nb2-` throughout, top-right, collapsible, so it
never collides with the v1 "Trafactor Bridge - Gemini" panel. It
never uses blocking dialogs — no `alert()`, `confirm()`, `prompt()`.

## Development

```bash
node --test   # 72 unit tests (hash, extraction/stitching, errors en+fa,
              # pacing/quiet-hours incl. overnight, state transitions)
node build.mjs  # rebuilds dist/neon-bridge.user.js (committed)
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
