// Link flow (paste mode) — the AI gets a read link, reads the task,
// writes the code; the script copies the answer and submits it.
// One attempt per call; the caller (main.js) owns the attempt loop,
// the new-chat navigation, the health check and the settings
// application. No supervisor: the instruction asks for exactly one
// fenced code block ending with END-<id>; a cut-off answer gets up
// to 3 same-chat "Continue" turns, then the extracted code is
// submitted (or the attempt retries in a new chat when nothing was
// extracted). When the card has no read_url, the card text is pasted
// instead (see linkMessage in core/message.js).
//
// `ctx` and `s` are the same shapes paste.js used (see its header
// before it was replaced): client, adapter, settings, state, panel,
// log, sleep, hangForever, newChatTarget, applySettings,
// sendWithBounceRetry, failCard, submitCard, checkCardActive,
// fetchLinkedTexts, buildTaskMessage, buildLinkMessage, gemModeActive,
// isRunning, updatePending, persistState, clearPending.
//
// Returns { outcome } where outcome is 'done' | 'failed' |
// 'skipped' | 'blocked' | 'retry' | 'escalate'. Terminal failures
// call ctx.failCard themselves; 'retry' / 'escalate' mean "next
// attempt in a new chat". The caller attaches mode_stats.

import { sentHash } from '../core/hash.js';
import { detectQuestion, extractFinalFile, isCutOff } from '../core/extract.js';
import { MAX_CONTINUES, MAX_QUESTIONS, decideAfterSendFailure, recordAsk } from '../core/state.js';
import { answerMessage, continueMessage } from '../core/message.js';

export async function runLinkAttempt(ctx, s) {
  const { card } = s;
  const model = s.model;

  // Answered card, first attempt: send the answers to the model's
  // questions. In the fallback case the saved chat is gone, so the
  // original prompt goes first to re-establish context.
  if (s.isAnswered && s.answeredStage === 'fallback-ready' && !s.promptResent) {
    const promptTurn = ctx.buildLinkMessage(card, s.attempt);
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
    message = `${ctx.buildLinkMessage(card, s.attempt)}\n\n${s.answerContext}`;
  } else {
    message = ctx.buildLinkMessage(card, s.attempt);
  }

  if (ctx.settings.dryRun) {
    ctx.log(`[dry run] would send link message (${message.length} chars) to ${model}/${s.thinking}, then extract + submit`);
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

  // Cut-off answer: same-chat "Continue" turns, up to MAX_CONTINUES.
  let messages = ctx.adapter.readMessages(5);
  while (true) {
    const lastModel = [...messages].reverse().find((m) => m.role === 'model');
    if (lastModel && isCutOff(lastModel.text, card.id)) {
      if (s.continues >= MAX_CONTINUES) break;
      ctx.log('answer looks cut off (no END marker / unclosed fence); asking to continue');
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
      continue;
    }
    break;
  }

  // A QUESTION block is a first-class state, not an error: route it
  // to the backend (the card becomes "blocked" there) and move on.
  const lastModel = [...messages].reverse().find((m) => m.role === 'model');
  const detected = lastModel ? detectQuestion(lastModel.text, card.id) : null;
  if (detected) {
    const askRec = recordAsk({ attempt: s.attempt, questions: s.questions });
    if (askRec.action === 'fail') {
      await ctx.failCard(card, model, 'too many questions');
      return { outcome: 'failed' };
    }
    await ctx.client.ask(card.id, detected.question, window.location.href);
    s.questions = askRec.questions;
    ctx.state.blockedCount = (ctx.state.blockedCount || 0) + 1;
    ctx.state.latestQuestion = detected.question;
    ctx.updatePending({ attempt: askRec.attempt, questions: s.questions, lastQuestion: detected.question });
    if (ctx.panel) ctx.panel.setBlocked(ctx.state.blockedCount, ctx.state.latestQuestion);
    ctx.log(`question routed (round ${s.questions}/${MAX_QUESTIONS}): ${detected.question}`);
    return { outcome: 'blocked' };
  }

  // Extract the file from all model messages (no supervisor in the
  // link flow — the instruction asks for exactly one code block).
  // submitCard re-reads the card first and never submits a card
  // that is already done.
  const indexes = messages.map((m, i) => i);
  const content = extractFinalFile(messages, indexes, card.id);
  if (!content) {
    ctx.log('no code extracted from the link-flow answer; retrying in a new chat');
    return { outcome: 'retry' };
  }
  const res = await ctx.submitCard(card, model, messages, { message_indexes: indexes });
  return { outcome: res }; // 'done' | 'failed' | 'skipped'
}
