// Main — wires core + adapter + backend + panel into the queue loop.
// This is the only file that knows the per-card flow end to end.
// It never touches the DOM directly (the adapter and panel do) and
// never talks to GitHub (the backend does).
//
// Persistence: a new chat reloads the page, so before every navigation
// the in-flight card is saved to GM storage as state.pending, and on
// load the loop resumes that card instead of fetching a new one.
// pending.attempt counts attempts already consumed, so a resume never
// re-runs (or re-claims) the same attempt twice.

import { classifyError, isStopKind } from './core/errors.js';
import { extractFinalFile } from './core/extract.js';
import {
  CHAT_IDLE_POLL_MS,
  HEARTBEAT_INTERVAL_MS,
  backoffMs,
  dailyCapReached,
  idlePollSec,
  isQuietHours,
  minutesUntilQuietEnd,
  msUntilNextRefresh,
  quotaDecision,
  randomPaceSec,
} from './core/pacing.js';
import {
  chooseNextCard,
  createWorkerState,
  isCancelledStatus,
  shouldStopAfterGenericFailures,
  resolvePlan,
} from './core/state.js';
import { chooseMode, createMcpHealth, recordMcpFallback, recordMcpSuccess } from './core/modes.js';
import { defaultCodeEnabled, nextWork } from './core/chat.js';
import { buildGemMessage, buildMessage } from './core/message.js';
import { NB2_VERSION } from './version.js';
import { BackendClient, BridgeKeyInvalidError } from './backend/client.js';
import { ADAPTERS, effectiveAgentName, selectSite } from './adapters/index.js';
import { GEMINI_USAGE_URL } from './adapters/gemini.js';
import { createPanel, DEFAULT_SETTINGS } from './ui/panel.js';
import { runPasteAttempt } from './modes/paste.js';
import { runMcpAttempt } from './modes/mcp.js';
import { runChatItem } from './modes/chat.js';

const STORE_PREFIX = 'nb2-';
const LOCK_KEY = 'nb2-lock';
const LOCK_TTL_MS = 30000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Never resolves. Used after a navigation is triggered: the current
 * page keeps running until the unload commits, so returning to the
 * loop would clear the persisted resume state before the reload.
 * Hanging here lets the reload take over instead.
 */
function hangForever() {
  return new Promise(() => {});
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** GM storage behind a tiny interface, with a memory fallback. */
export function createStore() {
  const memory = new Map();
  return {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(STORE_PREFIX + key, undefined);
          return v === undefined ? fallback : v;
        }
      } catch {
        // fall through to memory
      }
      return memory.has(STORE_PREFIX + key) ? memory.get(STORE_PREFIX + key) : fallback;
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(STORE_PREFIX + key, value);
          return;
        }
      } catch {
        // fall through to memory
      }
      memory.set(STORE_PREFIX + key, value);
    },
  };
}

export function loadSettings(store) {
  const settings = { ...DEFAULT_SETTINGS, quietHours: { ...DEFAULT_SETTINGS.quietHours } };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const saved = store.get(key, undefined);
    if (saved !== undefined) settings[key] = saved;
  }
  // mcpToolNames is a list; an old stored string is split, not kept.
  if (typeof settings.mcpToolNames === 'string') {
    settings.mcpToolNames = settings.mcpToolNames.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(settings.mcpToolNames)) settings.mcpToolNames = [...DEFAULT_SETTINGS.mcpToolNames];
  // allowedSenders is a list too.
  if (typeof settings.allowedSenders === 'string') {
    settings.allowedSenders = settings.allowedSenders.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(settings.allowedSenders) || !settings.allowedSenders.length) {
    settings.allowedSenders = [...DEFAULT_SETTINGS.allowedSenders];
  }
  if (!['auto', 'mcp', 'paste'].includes(settings.mode)) settings.mode = 'auto';
  for (const key of ['mcpPickupTimeoutSec', 'mcpTaskTimeoutMin']) {
    const n = Number(settings[key]);
    settings[key] = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS[key];
  }
  return settings;
}

/**
 * Single-tab lock: one worker per browser. A second tab sees a fresh
 * heartbeat and stays idle. Returns { held, tabId, release }.
 */
export function acquireLock(workerId) {
  const tabId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  let held = false;
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    if (!existing || Date.now() - existing.heartbeat > LOCK_TTL_MS) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ workerId, tabId, heartbeat: Date.now() }));
      held = true;
    }
  } catch {
    held = true; // no storage: assume this is the only tab
  }
  const beat = setInterval(() => {
    if (!held) return;
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ workerId, tabId, heartbeat: Date.now() }));
    } catch {
      // ignore
    }
  }, 10000);
  return {
    held,
    tabId,
    release() {
      clearInterval(beat);
      try {
        const raw = localStorage.getItem(LOCK_KEY);
        if (raw && JSON.parse(raw).tabId === tabId) localStorage.removeItem(LOCK_KEY);
      } catch {
        // ignore
      }
    },
  };
}

function persistState(store, state) {
  store.set('state', state);
}

function restoreState(store) {
  const saved = store.get('state', null);
  if (saved && typeof saved === 'object') return { ...createWorkerState(), ...saved };
  return createWorkerState();
}

/** Fetch linked files inline (max 60 KB each) for the links-not-read retry. */
async function fetchLinkedTexts(client, urls, log) {
  const out = [];
  for (const url of urls.slice(0, 5)) {
    try {
      const text = await client.fetchText(`${url}?raw=1`);
      out.push({ url, text });
    } catch (err) {
      log(`linked file fetch failed (${url}): ${err.message}`);
    }
  }
  return out;
}

export async function start() {
  const store = createStore();
  const settings = loadSettings(store);
  const state = restoreState(store);
  const client = new BackendClient({
    backendUrl: settings.backendUrl,
    bridgeKey: settings.bridgeKey,
  });

  // One tab = one worker, one site. The adapter is picked by
  // hostname (gemini / muse / grok / chatgpt). On an unknown host
  // the script was never meant to run: log and stop.
  const site = selectSite(window.location.hostname, settings.museDomain);
  if (!site) {
    console.warn(`[nb2] no adapter for host ${window.location.hostname}; not starting`);
    return;
  }
  const AdapterClass = ADAPTERS[site];
  const adapter = new AdapterClass({ log: (m) => panel.log(m), museDomain: settings.museDomain });
  const agent = effectiveAgentName(settings.agentName, site);
  // Code cards exist only on Gemini so far: on muse/grok/chatgpt
  // codeEnabled defaults to false unless the user turned it on.
  const codeEnabled = settings.codeEnabled !== false && (defaultCodeEnabled(site) || store.get('codeEnabled', undefined) !== undefined);
  const chatEnabled = settings.chatEnabled !== false;
  // Show the effective value in the panel: on muse/grok/chatgpt the
  // box starts unchecked until the user turns code on explicitly.
  if (!codeEnabled) settings.codeEnabled = false;
  const lock = acquireLock(settings.workerId || 'default');

  let panel;
  // Room name while a chat item is being processed (null otherwise);
  // the mode line and heartbeat state show it.
  let activeChatRoom = null;
  // Gem mode is ON when a gemUrl is set. It can fall back to normal
  // mode for this session if the Gem does not allow model/thinking
  // selection (decided by the self-test probe at Start). Gemini only.
  let gemModeActive = Boolean(settings.gemUrl) && site === 'gemini';

  const log = (message) => {
    if (panel) panel.log(message);
  };

  /** Message for one attempt: Gem mode sends only CARD + task + reminder. */
  function buildTaskMessage(card, attempt) {
    return gemModeActive ? buildGemMessage(card, attempt) : buildMessage(card, attempt);
  }

  /** Target for a "new chat" navigation: the Gem in Gem mode, /app otherwise. */
  function newChatTarget() {
    return gemModeActive && settings.gemUrl ? settings.gemUrl : undefined;
  }

  /**
   * Heartbeat so other agents can see whether the bridge is alive:
   * every 60 s and on every state change. A failed heartbeat never
   * stops the worker.
   */
  async function sendHeartbeat(stateName) {
    // While running, the heartbeat state carries the current mode,
    // e.g. "running:mcp", "running:paste", or "running:chat:<room>".
    let name = stateName;
    if (stateName === 'running') {
      name = activeChatRoom ? `running:chat:${activeChatRoom}` : `running:${effectiveMode().mode}`;
    }
    try {
      await client.heartbeat({
        worker: settings.workerId,
        state: name,
        cardId: state.pending?.card?.id || null,
        quotaPct: state.quotaPct,
        lastError: state.stoppedReason || null,
        version: NB2_VERSION,
        lastAutoApproval: state.lastAutoApproval,
      });
    } catch (err) {
      log(`heartbeat failed: ${err.message}`);
    }
  }

  /**
   * Re-read a card before a step (send / submit). If an agent
   * cancelled it (status skipped/failed), abort the card cleanly.
   * Returns true when the card may proceed. A backend that does not
   * provide the card action returns null from client.card(), which
   * also means "proceed".
   */
  async function checkCardActive(card) {
    let fresh = null;
    try {
      fresh = await client.card(card.id);
    } catch (err) {
      log(`card re-read failed (${err.message}); proceeding`);
      return true;
    }
    if (!fresh) return true;
    if (isCancelledStatus(fresh.status)) {
      log(`card #${card.seq} was ${fresh.status} by an agent; aborting cleanly`);
      return false;
    }
    return true;
  }

  /** Full stop: persist, notify the owner once, show it in the panel. */
  async function fullStop(kind, message) {
    state.running = false;
    state.stoppedReason = message;
    permissionWatcher?.stop();
    persistState(store, state);
    if (panel) {
      panel.setState(`Stopped: ${message}`);
      panel.setRunning(false);
    }
    log(`STOP (${kind}): ${message}`);
    sendHeartbeat('stopped');
    if (settings.alertOnStop) {
      try {
        await client.notifyOwner(kind, message);
      } catch (err) {
        log(`owner notification failed: ${err.message}`);
      }
    }
  }

  /** Set model + thinking, read both back, retry once on mismatch.
   *  Human timing: a random 2-6 s pause between the steps.
   *  Thinking is verified by reopening the model menu and reading
   *  aria-checked there: the plain read-back cannot see the options
   *  once the menu closes. */
  async function applySettings(plan) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await adapter.setModel(plan.model);
      await adapter.stepPause();
      await adapter.setThinking(plan.thinking);
      await adapter.stepPause();
      const readBack = adapter.readSettings();
      const modelOk = !readBack.model || readBack.model === plan.model;
      // Menu verification exists only on Gemini; other adapters
      // report null thinking, which counts as OK (as before).
      const thinkingViaMenu = typeof adapter.readThinkingViaMenu === 'function'
        ? await adapter.readThinkingViaMenu()
        : null;
      const thinking = thinkingViaMenu || readBack.thinking;
      const thinkingOk = !thinking || thinking === plan.thinking;
      if (modelOk && thinkingOk) return { ok: true, readBack };
      log(`settings mismatch (try ${attempt + 1}): wanted ${plan.model}/${plan.thinking}`);
      await sleep(1000);
    }
    return { ok: false };
  }

  /**
   * The mode the worker is currently in: the in-flight card's mode,
   * else the mode the next card would use. pasteUntil is the end of
   * the MCP-health paste window (0 when none).
   */
  function effectiveMode() {
    const health = state.mcpHealth || createMcpHealth();
    const now = Date.now();
    const inFlight = state.pending?.mode;
    const pasteUntil = health.pasteUntil && now < health.pasteUntil ? health.pasteUntil : 0;
    if (inFlight) return { mode: inFlight, pasteUntil };
    const mode = chooseMode({ modeSetting: settings.mode, health, card: { status: 'queued' }, now });
    return { mode, pasteUntil };
  }

  function modeLineText() {
    if (activeChatRoom) return `Mode: CHAT — ${activeChatRoom}`;
    const { mode, pasteUntil } = effectiveMode();
    if (mode === 'mcp') return 'Mode: MCP';
    if (pasteUntil) {
      const until = new Date(pasteUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `Mode: PASTE until ${until}`;
    }
    return 'Mode: PASTE';
  }

  function updateModeLine() {
    if (panel) panel.setMode(modeLineText());
  }

  function roomsLineText() {
    const names = Object.values(state.rooms || {}).map((r) => r.roomName || r.roomId);
    return names.length ? names.join(', ') : 'none';
  }

  function updateRooms() {
    if (panel) panel.setRooms(roomsLineText());
  }

  /** Chat-mode context handed to src/modes/chat.js. */
  const chatCtx = {
    client,
    adapter,
    settings,
    state,
    agent,
    agentName: agent,
    log,
    sleep,
    isRunning: () => state.running,
    persistState: () => persistState(store, state),
    updateRooms,
    setLastChat: (text) => {
      state.lastChatItem = text;
      persistState(store, state);
      if (panel) panel.setLastChat(text);
    },
  };

  /** Disabled tab: the adapter self-test failed (selectors missing). */
  async function disableTab(message) {
    state.running = false;
    state.stoppedReason = message;
    persistState(store, state);
    if (panel) {
      panel.setState(`Disabled: ${message}`);
      panel.setRunning(false);
    }
    log(`DISABLED: ${message}`);
    sendHeartbeat('disabled');
    if (settings.alertOnStop) {
      try {
        await client.notifyOwner('selectors', message);
      } catch (err) {
        log(`owner notification failed: ${err.message}`);
      }
    }
  }

  /** Send the message, handling the bounce-back symptom once. */
  async function sendWithBounceRetry(message) {
    if (!(await adapter.send())) return { sent: false, reason: 'send button not found' };
    const appeared = await adapter.waitForUserQuery(message, 10000);
    if (appeared) return { sent: true };
    if (adapter.editorHoldsText(message)) {
      log('message bounced back into the editor; pressing send once more');
      if (!(await adapter.send())) return { sent: false, reason: 'send button not found on retry' };
      const appearedAgain = await adapter.waitForUserQuery(message, 10000);
      if (appearedAgain) return { sent: true };
    }
    return { sent: false, reason: 'message did not appear as a user turn' };
  }

  async function failCard(card, model, lastError) {
    await client.setStatus(card.id, { status: 'failed', last_error: lastError, model_used: model });
    state.pending = null;
    persistState(store, state);
    return 'failed';
  }

  async function submitCard(card, model, messages, verdict) {
    // Re-read before submitting: an agent may have cancelled the card.
    if (!(await checkCardActive(card))) {
      state.pending = null;
      persistState(store, state);
      return 'skipped';
    }
    const content = extractFinalFile(messages, verdict.message_indexes, card.id);
    if (!content) return failCard(card, model, 'no code extracted');
    const submitted = await client.submit(card.id, content, {
      model_used: model, account_used: settings.workerId,
    });
    log(`submitted card #${card.seq}: ${submitted.pr_url || submitted.commit || 'ok'}`);
    if (panel) panel.setCard(`#${card.seq} done — ${submitted.pr_url || ''}`);
    state.consecutiveGenericFailures = 0;
    state.pending = null;
    persistState(store, state);
    return 'done';
  }

  /**
   * One card, start to finish. `resume` is a persisted pending entry
   * (after a navigation reload): same card, attempts already consumed,
   * and the fresh chat is already open, so no second navigation.
   * Returns 'done' | 'failed' | 'skipped' | 'blocked' | 'paused'.
   * 'paused' means the user paused mid-card (MCP poll): pending is
   * kept for resume, and the caller must not clear it.
   */
  async function runCard(card, resume = null) {
    const maxAttempts = settings.maxAttemptsPerCard;
    const planRes = resume ? { settings: resume.plan } : await client.plan(card.id);
    const plan = resolvePlan(card, planRes.settings || {});
    const model = plan.model;
    if (!state.mcpHealth) state.mcpHealth = createMcpHealth();

    // Attempt state (persisted in pending across navigations).
    const s = {
      card, plan, model,
      thinking: plan.thinking,
      maxAttempts,
      attempt: resume ? resume.attempt : card.attempts || 0,
      continues: resume ? resume.continues : 0,
      linksInlined: resume ? resume.linksInlined : false,
      isAnswered: card.status === 'answered',
      questions: resume ? (resume.questions ?? 0) : (card.questions_asked ?? 0),
      answeredStage: resume ? (resume.answeredStage || null) : null,
      promptResent: resume ? Boolean(resume.promptResent) : false,
      answerSent: resume ? Boolean(resume.answerSent) : false,
      answerContext: resume ? (resume.answerContext || '') : '',
      lastQuestion: resume ? (resume.lastQuestion || '') : '',
      mode: resume ? (resume.mode || null) : null,
      mcp: resume ? (resume.mcp || null) : null,
    };
    if (!s.mode) {
      s.mode = chooseMode({ modeSetting: settings.mode, health: state.mcpHealth, card, now: Date.now() });
    }

    log(`card #${card.seq} ${card.file_path} -> ${model}/${s.thinking} (${plan.reason || 'plan'}) [${s.mode}]`);

    // Quota guard: below 20% only hydrogen/low may run.
    const quota = quotaDecision(state.quotaPct, plan);
    if (!quota.allowed) {
      log(`quota guard: ${quota.reason}; skipping card #${card.seq}`);
      await client.setStatus(card.id, { status: 'skipped', last_error: quota.reason, model_used: model });
      state.pending = null;
      persistState(store, state);
      return 'skipped';
    }

    // Answered card: open its saved chat if it still loads, otherwise
    // fall back to a new chat that re-sends the original prompt.
    // Each navigation reloads the page; the stage is persisted and
    // the resume on load continues from it. Answered cards always
    // run in paste mode (their answer is chat text).
    if (s.isAnswered) {
      // The card is no longer blocked — count it once, on first entry.
      if (!resume) {
        state.blockedCount = Math.max(0, (state.blockedCount || 0) - 1);
        if (panel) panel.setBlocked(state.blockedCount, state.latestQuestion);
      }
      if (!s.answeredStage) {
        const base = {
          card: s.card, plan: s.plan, attempt: s.attempt, continues: s.continues,
          thinking: s.thinking, model: s.model, linksInlined: s.linksInlined,
          questions: s.questions, promptResent: s.promptResent,
          answerSent: s.answerSent, answerContext: s.answerContext,
          lastQuestion: s.lastQuestion, mode: s.mode, mcp: s.mcp,
        };
        if (card.chat_url) {
          state.pending = { ...base, answeredStage: 'open-chat' };
          persistState(store, state);
          log(`opening saved chat for answered card #${card.seq}`);
          window.location.href = card.chat_url;
          await hangForever(); // the reload resumes the card
          return 'blocked';
        }
        state.pending = { ...base, answeredStage: 'fallback-ready' };
        persistState(store, state);
        adapter.newChat(newChatTarget());
        await hangForever(); // the reload resumes the card
        return 'blocked';
      }
      if (s.answeredStage === 'open-chat') {
        // We just loaded the saved chat. Did it actually load?
        const health = adapter.healthCheck();
        const sameChat = window.location.href === card.chat_url ||
          window.location.href.startsWith(card.chat_url);
        if (health.ok && sameChat) {
          s.answeredStage = 'ready';
          log(`saved chat loaded for card #${card.seq}; continuing there`);
        } else {
          log('saved chat did not load; falling back to a new chat with the original prompt');
          state.pending = {
            card: s.card, plan: s.plan, attempt: s.attempt, continues: s.continues,
            thinking: s.thinking, model: s.model, linksInlined: s.linksInlined,
            questions: s.questions, promptResent: s.promptResent,
            answerSent: s.answerSent, answerContext: s.answerContext,
            lastQuestion: s.lastQuestion, mode: s.mode, mcp: s.mcp,
            answeredStage: 'fallback-ready',
          };
          persistState(store, state);
          adapter.newChat(newChatTarget());
          await hangForever(); // the reload resumes the card
          return 'blocked';
        }
      }
    }

    // A resume is already in a fresh chat; an answered card whose saved
    // chat loaded must also stay where it is — never navigate away.
    let skipNavigation = Boolean(resume) || (s.isAnswered && s.answeredStage === 'ready');

    // Shared wiring for the mode attempts (see src/modes/paste.js).
    const ctx = {
      store, settings, state, client, adapter,
      log, sleep, hangForever,
      newChatTarget,
      applySettings, sendWithBounceRetry, failCard, submitCard, checkCardActive,
      fetchLinkedTexts: (urls) => fetchLinkedTexts(client, urls, log),
      buildTaskMessage,
      get panel() { return panel; },
      get gemModeActive() { return gemModeActive; },
      isRunning: () => state.running,
      updatePending: (patch) => {
        state.pending = { ...(state.pending || {}), ...patch };
        persistState(store, state);
      },
      persistState: () => persistState(store, state),
      clearPending: () => {
        state.pending = null;
        persistState(store, state);
      },
    };

    while (s.attempt < maxAttempts) {
      s.attempt += 1;
      const pending = {
        card: s.card, plan: s.plan, attempt: s.attempt - 1, continues: s.continues,
        thinking: s.thinking, model: s.model, linksInlined: s.linksInlined,
        questions: s.questions, answeredStage: s.answeredStage,
        promptResent: s.promptResent, answerSent: s.answerSent,
        answerContext: s.answerContext, lastQuestion: s.lastQuestion,
        mode: s.mode, mcp: s.mcp,
      };
      if (panel) {
        panel.setCard(`#${card.seq} ${card.file_path} · ${model}/${s.thinking} · attempt ${s.attempt}/${maxAttempts} · ${s.mode.toUpperCase()}`);
      }

      // Always a NEW chat per card (long chats burn quota and repeat).
      // Navigation reloads the page: persist first, resume on load.
      if (!settings.dryRun && !skipNavigation) {
        state.pending = pending;
        persistState(store, state);
        adapter.newChat(newChatTarget());
        await hangForever(); // the reload resumes the card
        return 'failed';
      }
      skipNavigation = false;
      state.pending = { ...pending, attempt: s.attempt };
      persistState(store, state);

      const health = adapter.healthCheck();
      if (!health.ok) {
        const kind = health.kind || 'unknown';
        if (isStopKind(kind)) {
          await fullStop(kind === 'weekly_cap' ? 'stopped' : 'account', `health check failed: ${health.problem}`);
          return 'failed';
        }
        return failCard(card, model, health.problem);
      }

      const applied = await applySettings({ model, thinking: s.thinking });
      if (!applied.ok) return failCard(card, model, 'settings mismatch');

      // Re-check right before every send (model/thinking can drift).
      const beforeSend = adapter.readSettings();
      if ((beforeSend.model && beforeSend.model !== model) ||
          (beforeSend.thinking && beforeSend.thinking !== s.thinking)) {
        log('model/thinking drifted before send; re-applying');
        const reapplied = await applySettings({ model, thinking: s.thinking });
        if (!reapplied.ok) return failCard(card, model, 'settings mismatch');
      }

      const result = s.mode === 'mcp'
        ? await runMcpAttempt(ctx, s)
        : await runPasteAttempt(ctx, s);

      // MCP demonstrably worked (done, blocked via tools, or a
      // backend "failed" status): reset the fallback streak.
      if (s.mode === 'mcp' && (result.outcome === 'done' || result.outcome === 'blocked' || result.mcpWorked)) {
        state.mcpHealth = recordMcpSuccess(state.mcpHealth);
        persistState(store, state);
        updateModeLine();
      }
      if (result.outcome === 'done' || result.outcome === 'failed' ||
          result.outcome === 'skipped' || result.outcome === 'blocked') {
        return result.outcome;
      }
      if (result.outcome === 'paused') return 'paused';
      if (result.outcome === 'fallback') {
        log(`MCP fallback: ${result.reason}`);
        if (settings.mode === 'mcp') {
          return failCard(card, model, `MCP fallback: ${result.reason}`);
        }
        state.mcpHealth = recordMcpFallback(state.mcpHealth, Date.now());
        persistState(store, state);
        s.mode = 'paste';
        s.mcp = null;
        updateModeLine();
        continue; // same card, new chat, attempt + 1, in paste mode
      }
      // 'retry' / 'escalate': next attempt in a new chat.
    }

    return failCard(card, model, 'max attempts reached');
  }

  /** The queue loop. */
  async function loop() {
    // Daily counter resets on a new local day.
    if (state.sentDate !== todayKey()) {
      state.sentDate = todayKey();
      state.sentToday = 0;
    }

    // Resume an in-flight card first (after a navigation reload).
    if (state.pending && state.pending.card) {
      const pending = state.pending;
      log(`resuming card #${pending.card.seq} after navigation`);
      await runCard(pending.card, pending);
    }

    while (state.running) {
      try {
        if (isQuietHours(new Date(), settings.quietHours)) {
          const mins = minutesUntilQuietEnd(new Date(), settings.quietHours);
          if (panel) panel.setState(`Quiet hours — resumes in ~${mins} min`);
          await sleep(Math.min(mins, 5) * 60 * 1000);
          continue;
        }
        if (dailyCapReached(state.sentToday, settings.dailySoftCap)) {
          if (panel) panel.setState(`Daily soft cap reached (${state.sentToday}/${settings.dailySoftCap})`);
          await sleep(5 * 60 * 1000);
          continue;
        }
        if (state.quotaPct === 0) {
          const waitMs = msUntilNextRefresh(new Date());
          if (panel) panel.setState(`Quota 0% — next refresh in ~${Math.round(waitMs / 60000)} min`);
          await sleep(Math.min(waitMs, 5 * 60 * 1000));
          continue;
        }

        updateModeLine();

        // Chat first: room items have priority over code cards, but
        // never interrupt a card while the AI is generating — room_poll
        // only runs here, between cards, and runChatItem re-checks
        // adapter.isGenerating() before every send.
        let chatItem = null;
        if (chatEnabled) {
          try {
            const res = await client.roomPoll(settings.workerId, agent);
            chatItem = res && res.item ? res.item : null;
          } catch (err) {
            log(`room_poll failed: ${err.message}`);
          }
        }
        if (chatItem) {
          const work = nextWork({ chatEnabled, codeEnabled, hasChatItem: true, hasCard: false });
          if (work === 'chat') {
            activeChatRoom = chatItem.room_name || chatItem.room_id;
            updateModeLine();
            sendHeartbeat('running');
            const outcome = await runChatItem(chatCtx, chatItem);
            activeChatRoom = null;
            updateModeLine();
            if (outcome === 'navigating') {
              // The page is reloading into the room's chat; resume
              // on load. Hanging here keeps the loop from clearing
              // the persisted resume state before the unload.
              await hangForever();
              return;
            }
            if (outcome === 'deferred') {
              // AI is generating: leave the item queued and fall
              // through to the code card path below.
            } else {
              // Chat pacing: random 5-20 s, counts toward the cap.
              const chatPace = settings.dryRun ? 2 : randomPaceSec(5, 20);
              if (panel) panel.setState(`Chat pacing ${chatPace}s…`);
              await sleep(chatPace * 1000);
              continue;
            }
          }
        }

        if (!codeEnabled) {
          if (panel) panel.setState('Chat only — polling');
          await sleep(CHAT_IDLE_POLL_MS);
          continue;
        }
        const next = await client.next(settings.workerId);
        const card = chooseNextCard(next);
        if (!card) {
          if (panel) panel.setState('Queue empty — polling');
          await sleep((chatEnabled ? CHAT_IDLE_POLL_MS : idlePollSec()) * 1000);
          continue;
        }

        const outcome = await runCard(card);
        if (outcome === 'paused') {
          // Paused mid-card (MCP poll): pending is kept for resume,
          // so the loop stops here without clearing it.
          break;
        }
        if (outcome === 'failed') {
          state.consecutiveGenericFailures += 1;
          if (shouldStopAfterGenericFailures(state.consecutiveGenericFailures)) {
            await fullStop('account', '3 consecutive cards failed with generic errors');
            break;
          }
        } else {
          state.consecutiveGenericFailures = 0;
        }
        state.pending = null;
        persistState(store, state);
        sendHeartbeat('running'); // state change: card finished

        // Pace before the next message.
        const paceSec = settings.dryRun ? 2 : randomPaceSec(settings.paceMinSec, settings.paceMaxSec);
        if (panel) panel.setState(`Pacing ${paceSec}s before the next card…`);
        await sleep(paceSec * 1000);
      } catch (err) {
        if (err instanceof BridgeKeyInvalidError) {
          await fullStop('stopped', 'key invalid — check bridgeKey in the panel');
          break;
        }
        const found = classifyError(err.message || '');
        log(`loop error (${found.kind}): ${found.text || err.message}`);
        if (isStopKind(found.kind)) {
          await fullStop('account', found.text || err.message);
          break;
        }
        await sleep(backoffMs(1));
      }
    }
  }

  panel = createPanel({
    store,
    settings,
    onStart: async () => {
      if (!settings.backendUrl || !settings.bridgeKey || !settings.workerId) {
        log('set backendUrl, bridgeKey and workerId in the panel first');
        return;
      }
      if (!lock.held) {
        log('another tab holds this worker; this tab stays idle');
        if (panel) panel.setState('Idle — another tab is running this worker');
        return;
      }
      // Startup self-test before any work. A failure runs this tab
      // "disabled" (heartbeat + owner alert kind "selectors") —
      // never guess silently with broken selectors.
      const test = adapter.selfTest();
      if (!test.ok) {
        await disableTab(`self-test failed, missing: ${test.missing.join(', ')}`);
        return;
      }
      // Gem mode: confirm model + thinking can still be selected
      // inside the Gem. If not, fall back to normal mode for this
      // session (the saved gemUrl setting is left alone).
      if (gemModeActive) {
        const probe = await adapter.probeModelControls();
        if (!probe.modelSelectable || !probe.thinkingSelectable) {
          log(`Gem mode: model/thinking not selectable inside the Gem (model: ${probe.modelSelectable}, thinking: ${probe.thinkingSelectable}); falling back to normal mode`);
          gemModeActive = false;
        } else {
          log('Gem mode: model + thinking selectable inside the Gem');
        }
      }
      client.backendUrl = settings.backendUrl;
      client.bridgeKey = settings.bridgeKey;
      state.running = true;
      state.stoppedReason = '';
      persistState(store, state);
      panel.setRunning(true);
      panel.setState(gemModeActive ? 'Running (Gem mode)' : 'Running');
      log(gemModeActive ? 'started (Gem mode)' : 'started');
      sendHeartbeat('running');
      loop();
    },
    onPause: () => {
      state.running = false;
      persistState(store, state);
      if (panel) {
        panel.setRunning(false);
        panel.setState('Paused');
      }
      log('paused');
      sendHeartbeat('paused');
    },
    onLeaveAllRooms: async () => {
      const rooms = Object.values(state.rooms || {});
      for (const room of rooms) {
        try {
          await client.roomPresence(agent, room.roomId, 'offline');
        } catch (err) {
          log(`room_presence offline failed (${room.roomId}): ${err.message}`);
        }
      }
      state.rooms = {};
      state.pendingChat = null;
      persistState(store, state);
      updateRooms();
      if (panel) panel.setLastChat('Left all rooms');
      log(`left ${rooms.length} room(s)`);
    },
    onSelfTest: async () => {
      const test = adapter.selfTest();
      log(test.ok ? 'self-test OK: editor, send, model picker found' :
        `self-test FAILED, missing: ${test.missing.join(', ')}`);
      if (panel) panel.setState(test.ok ? 'Self-test OK' : `Self-test failed: ${test.missing.join(', ')}`);
      if (test.ok && gemModeActive && site === 'gemini') {
        const probe = await adapter.probeModelControls();
        if (!probe.modelSelectable || !probe.thinkingSelectable) {
          log(`Gem probe FAILED (model: ${probe.modelSelectable}, thinking: ${probe.thinkingSelectable}); falling back to normal mode`);
          gemModeActive = false;
        } else {
          log('Gem probe OK: model + thinking selectable inside the Gem');
        }
      }
    },
  });

  // Heartbeat every 60 s while running, so other agents can see the
  // bridge is alive even between cards.
  setInterval(() => {
    if (state.running) sendHeartbeat('running');
  }, HEARTBEAT_INTERVAL_MS);
  panel.setRunning(state.running);
  panel.setQuota(state.quotaPct);
  panel.setBlocked(state.blockedCount || 0, state.latestQuestion || '');
  panel.setSite(`${site} (${window.location.hostname})`);
  panel.setAgent(agent);
  updateRooms();
  panel.setLastChat(state.lastChatItem || '');
  updateModeLine();
  panel.setState(
    state.stoppedReason ? `Stopped: ${state.stoppedReason}` :
    !lock.held ? 'Idle — another tab is running this worker' :
    state.running ? 'Running' : 'Idle',
  );
  if (state.pending && state.pending.card) {
    panel.setCard(`#${state.pending.card.seq} ${state.pending.card.file_path} (resumed)`);
  }
  log(lock.held ? 'Neon Bridge v2 ready' : 'Neon Bridge v2 ready (idle: another tab holds the lock)');

  // Permission-prompt watcher (neon-mcp auto-approve). It runs for
  // the whole page session; approvals only happen while the worker
  // runs, and an unknown prompt pauses the worker instead of ever
  // clicking anything. See src/core/permission.js for the rule.
  let permissionWatcher = null;
  permissionWatcher = adapter.startPermissionWatcher({
    getConfig: () => ({ serverName: settings.mcpServerName, toolNames: settings.mcpToolNames }),
    isActive: () => state.running && lock.held,
    onApproved: ({ tool, serverName }) => {
      const label = `auto-approved ${tool || 'tool'} for ${serverName}`;
      state.lastAutoApproval = label;
      persistState(store, state);
      sendHeartbeat('running'); // state change: approval to report
    },
    onUnknown: (promptText) => {
      // Only the tab holding the worker acts on prompts; the idle
      // tab never pauses or alerts for them.
      if (!lock.held) return;
      // Never click anything. Pause the worker, show it in the
      // panel, and alert the owner (this alert is not gated on
      // alertOnStop: it is the prompt-injection guard).
      state.running = false;
      persistState(store, state);
      if (panel) {
        panel.setRunning(false);
        panel.setState(`Paused — unknown permission prompt: ${promptText.slice(0, 80)}`);
      }
      log(`unknown permission prompt, NOT approved: ${promptText}`);
      client.notifyOwner('permission', promptText).catch((err) => {
        log(`permission alert failed: ${err.message}`);
      });
      sendHeartbeat('paused');
    },
  });

  // Best-effort quota read when landing on the usage page (Gemini only).
  if (site === 'gemini' && window.location.href.startsWith(GEMINI_USAGE_URL)) {
    const pct = adapter.readQuotaFromUsagePage();
    if (pct != null) {
      state.quotaPct = pct;
      persistState(store, state);
      panel.setQuota(pct);
      log(`quota from usage page: ${pct}% remaining`);
    } else {
      log('quota read from usage page failed; continuing without it');
    }
  }

  // Resume automatically if the page reloaded mid-card / mid-chat-item
  // while running. A failed self-test disables the tab instead.
  if (state.running && lock.held) {
    if (state.pendingChat && state.pendingChat.item) {
      const test = adapter.selfTest();
      if (!test.ok) {
        await disableTab(`self-test failed, missing: ${test.missing.join(', ')}`);
        return;
      }
      panel.setRunning(true);
      const outcome = await runChatItem(chatCtx, state.pendingChat.item);
      if (outcome === 'navigating') {
        await hangForever();
        return;
      }
    }
    if (state.pending && state.pending.card) {
      panel.setRunning(true);
      loop();
    }
  }
}

// Tampermonkey entry point.
if (typeof window !== 'undefined') {
  start();
}
