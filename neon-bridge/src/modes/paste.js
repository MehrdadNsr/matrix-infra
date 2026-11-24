// Paste mode — the original flow, moved here unchanged in behaviour:
// send the prompt in the chat, wait for the answer, supervise it,
// extract the code and submit. One attempt per call; the caller
// (main.js) owns the attempt loop, the new-chat navigation, the
// health check and the settings application.
//
// `ctx` (built by main.js) carries the shared wiring: client,
// adapter, settings, state, panel, log, sleep, hangForever,
// newChatTarget, applySettings, sendWithBounceRetry, failCard,
// submitCard, checkCardActive, fetchLinkedTexts, buildTaskMessage,
// gemModeActive, isRunning, updatePending, persistState, clearPending.
// `s` is the attempt state (persisted in pending across navigations):
// card, plan, model, thinking, attempt, maxAttempts, continues,
// linksInlined, isAnswered, questions, answeredStage, promptResent,
// answerSent, answerContext, lastQuestion, mode, mcp.
//
// Returns { outcome, reason? } where outcome is 'done' | 'failed' |
// 'skipped' | 'blocked' | 'retry' | 'escalate'. Terminal failures
// call ctx.failCard themselves, exactly as the flow did before the
// split; 'retry' / 'escalate' mean "next attempt in a new chat".

import { sentHash } from '../core/hash.js';
import { classifyError } from '../core/errors.js';
import { detectQuestion, isCutOff } from '../core/extract.js';
import {
  MAX_CONTINUES,
  MAX_QUESTIONS,
  decideAfterSendFailure,
  decideAfterVerdict,
  recordAsk,
  verdictProblem,
} from '../core/state.js';
import { answerMessage, buildMessageWithLinks, continueMessage } from '../core/message.js';

export async function runPasteAttempt(ctx, s) {
  const { card } = s;
  const model = s.model;

  // Answered card, first attempt: send the answers to the model's
  // questions. In the fallback case the saved chat is gone, so the
  // original prompt goes first to re-establish context.
  if (s.isAnswered && s.answeredStage === 'fallback-ready' && !s.promptResent) {
    const promptTurn = ctx.buildTaskMessage(card, s.attempt);
    const ok = await ctx.adapter.insertText(promptTurn) &&
      (await ctx.sendWithBounceRetry(promptTurn)).sent;
    if (!ok) {
      await ctx.failCard(card, model, 'could not re-send original prompt');
      return { outcome: 'failed' };
    }
    const done = await ctx.adapter.waitForCompletion();
    if (done.frozen) {
      await ctx.failCard(card, model, 'page frozen while re-sending prompt');
      return { outcome: 'failed' };
    }
    s.promptResent = true;
    ctx.updatePending({ attempt: s.attempt, promptResent: true });
  }

  let message;
  let sendingAnswer = false;
  if (s.isAnswered && !s.answerSent) {
    message = answerMessage(card.id, card.answer || '', s.attempt);
    sendingAnswer = true;
  } else if (s.answerContext) {
    // Later attempts keep the Q&A so the model is not asked
    // the same questions again in a fresh chat.
    message = `${ctx.buildTaskMessage(card, s.attempt)}\n\n${s.answerContext}`;
  } else {
    message = ctx.buildTaskMessage(card, s.attempt);
  }
  if (!sendingAnswer && s.linksInlined && card.read_links && card.read_links.length) {
    if (ctx.gemModeActive) {
      // Gem mode: the Gem's instructions own the links; the full
      // footer (and its inline-links form) is never sent there.
      ctx.log('Gem mode: skipping inline-links retry');
    } else {
      const texts = await ctx.fetchLinkedTexts(card.read_links);
      message = buildMessageWithLinks(card, texts, s.attempt);
    }
  }

  if (ctx.settings.dryRun) {
    ctx.log(`[dry run] would send ${message.length} chars to ${model}/${s.thinking}, then supervise + submit`);
    ctx.clearPending();
    return { outcome: 'done' };
  }

  const hash = await sentHash(message, s.attempt);
  const claim = await ctx.client.claim(card.id, hash);
  if (claim.duplicate) {
    ctx.log(`claim 409: card #${card.seq} was already sent; moving on`);
    ctx.clearPending();
    return { outcome: 'skipped' };
  }

  const inserted = await ctx.adapter.insertText(message);
  if (!inserted) {
    await ctx.failCard(card, model, 'could not insert prompt');
    return { outcome: 'failed' };
  }
  // Re-read before sending: an agent may have cancelled the card.
  if (!(await ctx.checkCardActive(card))) {
    ctx.clearPending();
    return { outcome: 'skipped' };
  }
  const sent = await ctx.sendWithBounceRetry(message);
  if (!sent.sent) {
    await ctx.client.setStatus(card.id, { status: 'waiting', last_error: sent.reason, model_used: model });
    const decision = decideAfterSendFailure(s.attempt, s.maxAttempts);
    if (decision.action === 'fail') {
      await ctx.failCard(card, model, sent.reason);
      return { outcome: 'failed' };
    }
    return { outcome: 'retry' };
  }
  ctx.state.sentToday += 1;
  if (sendingAnswer) {
    s.answerSent = true;
    s.answerContext = s.lastQuestion
      ? `Earlier questions and answers:\nQ: ${s.lastQuestion}\nA: ${card.answer || ''}`
      : '';
    ctx.updatePending({ attempt: s.attempt, answerSent: true, answerContext: s.answerContext });
  }
  ctx.persistState();

  await ctx.client.setStatus(card.id, { status: 'waiting', model_used: model });
  const completion = await ctx.adapter.waitForCompletion();
  if (completion.frozen) {
    // The old chat is lost with the reload: count this attempt as
    // consumed and resume as the next attempt in a fresh chat.
    ctx.log('page frozen for 10 min; reloading into a new chat');
    ctx.updatePending({ attempt: s.attempt });
    ctx.adapter.newChat(ctx.newChatTarget());
    await ctx.hangForever(); // the reload resumes as the next attempt
    return { outcome: 'failed' }; // unreachable after navigation
  }
  if (completion.timedOut) ctx.log('generation timed out after 10 min');

  // Supervise, with same-chat continues inside this attempt.
  let messages = ctx.adapter.readMessages(5);
  while (true) {
    const lastModel = [...messages].reverse().find((m) => m.role === 'model');
    if (lastModel && isCutOff(lastModel.text, card.id)) {
      ctx.log('answer looks cut off (no END marker / unclosed fence); supervisor decides');
    }
    const sup = await ctx.client.supervise(card.id, messages);
    let verdict = sup.verdict || {};
    // The model may ask a QUESTION block even when the supervisor
    // did not label it 'ask' — a detected QUESTION block wins.
    const detected = lastModel ? detectQuestion(lastModel.text, card.id) : null;
    if (verdict.action !== 'ask' && detected) {
      verdict = { action: 'ask', question: detected.question };
    }
    const problem = verdictProblem(verdict);
    if (problem) {
      await ctx.failCard(card, model, `bad verdict: ${problem}`);
      return { outcome: 'failed' };
    }
    ctx.log(`supervisor: ${verdict.action} — ${verdict.reason || ''}${verdict.stale ? ' (stale echo)' : ''}`);

    // Ask is a first-class state, not an error: route the question
    // to the backend (the card becomes "blocked" there), show it
    // in the panel, and move on to the next card. Never wait here.
    if (verdict.action === 'ask') {
      const askRec = recordAsk({ attempt: s.attempt, questions: s.questions });
      if (askRec.action === 'fail') {
        await ctx.failCard(card, model, 'too many questions');
        return { outcome: 'failed' };
      }
      const question = verdict.question || detected?.question || verdict.reason || 'No question text received';
      await ctx.client.ask(card.id, question, window.location.href);
      s.questions = askRec.questions;
      ctx.state.blockedCount = (ctx.state.blockedCount || 0) + 1;
      ctx.state.latestQuestion = question;
      ctx.updatePending({ attempt: askRec.attempt, questions: s.questions, lastQuestion: question });
      if (ctx.panel) ctx.panel.setBlocked(ctx.state.blockedCount, ctx.state.latestQuestion);
      ctx.log(`question routed (round ${s.questions}/${MAX_QUESTIONS}): ${question}`);
      return { outcome: 'blocked' };
    }

    // Links not read: one retry with the linked text pasted inline.
    if (verdict.action === 'retry' && !s.linksInlined &&
        classifyError(verdict.reason || '').kind === 'links_not_read' &&
        card.read_links && card.read_links.length) {
      s.linksInlined = true;
      ctx.log('supervisor says links were not read; retrying with linked text inline');
      return { outcome: 'retry' };
    }

    const decision = decideAfterVerdict({
      verdict, attempt: s.attempt, maxAttempts: s.maxAttempts,
      continues: s.continues, thinking: s.thinking,
    });
    if (decision.action === 'submit') {
      const res = await ctx.submitCard(card, model, messages, verdict);
      return { outcome: res }; // 'done' | 'failed' | 'skipped'
    }
    if (decision.action === 'fail') {
      await ctx.failCard(card, model, decision.note || verdict.reason || 'failed');
      return { outcome: 'failed' };
    }
    if (decision.action === 'escalate') {
      s.thinking = decision.thinking;
      ctx.log(`escalating thinking to ${s.thinking}`);
      return { outcome: 'escalate' };
    }
    if (decision.action === 'retry') return { outcome: 'retry' };
    // decision.action === 'continue': same chat, one more turn.
    if (s.continues >= MAX_CONTINUES) {
      await ctx.failCard(card, model, 'max continues reached');
      return { outcome: 'failed' };
    }
    s.continues += 1;
    ctx.updatePending({
      attempt: s.attempt, continues: s.continues, thinking: s.thinking,
      model, linksInlined: s.linksInlined,
    });
    await ctx.adapter.insertText(continueMessage(card.id));
    await ctx.adapter.send();
    await ctx.client.setStatus(card.id, { status: 'waiting', model_used: model });
    await ctx.adapter.waitForCompletion();
    messages = ctx.adapter.readMessages(5);
    // Loop: supervise the now-longer history.
  }
}
