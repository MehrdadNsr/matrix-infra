// Build script for Neon Bridge v2 — zero dependencies.
// Concatenates src/ into dist/neon-bridge.user.js with the userscript
// header. Source files are ES modules; the bundler strips their
// import/export statements and inlines them in dependency order
// (the FILES list below is that order — a file may only use names
// defined by files earlier in the list, or by itself).
//
// Usage: node build.mjs        (from the neon-bridge/ directory)
//        node --test           (runs the unit tests in test/)

import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
// The version lives in src/version.js (also reported in heartbeats);
// the userscript header is derived from it so the two cannot drift.
const VERSION = /NB2_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/version.js'), 'utf8'))[1];

const FILES = [
  'src/selectors.js',
  'src/version.js',
  'src/core/hash.js',
  'src/core/errors.js',
  'src/core/extract.js',
  'src/core/pacing.js',
  'src/core/message.js',
  'src/core/permission.js',
  'src/core/modes.js',
  'src/core/chat.js',
  'src/core/state.js',
  'src/backend/client.js',
  'src/adapters/dom.js',
  'src/adapters/gemini.js',
  'src/adapters/muse.js',
  'src/adapters/grok.js',
  'src/adapters/chatgpt.js',
  'src/adapters/index.js',
  'src/ui/panel.js',
  'src/modes/link.js',
  'src/modes/mcp.js',
  'src/modes/chat.js',
  'src/main.js',
];

const HEADER = `// ==UserScript==
// @name         Neon Bridge v2
// @namespace    https://example.invalid/neon-bridge
// @version      ${VERSION}
// @description  One script, three jobs: code mode via MCP or copy-paste, and group-chat relay — on Gemini, Muse, Grok and ChatGPT, one tab each.
// @author       Neon Bridge contributors
// @license      MIT
// @match        https://gemini.google.com/*
// @match        https://grok.com/*
// @match        https://chatgpt.com/*
// @match        https://muse.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

/** Strip imports and the `export` keyword from one source file. */
function stripModule(source, file) {
  const lines = source.split('\n');
  const out = [];
  let inImport = false;
  for (const line of lines) {
    // Imports may span several lines (import { a,\n b } from '...';).
    if (!inImport && /^\s*import[\s{]/.test(line)) {
      inImport = !line.includes(';');
      continue;
    }
    if (inImport) {
      if (line.includes(';')) inImport = false;
      continue;
    }
    const m = /^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/.exec(line);
    if (m) {
      out.push(line.slice(0, m[1].length) + line.slice(m[1].length + 'export '.length));
      continue;
    }
    if (/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line)) {
      throw new Error(`build: unsupported export list in ${file}: ${line.trim()}`);
    }
    out.push(line);
  }
  if (inImport) throw new Error(`build: unterminated import in ${file}`);
  return out.join('\n');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function main() {
  const parts = [];
  for (const file of FILES) {
    const source = readFileSync(join(root, file), 'utf8');
    parts.push(`\n// ---- ${file} ----\n${stripModule(source, file)}`);
  }
  const body = parts.join('\n');
  const dist = `${HEADER}\n(function () {\n'use strict';\n${body}\n})();\n`;

  // Guards: the dist must never contain blocking dialogs, leftover
  // module syntax, or anything that looks like a hardcoded secret /
  // account / repo name. The namespace above is intentionally a
  // placeholder (example.invalid), not a real URL.
  if (/\bimport\s+[^;]+from\b/.test(dist) || /(^|\n)\s*export\s/m.test(dist)) {
    throw new Error('build: leftover import/export in dist');
  }
  const codeOnly = stripComments(dist);
  if (/\b(alert|confirm|prompt)\s*\(/.test(codeOnly)) {
    throw new Error('build: blocking dialog call (alert/confirm/prompt) in dist');
  }
  for (const banned of ['MehrdadNsr', 'matrix-infra', 'GITHUB_PROXY', 'x-proxy-key']) {
    if (dist.includes(banned)) throw new Error(`build: banned string in dist: ${banned}`);
  }

  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'neon-bridge.user.js'), dist, 'utf8');
  console.log(`built dist/neon-bridge.user.js (${dist.length} bytes, ${dist.split('\n').length} lines)`);
  // The extension runs the same blob: copy it to extension/bridge.js
  // on every build so the extension never drifts from dist.
  copyFileSync(join(root, 'dist', 'neon-bridge.user.js'), join(root, 'extension', 'bridge.js'));
  console.log('copied dist/neon-bridge.user.js -> extension/bridge.js');
}

main();
