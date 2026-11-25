// Chat mode: one agent taking part in a group chat room (Matrix
// behind the backend). The AI on this tab is the agent; the script
// relays room messages into the room's dedicated chat and posts the
// AI's reply back into the room.
//
// Items come from room_poll: "summon" | "message" | "dismiss".
//
// Navigation: opening a room chat reloads the page, so the in-flight
// item is persisted in state.pendingChat {item, stage} BEFORE the
// navigation, and main.js resumes it on load. Stages:
//   summon:  'open' -> 'opened' -> done
//   message: 'open' -> 'opened' (or 'opened-fallback' when the saved
//            chat does not load) -> done; rotation adds 'rotating'
//   dismiss: no navigation, done immediately
//
// Safety: runChatItem never interrupts a card while the AI is
// generating (isGenerating guard at entry and before every send);
// the loop brake and allowedSenders filter live in src/core/chat.js.

import {
  agentDisplayName,
  filterTranscript,
  hasHumanMessage,
  hasUnprivilegedSenders,
  isPassReply,
  loopBrakeAllows,
  needsRotation,
  recordChatReply,
  recordHumanMessage,
  splitReply,
} from '../core/chat.js';
import {
  roomIntroPrompt,
  roomIntroWithSummary,
  roomRelayMessage,
  roomSummaryPrompt,
} from '../core/message.js';

/** Send + verify the turn appeared (one bounce retry, like cards). */
async function sendChatMessage(adapter, text) {
  if (!(await adapter.send(text))) return false;
  if (await adapter.waitForUserQuery(text)) return true;
  if (!adapter.editorHoldsText(text)) return false;
  await adapter.send();
  return adapter.waitForUserQuery(text);
}

/** Best-effort backend call: log failures, never throw. */
async function safeCall(client, fn, log, what) {
  try {
    return await fn();
  } catch (err) {
    log(`${what} failed (continuing): ${err.message || err}`);
    return null;
  }
}

function roomOf(state, item) {
  return state.rooms[item.room_id] || null;
}

function saveRoom(ctx, room) {
  ctx.state.rooms[room.roomId] = room;
  ctx.persistState();
  ctx.updateRooms();
}

function dropRoom(ctx, roomId) {
  delete ctx.state.rooms[roomId];
  ctx.persistState();
  ctx.updateRooms();
}

function setPendingChat(ctx, pending) {
  ctx.state.pendingChat = pending;
  ctx.persistState();
}

/** Last 5 transcript lines, for a rebuilt room chat. */
function recentContext(lines) {
  return lines.slice(-5).map((l) => `[${l.sender}]: ${l.text}`).join('\n');
}

async function handleSummon(ctx, item, stage) {
  const { adapter, client, settings } = ctx;
  const display = agentDisplayName(ctx.agentName);
  const room = roomOf(ctx.state, item) || {
    roomId: item.room_id,
    roomName: item.room_name || item.room_id,
    chatUrl: null,
    turns: 0,
    replyTimes: [],
    lastHumanTs: 0,
  };
  if (stage === 'open') {
    if (adapter.isGenerating()) return 'deferred';
    await safeCall(client, () => client.roomStatus(item.id, 'working'), ctx.log, 'room_status working');
    setPendingChat(ctx, { item, stage: 'opened' });
    if (item.chat_url) adapter.openChat(item.chat_url);
    else adapter.newChat();
    return 'navigating'; // the page reloads; resume continues below
  }
  // stage 'opened': health check, then the intro prompt.
  const health = adapter.healthCheck();
  if (!health.ok) {
    await client.roomStatus(item.id, 'failed', health.problem || 'health check failed');
    setPendingChat(ctx, null);
    return 'failed';
  }
  if (adapter.isGenerating()) return 'deferred';
  const intro = roomIntroPrompt({
    agentDisplayName: display,
    roomName: room.roomName,
    members: item.members || [],
    maxWords: item.max_words || 150,
  });
  if (!(await sendChatMessage(adapter, intro))) {
    await client.roomStatus(item.id, 'failed', 'could not send intro prompt');
    setPendingChat(ctx, null);
    return 'failed';
  }
  const reply = await adapter.waitForReply();
  if (!reply.finished || !reply.text.trim()) {
    await client.roomStatus(item.id, 'failed', 'no reply to intro prompt');
    setPendingChat(ctx, null);
    return 'failed';
  }
  const chatUrl = adapter.currentChatUrl();
  await client.roomReply(item.id, reply.text.trim(), chatUrl);
  await safeCall(client, () => client.roomPresence(ctx.agent, room.roomId, 'online'), ctx.log, 'room_presence online');
  const withReply = recordChatReply(room);
  saveRoom(ctx, { ...withReply, chatUrl, turns: 1 });
  ctx.state.sentToday += 1;
  ctx.setLastChat(`${room.roomName} — summoned, online`);
  setPendingChat(ctx, null);
  return 'done';
}

async function handleMessage(ctx, item, stage) {
  const { adapter, client, settings } = ctx;
  const display = agentDisplayName(ctx.agentName);
  const room = roomOf(ctx.state, item) || {
    roomId: item.room_id,
    roomName: item.room_name || item.room_id,
    chatUrl: null,
    turns: 0,
    replyTimes: [],
    lastHumanTs: 0,
  };
  const { lines, dropped } = filterTranscript(item.transcript || [], settings.allowedSenders);
  if (dropped > 0) ctx.log(`chat: dropped ${dropped} transcript line(s) from senders outside allowedSenders`);
  if (hasHumanMessage(lines)) {
    const updated = recordHumanMessage(room, Date.now());
    room.lastHumanTs = updated.lastHumanTs;
  }
  if (!lines.length) {
    await client.roomStatus(item.id, 'skipped');
    setPendingChat(ctx, null);
    return 'skipped';
  }

  if (stage === 'open') {
    if (adapter.isGenerating()) return 'deferred';
    await safeCall(client, () => client.roomStatus(item.id, 'working'), ctx.log, 'room_status working');
    const url = item.chat_url || room.chatUrl;
    setPendingChat(ctx, { item, stage: 'opened', expectedUrl: url || null });
    if (url) adapter.openChat(url);
    else adapter.newChat();
    return 'navigating';
  }

  if (stage === 'opened') {
    // The saved chat must have loaded: health + URL match.
    const health = adapter.healthCheck();
    const expectedUrl = (ctx.state.pendingChat && ctx.state.pendingChat.expectedUrl) || null;
    const loaded = health.ok && (!expectedUrl || adapter.currentChatUrl().startsWith(expectedUrl));
    if (!loaded) {
      ctx.log('chat: saved room chat did not load; rebuilding in a new chat');
      setPendingChat(ctx, { item, stage: 'opened-fallback' });
      adapter.newChat();
      return 'navigating';
    }
    return finishMessage(ctx, item, room, lines, false);
  }

  if (stage === 'opened-fallback') {
    const health = adapter.healthCheck();
    if (!health.ok) {
      await client.roomStatus(item.id, 'failed', health.problem || 'health check failed');
      setPendingChat(ctx, null);
      return 'failed';
    }
    if (adapter.isGenerating()) return 'deferred';
    // Intro + a 5-line summary of the transcript, so the new chat
    // has context; the full relay follows as the next turn.
    const intro = roomIntroPrompt({
      agentDisplayName: display,
      roomName: room.roomName,
      members: item.members || [],
      maxWords: item.max_words || 150,
    });
    const withContext = `${intro}\n\nRecent context (last 5 messages):\n${recentContext(lines)}`;
    if (!(await sendChatMessage(adapter, withContext))) {
      await client.roomStatus(item.id, 'failed', 'could not send intro prompt');
      setPendingChat(ctx, null);
      return 'failed';
    }
    const introReply = await adapter.waitForReply();
    if (!introReply.finished) {
      await client.roomStatus(item.id, 'failed', 'no reply to intro prompt');
      setPendingChat(ctx, null);
      return 'failed';
    }
    return finishMessage(ctx, item, room, lines, true);
  }

  if (stage === 'rotating') {
    // Came back from a rotation: new chat, intro + summary.
    const health = adapter.healthCheck();
    if (!health.ok) {
      await client.roomStatus(item.id, 'failed', health.problem || 'health check failed');
      setPendingChat(ctx, null);
      return 'failed';
    }
    const summary = (ctx.state.pendingChat && ctx.state.pendingChat.summary) || '';
    const intro = roomIntroWithSummary({
      agentDisplayName: display,
      roomName: room.roomName,
      members: item.members || [],
      maxWords: item.max_words || 150,
      summary,
    });
    if (!(await sendChatMessage(adapter, intro))) {
      await client.roomStatus(item.id, 'failed', 'could not send intro after rotation');
      setPendingChat(ctx, null);
      return 'failed';
    }
    const reply = await adapter.waitForReply();
    if (!reply.finished) {
      await client.roomStatus(item.id, 'failed', 'no reply to intro after rotation');
      setPendingChat(ctx, null);
      return 'failed';
    }
    saveRoom(ctx, { ...room, chatUrl: adapter.currentChatUrl(), turns: 0 });
    ctx.setLastChat(`${room.roomName} — chat rotated (40+ turns)`);
    setPendingChat(ctx, null);
    return 'done';
  }

  ctx.log(`chat: unknown stage "${stage}" for message item`);
  setPendingChat(ctx, null);
  return 'failed';
}

/** Relay the transcript and post the AI's reply (or PASS). */
async function finishMessage(ctx, item, room, lines, rebuilt) {
  const { adapter, client } = ctx;
  const display = agentDisplayName(ctx.agentName);
  if (!loopBrakeAllows(room)) {
    ctx.log(`chat: loop brake — more than 6 replies to ${room.roomName} in 10 min without a human message; skipping`);
    await client.roomStatus(item.id, 'skipped');
    setPendingChat(ctx, null);
    return 'skipped';
  }
  if (adapter.isGenerating()) return 'deferred';
  const relay = roomRelayMessage({
    roomName: room.roomName,
    transcriptLines: lines,
    mention: Boolean(item.mention),
    agentDisplayName: display,
    guard: hasUnprivilegedSenders(lines),
  });
  if (!(await sendChatMessage(adapter, relay))) {
    await client.roomStatus(item.id, 'failed', 'could not send relay message');
    setPendingChat(ctx, null);
    return 'failed';
  }
  const reply = await adapter.waitForReply();
  if (!reply.finished) {
    await client.roomStatus(item.id, 'failed', 'reply timed out');
    setPendingChat(ctx, null);
    return 'failed';
  }
  const text = reply.text.trim();
  const chatUrl = adapter.currentChatUrl();
  const turns = room.turns + 1;
  if (isPassReply(text)) {
    await client.roomStatus(item.id, 'skipped');
    saveRoom(ctx, { ...room, chatUrl, turns });
    ctx.setLastChat(`${room.roomName} — PASS`);
    setPendingChat(ctx, null);
    return 'skipped';
  }
  const parts = splitReply(text);
  for (const part of parts) {
    await client.roomReply(item.id, part, chatUrl);
  }
  const withReply = recordChatReply(room);
  saveRoom(ctx, { ...withReply, chatUrl, turns });
  ctx.state.sentToday += 1;
  ctx.setLastChat(`${room.roomName} — replied (${parts.length} part${parts.length > 1 ? 's' : ''})${rebuilt ? ', chat rebuilt' : ''}`);

  // Long-chat hygiene: over 40 relayed turns, ask for a summary,
  // then rotate to a fresh chat carrying the summary.
  if (needsRotation(turns)) {
    ctx.log(`chat: ${room.roomName} has ${turns} relayed turns; rotating`);
    if (!(await sendChatMessage(adapter, roomSummaryPrompt()))) {
      ctx.log('chat: could not ask for a summary; keeping the old chat');
      setPendingChat(ctx, null);
      return 'done';
    }
    const summary = await adapter.waitForReply();
    if (!summary.finished || !summary.text.trim()) {
      ctx.log('chat: no summary reply; keeping the old chat');
      setPendingChat(ctx, null);
      return 'done';
    }
    setPendingChat(ctx, { item, stage: 'rotating', summary: summary.text.trim() });
    adapter.newChat();
    return 'navigating';
  }
  setPendingChat(ctx, null);
  return 'done';
}

async function handleDismiss(ctx, item) {
  const room = roomOf(ctx.state, item);
  await safeCall(ctx.client, () => ctx.client.roomPresence(ctx.agent, item.room_id, 'offline'), ctx.log, 'room_presence offline');
  dropRoom(ctx, item.room_id);
  ctx.setLastChat(`${room ? room.roomName : item.room_id} — dismissed`);
  setPendingChat(ctx, null);
  return 'done';
}

/**
 * Handle one room_poll item. Returns 'done' | 'skipped' | 'failed' |
 * 'deferred' (AI generating — leave the item queued, try next poll)
 * | 'navigating' (the page is reloading; resume on load).
 * `ctx.state.pendingChat` is the persisted stage (null on a fresh item).
 */
export async function runChatItem(ctx, item) {
  if (!item || !item.room_id) {
    ctx.log('chat: item without room_id; skipping');
    return 'skipped';
  }
  const pending = ctx.state.pendingChat;
  const stage = (pending && pending.item && pending.item.id === item.id)
    ? pending.stage
    : 'open';
  ctx.log(`chat: ${item.type} in ${item.room_name || item.room_id} (stage ${stage})`);
  if (item.type === 'summon') return handleSummon(ctx, item, stage);
  if (item.type === 'message') return handleMessage(ctx, item, stage);
  if (item.type === 'dismiss') return handleDismiss(ctx, item);
  ctx.log(`chat: unknown item type "${item.type}"; skipping`);
  try {
    await ctx.client.roomStatus(item.id, 'skipped');
  } catch { /* best effort */ }
  setPendingChat(ctx, null);
  return 'skipped';
}
