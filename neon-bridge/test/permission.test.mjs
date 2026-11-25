import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PROMPT_TEXT_CHARS,
  classifyPermissionPrompt,
  detectToolName,
  matchPermissionButton,
  truncatePromptText,
} from '../src/core/permission.js';
import { TEXT_MATCH } from '../src/selectors.js';
import { DEFAULT_SETTINGS } from '../src/ui/panel.js';

const PATTERNS = TEXT_MATCH.permissionButtons;
const SERVER = 'neon-mcp';
const TOOLS = ['repo_info', 'list_dir', 'read_file', 'get_task', 'submit_file', 'ask_question', 'report_status'];

test('matchPermissionButton: English Always allow / Allow (case-insensitive, exact)', () => {
  assert.equal(matchPermissionButton('Always allow', PATTERNS), 'always');
  assert.equal(matchPermissionButton('always allow', PATTERNS), 'always');
  assert.equal(matchPermissionButton('ALWAYS ALLOW', PATTERNS), 'always');
  assert.equal(matchPermissionButton('Allow', PATTERNS), 'allow');
  assert.equal(matchPermissionButton('ALLOW', PATTERNS), 'allow');
  // Anchored: near-misses must never match.
  assert.equal(matchPermissionButton('Allow all', PATTERNS), null);
  assert.equal(matchPermissionButton('Allow once', PATTERNS), null);
  assert.equal(matchPermissionButton('Deny', PATTERNS), null);
  assert.equal(matchPermissionButton('Always allow ', PATTERNS), 'always'); // trimmed
  assert.equal(matchPermissionButton('', PATTERNS), null);
  assert.equal(matchPermissionButton(null, PATTERNS), null);
});

test('matchPermissionButton: Persian equivalents', () => {
  assert.equal(matchPermissionButton('همیشه اجازه داده شود', PATTERNS), 'always');
  assert.equal(matchPermissionButton('اجازه دادن', PATTERNS), 'allow');
  assert.equal(matchPermissionButton('رد کردن', PATTERNS), null);
});

test('classifyPermissionPrompt: ours — Always allow preferred over Allow', () => {
  const text = 'neon-mcp wants to run read_file on the repo. Allow?';
  const both = classifyPermissionPrompt({ text, buttons: ['always', 'allow'], serverName: SERVER, toolNames: TOOLS });
  assert.deepEqual(both, { decision: 'approve-always', tool: 'read_file', hasServerName: true });
  const onlyAllow = classifyPermissionPrompt({ text, buttons: ['allow'], serverName: SERVER, toolNames: TOOLS });
  assert.equal(onlyAllow.decision, 'approve');
  assert.equal(onlyAllow.tool, 'read_file');
});

test('classifyPermissionPrompt: Persian prompt + Persian buttons', () => {
  const text = 'سرور neon-mcp می‌خواهد ابزار read_file را اجرا کند.';
  const out = classifyPermissionPrompt({ text, buttons: ['always'], serverName: SERVER, toolNames: TOOLS });
  assert.equal(out.decision, 'approve-always');
  assert.equal(out.tool, 'read_file');
  const outFa = classifyPermissionPrompt({
    text: 'ابزار get_task برای neon-mcp اجازه می‌خواهد.',
    buttons: ['allow'], serverName: SERVER, toolNames: TOOLS,
  });
  assert.equal(outFa.decision, 'approve');
  assert.equal(outFa.tool, 'get_task');
});

test('classifyPermissionPrompt: tool name alone is enough; server name alone is enough', () => {
  const byTool = classifyPermissionPrompt({
    text: 'Run read_file now?', buttons: ['allow'], serverName: SERVER, toolNames: TOOLS,
  });
  assert.deepEqual(byTool, { decision: 'approve', tool: 'read_file', hasServerName: false });
  const byServer = classifyPermissionPrompt({
    text: 'neon-mcp wants to run a tool.', buttons: ['allow'], serverName: SERVER, toolNames: TOOLS,
  });
  assert.deepEqual(byServer, { decision: 'approve', tool: null, hasServerName: true });
});

test('classifyPermissionPrompt: unknown prompts are left alone (never click)', () => {
  // Another app, Gmail, an unknown MCP server, an unknown tool.
  const cases = [
    'Gmail wants to send an email. Allow?',
    'other-mcp wants to run fetch_page. Allow?', // unknown server AND unknown tool
    'neon-mcp wants to run delete_everything. Allow?', // unknown tool, server name alone... see below
    'Allow this app to access your Drive?',
  ];
  for (const text of cases.slice(0, 2).concat(cases[3])) {
    const out = classifyPermissionPrompt({ text, buttons: ['always', 'allow'], serverName: SERVER, toolNames: TOOLS });
    assert.equal(out.decision, 'unknown', text);
    assert.equal(out.tool, null, text);
  }
  // Server name alone DOES approve even with an unlisted tool name:
  // the server is ours, so the prompt belongs to us. (The tool list
  // is a second signal, not a whitelist on its own.)
  const serverOnly = classifyPermissionPrompt({
    text: cases[2], buttons: ['allow'], serverName: SERVER, toolNames: TOOLS,
  });
  assert.equal(serverOnly.decision, 'approve');
  assert.equal(serverOnly.hasServerName, true);
});

test('classifyPermissionPrompt: no approve button at all -> unknown (safe default)', () => {
  const out = classifyPermissionPrompt({
    text: 'neon-mcp wants to run read_file.', buttons: [], serverName: SERVER, toolNames: TOOLS,
  });
  assert.equal(out.decision, 'unknown');
});

test('classifyPermissionPrompt: a prompt showing only a tool name is enough', () => {
  // Known issue: Gemini's tool-approval prompt may not show the
  // server name at all — a match on any of our tool names approves.
  const out = classifyPermissionPrompt({
    text: 'Allow read_file to access the repository? The tool wants to read a file.',
    buttons: ['always', 'allow'], serverName: SERVER, toolNames: TOOLS,
  });
  assert.equal(out.decision, 'approve-always');
  assert.equal(out.tool, 'read_file');
  assert.equal(out.hasServerName, false);
  const fa = classifyPermissionPrompt({
    text: 'ابزار submit_file می‌خواهد فایل را ارسال کند. اجازه می‌دهید؟',
    buttons: ['allow'], serverName: SERVER, toolNames: TOOLS,
  });
  assert.equal(fa.decision, 'approve');
  assert.equal(fa.tool, 'submit_file');
});

test('detectToolName + truncatePromptText', () => {
  assert.equal(detectToolName('run submit_file please', TOOLS), 'submit_file');
  assert.equal(detectToolName('nothing here', TOOLS), null);
  assert.equal(detectToolName('', TOOLS), null);
  assert.equal(truncatePromptText('short prompt'), 'short prompt');
  assert.equal(truncatePromptText('a'.repeat(500)).length, MAX_PROMPT_TEXT_CHARS);
  assert.equal(MAX_PROMPT_TEXT_CHARS, 300);
  assert.equal(truncatePromptText('  spaced\n\nout  prompt  '), 'spaced out prompt');
});

test('defaults: mcpServerName neon-mcp and the 7 tool names', () => {
  assert.equal(DEFAULT_SETTINGS.mcpServerName, 'neon-mcp');
  assert.deepEqual(DEFAULT_SETTINGS.mcpToolNames, TOOLS);
});
