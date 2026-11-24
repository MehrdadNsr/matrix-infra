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

import { sentHash } from './core/hash.js';
import { classifyError, isStopKind } from './core/errors.js';
import { detectQuestion, extractFinalFile, isCutOff } from './core/extract.js';
import {
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
  MAX_CONTINUES,
  MAX_QUESTIONS,
  chooseNextCard,
  createWorkerState,
  decideAfterSendFailure,
  decideAfterVerdict,
  isCancelledStatus,
  recordAsk,
  shouldStopAfterGenericFailures,
  resolvePlan,
  verdictProblem,
} from './core/state.js';
import { answerMessage, buildGemMessage, buildMessage, buildMessageWithLinks, continueMessage } from './core/message.js';
import { NB2_VERSION } from './version.js';
import { BackendClient, BridgeKeyInvalidError } from './backend/client.js';
import { GeminiAdapter, GEMINI_USAGE_URL } from './adapters/gemini.js';
import { createPanel, DEFAULT_SETTINGS } from './ui/panel.js';

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

export function start() {
  const store = createStore();
  const settings = loadSettings(store);
  const state = restoreState(store);
  const client = new BackendClient({
    backendUrl: settings.backendUrl,
    bridgeKey: settings.bridgeKey,
  });
  const adapter = new GeminiAdapter({ log: (m) => panel.log(m) });
  const lock = acquireLock(settings.workerId || 'default');

  let panel;
  // Gem mode is ON when a gemUrl is set. It can fall back to normal
  // mode for this session if the Gem does not allow model/thinking
  // selection (decided by the self-test probe at Start).
  let gemModeActive = Boolean(settings.gemUrl);

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
    try {
      await client.heartbeat({
        worker: settings.workerId,
        state: stateName,
        cardId: state.pending?.card?.id || null,
        quotaPct: state.quotaPct,
        lastError: state.stoppedReason || null,
        version: NB2_VERSION,
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
   *  Human timing: a random 2-6 s pause between the steps. */
  async function applySettings(plan) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await adapter.setModel(plan.model);
      await adapter.stepPause();
      await adapter.setThinking(plan.thinking);
      await adapter.stepPause();
      const readBack = adapter.readSettings();
      const modelOk = !readBack.model || readBack.model === plan.model;
      const thinkingOk = !readBack.thinking || readBack.thinking === plan.thinking;
      if (modelOk && thinkingOk) return { ok: true, readBack };
      log(`settings mismatch (try ${attempt + 1}): wanted ${plan.model}/${plan.thinking}`);
      await sleep(1000);
    }
    return { ok: false };
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
   * Returns 'done' | 'failed' | 'skipped'.
   */
  async function runCard(card, resume = null) {
    const maxAttempts = settings.maxAttemptsPerCard;
    const planRes = resume ? { settings: resume.plan } : await client.plan(card.id);
    const plan = resolvePlan(card, planRes.settings || {});
    const model = plan.model;
    let thinking = plan.thinking;
    let attempt = resume ? resume.attempt : card.attempts || 0;
    let continues = resume ? resume.continues : 0;
    let linksInlined = resume ? resume.linksInlined : false;
    // Ask/answer bookkeeping (persisted in pending across navigations).
    const isAnswered = card.status === 'answered';
    let questions = resume ? (resume.questions ?? 0) : (card.questions_asked ?? 0);
    let answeredStage = resume ? (resume.answeredStage || null) : null;
    let promptResent = resume ? Boolean(resume.promptResent) : false;
    let answerSent = resume ? Boolean(resume.answerSent) : false;
    let answerContext = resume ? (resume.answerContext || '') : '';
    const lastQuestion = resume ? (resume.lastQuestion || '') : '';

    log(`card #${card.seq} ${card.file_path} -> ${model}/${thinking} (${plan.reason || 'plan'})`);

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
    // the resume on load continues from it.
    if (isAnswered) {
      // The card is no longer blocked — count it once, on first entry.
      if (!resume) {
        state.blockedCount = Math.max(0, (state.blockedCount || 0) - 1);
        if (panel) panel.setBlocked(state.blockedCount, state.latestQuestion);
      }
      if (!answeredStage) {
        const base = {
          card, plan, attempt, continues, thinking, model, linksInlined,
          questions, promptResent, answerSent, answerContext, lastQuestion,
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
      if (answeredStage === 'open-chat') {
        // We just loaded the saved chat. Did it actually load?
        const health = adapter.healthCheck();
        const sameChat = window.location.href === card.chat_url ||
          window.location.href.startsWith(card.chat_url);
        if (health.ok && sameChat) {
          answeredStage = 'ready';
          log(`saved chat loaded for card #${card.seq}; continuing there`);
        } else {
          log('saved chat did not load; falling back to a new chat with the original prompt');
          state.pending = {
            card, plan, attempt, continues, thinking, model, linksInlined,
            questions, promptResent, answerSent, answerContext, lastQuestion,
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
    let skipNavigation = Boolean(resume) || (isAnswered && answeredStage === 'ready');

    while (attempt < maxAttempts) {
      attempt += 1;
      const pending = {
        card, plan, attempt: attempt - 1, continues, thinking, model, linksInlined,
        questions, answeredStage, promptResent, answerSent, answerContext, lastQuestion,
      };
      if (panel) {
        panel.setCard(`#${card.seq} ${card.file_path} · ${model}/${thinking} · attempt ${attempt}/${maxAttempts}`);
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
      state.pending = { ...pending, attempt };
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

      const applied = await applySettings({ model, thinking });
      if (!applied.ok) return failCard(card, model, 'settings mismatch');

      // Re-check right before every send (model/thinking can drift).
      const beforeSend = adapter.readSettings();
      if ((beforeSend.model && beforeSend.model !== model) ||
          (beforeSend.thinking && beforeSend.thinking !== thinking)) {
        log('model/thinking drifted before send; re-applying');
        const reapplied = await applySettings({ model, thinking });
        if (!reapplied.ok) return failCard(card, model, 'settings mismatch');
      }

      // Answered card, first attempt: send the answers to the model's
      // questions. In the fallback case the saved chat is gone, so the
      // original prompt goes first to re-establish context.
      if (isAnswered && answeredStage === 'fallback-ready' && !promptResent) {
        const promptTurn = buildTaskMessage(card, attempt);
        const ok = await adapter.insertText(promptTurn) &&
          (await sendWithBounceRetry(promptTurn)).sent;
        if (!ok) return failCard(card, model, 'could not re-send original prompt');
        const done = await adapter.waitForCompletion();
        if (done.frozen) return failCard(card, model, 'page frozen while re-sending prompt');
        promptResent = true;
        state.pending = { ...pending, attempt, promptResent };
        persistState(store, state);
      }
      let message;
      let sendingAnswer = false;
      if (isAnswered && !answerSent) {
        message = answerMessage(card.id, card.answer || '', attempt);
        sendingAnswer = true;
      } else if (answerContext) {
        // Later attempts keep the Q&A so the model is not asked
        // the same questions again in a fresh chat.
        message = `${buildTaskMessage(card, attempt)}\n\n${answerContext}`;
      } else {
        message = buildTaskMessage(card, attempt);
      }
      if (!sendingAnswer && linksInlined && card.read_links && card.read_links.length) {
        if (gemModeActive) {
          // Gem mode: the Gem's instructions own the links; the full
          // footer (and its inline-links form) is never sent there.
          log('Gem mode: skipping inline-links retry');
        } else {
          const texts = await fetchLinkedTexts(client, card.read_links, log);
          message = buildMessageWithLinks(card, texts, attempt);
        }
      }

      if (settings.dryRun) {
        log(`[dry run] would send ${message.length} chars to ${model}/${thinking}, then supervise + submit`);
        state.pending = null;
        persistState(store, state);
        return 'done';
      }

      const hash = await sentHash(message, attempt);
      const claim = await client.claim(card.id, hash);
      if (claim.duplicate) {
        log(`claim 409: card #${card.seq} was already sent; moving on`);
        state.pending = null;
        persistState(store, state);
        return 'skipped';
      }

      const inserted = await adapter.insertText(message);
      if (!inserted) return failCard(card, model, 'could not insert prompt');
      // Re-read before sending: an agent may have cancelled the card.
      if (!(await checkCardActive(card))) {
        state.pending = null;
        persistState(store, state);
        return 'skipped';
      }
      const sent = await sendWithBounceRetry(message);
      if (!sent.sent) {
        await client.setStatus(card.id, { status: 'waiting', last_error: sent.reason, model_used: model });
        const decision = decideAfterSendFailure(attempt, maxAttempts);
        if (decision.action === 'fail') return failCard(card, model, sent.reason);
        continue; // retry in a new chat (persist + navigate at loop top)
      }
      state.sentToday += 1;
      if (sendingAnswer) {
        answerSent = true;
        answerContext = lastQuestion
          ? `Earlier questions and answers:\nQ: ${lastQuestion}\nA: ${card.answer || ''}`
          : '';
        state.pending = { ...pending, attempt, answerSent, answerContext };
      }
      persistState(store, state);

      await client.setStatus(card.id, { status: 'waiting', model_used: model });
      const completion = await adapter.waitForCompletion();
      if (completion.frozen) {
        // The old chat is lost with the reload: count this attempt as
        // consumed and resume as the next attempt in a fresh chat.
        log('page frozen for 10 min; reloading into a new chat');
        state.pending = { ...pending, attempt };
        persistState(store, state);
        adapter.newChat(newChatTarget());
        await hangForever(); // the reload resumes as the next attempt
        return 'failed';
      }
      if (completion.timedOut) log('generation timed out after 10 min');

      // Supervise, with same-chat continues inside this attempt.
      let messages = adapter.readMessages(5);
      while (true) {
        const lastModel = [...messages].reverse().find((m) => m.role === 'model');
        if (lastModel && isCutOff(lastModel.text, card.id)) {
          log('answer looks cut off (no END marker / unclosed fence); supervisor decides');
        }
        const sup = await client.supervise(card.id, messages);
        let verdict = sup.verdict || {};
        // The model may ask a QUESTION block even when the supervisor
        // did not label it 'ask' — a detected QUESTION block wins.
        const detected = lastModel ? detectQuestion(lastModel.text, card.id) : null;
        if (verdict.action !== 'ask' && detected) {
          verdict = { action: 'ask', question: detected.question };
        }
        const problem = verdictProblem(verdict);
        if (problem) return failCard(card, model, `bad verdict: ${problem}`);
        log(`supervisor: ${verdict.action} — ${verdict.reason || ''}${verdict.stale ? ' (stale echo)' : ''}`);

        // Ask is a first-class state, not an error: route the question
        // to the backend (the card becomes "blocked" there), show it
        // in the panel, and move on to the next card. Never wait here.
        if (verdict.action === 'ask') {
          const askRec = recordAsk({ attempt, questions });
          if (askRec.action === 'fail') {
            return failCard(card, model, 'too many questions');
          }
          const question = verdict.question || detected?.question || verdict.reason || 'No question text received';
          await client.ask(card.id, question, window.location.href);
          questions = askRec.questions;
          state.blockedCount = (state.blockedCount || 0) + 1;
          state.latestQuestion = question;
          state.pending = {
            ...pending, attempt: askRec.attempt, questions, lastQuestion: question,
          };
          persistState(store, state);
          if (panel) panel.setBlocked(state.blockedCount, state.latestQuestion);
          log(`question routed (round ${questions}/${MAX_QUESTIONS}): ${question}`);
          return 'blocked';
        }

        // Links not read: one retry with the linked text pasted inline.
        if (verdict.action === 'retry' && !linksInlined &&
            classifyError(verdict.reason || '').kind === 'links_not_read' &&
            card.read_links && card.read_links.length) {
          linksInlined = true;
          log('supervisor says links were not read; retrying with linked text inline');
          break; // out of the supervise loop -> retry in a new chat
        }

        const decision = decideAfterVerdict({ verdict, attempt, maxAttempts, continues, thinking });
        if (decision.action === 'submit') return submitCard(card, model, messages, verdict);
        if (decision.action === 'fail') {
          return failCard(card, model, decision.note || verdict.reason || 'failed');
        }
        if (decision.action === 'escalate') {
          thinking = decision.thinking;
          log(`escalating thinking to ${thinking}`);
          break; // out of the supervise loop -> new chat, resend
        }
        if (decision.action === 'retry') break; // new chat, resend
        // decision.action === 'continue': same chat, one more turn.
        if (continues >= MAX_CONTINUES) return failCard(card, model, 'max continues reached');
        continues += 1;
        state.pending = { ...pending, attempt, continues, thinking, model, linksInlined };
        persistState(store, state);
        await adapter.insertText(continueMessage(card.id));
        await adapter.send();
        await client.setStatus(card.id, { status: 'waiting', model_used: model });
        await adapter.waitForCompletion();
        messages = adapter.readMessages(5);
        // Loop: supervise the now-longer history.
      }
      // Retry / escalate / links-inline: next while iteration navigates
      // to a new chat (persisted at its top) and resends.
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

        const next = await client.next(settings.workerId);
        const card = chooseNextCard(next);
        if (!card) {
          if (panel) panel.setState('Queue empty — polling');
          await sleep(idlePollSec() * 1000);
          continue;
        }

        const outcome = await runCard(card);
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
      // Startup self-test before any work.
      const test = adapter.selfTest();
      if (!test.ok) {
        await fullStop('selectors', `self-test failed, missing: ${test.missing.join(', ')}`);
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
    onSelfTest: async () => {
      const test = adapter.selfTest();
      log(test.ok ? 'self-test OK: editor, send, model picker found' :
        `self-test FAILED, missing: ${test.missing.join(', ')}`);
      if (panel) panel.setState(test.ok ? 'Self-test OK' : `Self-test failed: ${test.missing.join(', ')}`);
      if (test.ok && gemModeActive) {
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
  panel.setState(
    state.stoppedReason ? `Stopped: ${state.stoppedReason}` :
    !lock.held ? 'Idle — another tab is running this worker' :
    state.running ? 'Running' : 'Idle',
  );
  if (state.pending && state.pending.card) {
    panel.setCard(`#${state.pending.card.seq} ${state.pending.card.file_path} (resumed)`);
  }
  log(lock.held ? 'Neon Bridge v2 ready' : 'Neon Bridge v2 ready (idle: another tab holds the lock)');

  // Best-effort quota read when landing on the usage page.
  if (window.location.href.startsWith(GEMINI_USAGE_URL)) {
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

  // Resume automatically if the page reloaded mid-card while running.
  if (state.running && lock.held && state.pending && state.pending.card) {
    panel.setRunning(true);
    loop();
  }
}

// Tampermonkey entry point.
if (typeof window !== 'undefined') {
  start();
}
