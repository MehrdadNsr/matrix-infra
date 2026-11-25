// Floating control panel — the only UI the script adds to the page.
// Prefixed with nb2- everywhere so it never collides with the v1
// "Trafactor Bridge - Gemini" panel. Top-right, collapsible.
// Never uses alert / confirm / prompt (a past bug): everything the
// user needs to see or change lives in this panel.

export const DEFAULT_SETTINGS = Object.freeze({
  backendUrl: '',
  bridgeKey: '',
  workerId: '',
  gemUrl: '', // optional: when set, Gem mode is ON (default OFF)
  mcpServerName: 'neon-mcp',
  mcpToolNames: ['repo_info', 'list_dir', 'read_file', 'get_task', 'submit_file', 'ask_question', 'report_status'],
  mode: 'auto', // "auto" | "mcp" | "paste": which mode runs a card
  mcpPickupTimeoutSec: 90, // MCP: give up if no tool use seen in this long
  mcpTaskTimeoutMin: 25, // MCP: give up if the task is not done in this long
  agentName: '', // agent id for this tab; '' = the site default (gemini neon, muse muse, grok grok, chatgpt gpt)
  museDomain: 'muse.ai', // the Muse web app's domain (also needs @match / manifest to run there)
  codeEnabled: true, // code cards (MCP/paste); default false on muse/grok/gpt until their code flows exist
  chatEnabled: true, // group-chat relay
  allowedSenders: ['mehrdad', 'oracle', 'claude', 'morpheus', 'neon', 'muse', 'grok', 'gpt'],
  quietHours: { start: '02:00', end: '08:00' },
  paceMinSec: 60,
  paceMaxSec: 180,
  maxAttemptsPerCard: 4,
  dailySoftCap: 50,
  alertOnStop: true,
  dryRun: false,
});

const CSS = `
.nb2-panel{position:fixed;top:12px;right:12px;z-index:2147483647;width:320px;
  font:13px/1.5 system-ui,sans-serif;color:#111;background:#fff;
  border:1px solid #ccc;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.25);
  overflow:hidden}
.nb2-panel.nb2-collapsed .nb2-body{display:none}
.nb2-head{display:flex;align-items:center;gap:8px;padding:8px 10px;
  background:#0b1220;color:#fff;cursor:pointer;user-select:none}
.nb2-head b{flex:1}
.nb2-body{padding:10px;display:flex;flex-direction:column;gap:8px}
.nb2-row{display:flex;gap:6px;align-items:center}
.nb2-state{font-weight:600}
.nb2-log{height:160px;overflow:auto;background:#111;color:#d6ffd6;
  font:11px/1.4 ui-monospace,monospace;padding:6px;border-radius:6px;
  white-space:pre-wrap;word-break:break-word}
.nb2-panel input,.nb2-panel select{width:100%;padding:4px 6px;
  border:1px solid #bbb;border-radius:6px;font:inherit}
.nb2-panel label{display:block;font-size:12px;color:#444}
.nb2-panel button{padding:5px 10px;border:1px solid #888;border-radius:6px;
  background:#f2f2f2;cursor:pointer;font:inherit}
.nb2-panel button.nb2-primary{background:#0b1220;color:#fff;border-color:#0b1220}
.nb2-small{font-size:12px;color:#555}
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the panel. `deps`:
 *  store: { get(key, fallback), set(key, value) } (GM storage)
 *  settings: current settings object (mutated in place on save)
 *  onStart / onPause / onSelfTest: callbacks wired by main.js
 * Returns { setState, setCard, setQuota, log, setRunning }.
 */
export function createPanel({ store, settings, onStart, onPause, onSelfTest, onLeaveAllRooms }) {
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = el('div', 'nb2-panel');
  panel.id = 'nb2-panel';

  const head = el('div', 'nb2-head');
  head.id = 'nb2-panel-head';
  head.appendChild(el('b', '', 'Neon Bridge v2'));
  const collapseBtn = el('button', '', '–');
  collapseBtn.id = 'nb2-collapse';
  collapseBtn.type = 'button';
  head.appendChild(collapseBtn);
  panel.appendChild(head);

  const body = el('div', 'nb2-body');
  body.id = 'nb2-panel-body';

  const stateLine = el('div', 'nb2-state', 'Idle');
  stateLine.id = 'nb2-state';
  body.appendChild(stateLine);

  const cardLine = el('div', 'nb2-small', 'No card');
  cardLine.id = 'nb2-card';
  body.appendChild(cardLine);

  const quotaLine = el('div', 'nb2-small', 'Quota: unknown');
  quotaLine.id = 'nb2-quota';
  body.appendChild(quotaLine);

  const modeLine = el('div', 'nb2-small', 'Mode: MCP');
  modeLine.id = 'nb2-mode';
  body.appendChild(modeLine);

  const blockedLine = el('div', 'nb2-small', 'Blocked (waiting for answer): 0');
  blockedLine.id = 'nb2-blocked';
  body.appendChild(blockedLine);

  const questionLine = el('div', 'nb2-small', '');
  questionLine.id = 'nb2-question';
  body.appendChild(questionLine);

  const siteLine = el('div', 'nb2-small', 'Site: —');
  siteLine.id = 'nb2-site';
  body.appendChild(siteLine);

  const agentLine = el('div', 'nb2-small', 'Agent: —');
  agentLine.id = 'nb2-agent';
  body.appendChild(agentLine);

  const roomsLine = el('div', 'nb2-small', 'Rooms: none');
  roomsLine.id = 'nb2-rooms';
  body.appendChild(roomsLine);

  const lastChatLine = el('div', 'nb2-small', '');
  lastChatLine.id = 'nb2-lastchat';
  body.appendChild(lastChatLine);

  const btnRow = el('div', 'nb2-row');
  const startBtn = el('button', 'nb2-primary', 'Start');
  startBtn.id = 'nb2-start';
  startBtn.type = 'button';
  const pauseBtn = el('button', '', 'Pause');
  pauseBtn.id = 'nb2-pause';
  pauseBtn.type = 'button';
  const testBtn = el('button', '', 'Self-test');
  testBtn.id = 'nb2-selftest';
  testBtn.type = 'button';
  const leaveBtn = el('button', '', 'Leave all rooms');
  leaveBtn.id = 'nb2-leave-rooms';
  leaveBtn.type = 'button';
  btnRow.append(startBtn, pauseBtn, testBtn, leaveBtn);
  body.appendChild(btnRow);

  const logBox = el('div', 'nb2-log', '');
  logBox.id = 'nb2-log';
  body.appendChild(logBox);

  // Settings form (saved to GM storage on change).
  const form = el('div');
  form.id = 'nb2-settings';
  const fields = [
    ['backendUrl', 'Backend URL', 'text'],
    ['bridgeKey', 'Bridge key', 'password'],
    ['workerId', 'Worker ID', 'text'],
    ['gemUrl', 'Gem URL (optional, Gem mode)', 'text'],
    ['mcpServerName', 'MCP server name (auto-approve)', 'text'],
    ['mcpToolNames', 'MCP tool names (comma-separated)', 'list'],
    ['mode', 'Mode (auto / mcp / paste)', 'select', ['auto', 'mcp', 'paste']],
    ['mcpPickupTimeoutSec', 'MCP pickup timeout (sec)', 'number'],
    ['mcpTaskTimeoutMin', 'MCP task timeout (min)', 'number'],
    ['agentName', 'Agent name (empty = site default)', 'text'],
    ['museDomain', 'Muse web app domain', 'text'],
    ['allowedSenders', 'Allowed senders (comma-separated)', 'list'],
    ['paceMinSec', 'Pace min (sec)', 'number'],
    ['paceMaxSec', 'Pace max (sec)', 'number'],
    ['maxAttemptsPerCard', 'Max attempts / card', 'number'],
    ['dailySoftCap', 'Daily soft cap', 'number'],
  ];
  const inputs = {};
  for (const [key, label, type, options] of fields) {
    const wrap = el('label', '', label);
    let input;
    if (type === 'select') {
      input = el('select');
      for (const opt of options) {
        const o = el('option', '', opt);
        o.value = opt;
        input.appendChild(o);
      }
      input.value = settings[key];
    } else {
      input = el('input');
      input.type = type === 'list' ? 'text' : type;
      input.value = type === 'list' ? (settings[key] || []).join(', ') : String(settings[key] ?? '');
    }
    input.id = `nb2-set-${key}`;
    input.addEventListener('change', () => {
      const value =
        type === 'number'
          ? Number(input.value)
          : type === 'list'
            ? input.value.split(',').map((s) => s.trim()).filter(Boolean)
            : input.value;
      settings[key] = value;
      store.set(key, value);
    });
    inputs[key] = input;
    wrap.appendChild(input);
    form.appendChild(wrap);
  }
  const quietLabel = el('label', '', 'Quiet hours (local)');
  const quietRow = el('div', 'nb2-row');
  const quietStart = el('input');
  quietStart.id = 'nb2-set-quietStart';
  quietStart.type = 'time';
  quietStart.value = settings.quietHours.start;
  const quietEnd = el('input');
  quietEnd.id = 'nb2-set-quietEnd';
  quietEnd.type = 'time';
  quietEnd.value = settings.quietHours.end;
  const saveQuiet = () => {
    settings.quietHours = { start: quietStart.value || '02:00', end: quietEnd.value || '08:00' };
    store.set('quietHours', settings.quietHours);
  };
  quietStart.addEventListener('change', saveQuiet);
  quietEnd.addEventListener('change', saveQuiet);
  quietRow.append(quietStart, el('span', '', '–'), quietEnd);
  quietLabel.appendChild(quietRow);
  form.appendChild(quietLabel);

  const codeLabel = el('label', '', 'Code cards (MCP / paste)');
  const codeCheck = el('input');
  codeCheck.id = 'nb2-set-codeEnabled';
  codeCheck.type = 'checkbox';
  codeCheck.checked = settings.codeEnabled !== false;
  codeCheck.addEventListener('change', () => {
    settings.codeEnabled = codeCheck.checked;
    store.set('codeEnabled', codeCheck.checked);
  });
  codeLabel.prepend(codeCheck);
  form.appendChild(codeLabel);

  const chatLabel = el('label', '', 'Group-chat relay');
  const chatCheck = el('input');
  chatCheck.id = 'nb2-set-chatEnabled';
  chatCheck.type = 'checkbox';
  chatCheck.checked = settings.chatEnabled !== false;
  chatCheck.addEventListener('change', () => {
    settings.chatEnabled = chatCheck.checked;
    store.set('chatEnabled', chatCheck.checked);
  });
  chatLabel.prepend(chatCheck);
  form.appendChild(chatLabel);

  const dryLabel = el('label', '', 'Dry run (no send, no submit)');
  const dryCheck = el('input');
  dryCheck.id = 'nb2-set-dryRun';
  dryCheck.type = 'checkbox';
  dryCheck.checked = Boolean(settings.dryRun);
  dryCheck.addEventListener('change', () => {
    settings.dryRun = dryCheck.checked;
    store.set('dryRun', dryCheck.checked);
  });
  dryLabel.prepend(dryCheck);
  form.appendChild(dryLabel);

  const alertLabel = el('label', '', 'Notify owner on full stop');
  const alertCheck = el('input');
  alertCheck.id = 'nb2-set-alertOnStop';
  alertCheck.type = 'checkbox';
  alertCheck.checked = settings.alertOnStop !== false;
  alertCheck.addEventListener('change', () => {
    settings.alertOnStop = alertCheck.checked;
    store.set('alertOnStop', alertCheck.checked);
  });
  alertLabel.prepend(alertCheck);
  form.appendChild(alertLabel);

  body.appendChild(form);
  panel.appendChild(body);
  document.body.appendChild(panel);

  const lines = [];
  function log(message) {
    const stamp = new Date().toLocaleTimeString();
    lines.push(`[${stamp}] ${message}`);
    while (lines.length > 50) lines.shift();
    logBox.textContent = lines.join('\n');
    logBox.scrollTop = logBox.scrollHeight;
  }

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('nb2-collapsed');
    collapseBtn.textContent = panel.classList.contains('nb2-collapsed') ? '+' : '–';
  });
  head.addEventListener('click', () => {
    panel.classList.toggle('nb2-collapsed');
    collapseBtn.textContent = panel.classList.contains('nb2-collapsed') ? '+' : '–';
  });
  startBtn.addEventListener('click', () => onStart && onStart());
  pauseBtn.addEventListener('click', () => onPause && onPause());
  testBtn.addEventListener('click', () => onSelfTest && onSelfTest());
  leaveBtn.addEventListener('click', () => onLeaveAllRooms && onLeaveAllRooms());

  return {
    log,
    setState(text) {
      stateLine.textContent = text;
    },
    setCard(text) {
      cardLine.textContent = text;
    },
    setMode(text) {
      modeLine.textContent = text;
    },
    setQuota(pct) {
      quotaLine.textContent = pct == null ? 'Quota: unknown' : `Quota remaining: ${pct}%`;
    },
    setBlocked(count, latestQuestion) {
      blockedLine.textContent = `Blocked (waiting for answer): ${count}`;
      questionLine.textContent = latestQuestion ? `Latest question: ${latestQuestion}` : '';
    },
    setSite(text) {
      siteLine.textContent = `Site: ${text}`;
    },
    setAgent(text) {
      agentLine.textContent = `Agent: ${text}`;
    },
    setRooms(text) {
      roomsLine.textContent = `Rooms: ${text}`;
    },
    setLastChat(text) {
      lastChatLine.textContent = text ? `Last chat: ${text}` : '';
    },
    setRunning(running) {
      startBtn.disabled = running;
      pauseBtn.disabled = !running;
    },
  };
}
