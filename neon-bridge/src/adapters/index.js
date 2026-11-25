// Adapter selection by hostname. Pure: no DOM, unit-testable.
// main.js asks selectSite(location.hostname) and instantiates the
// matching adapter class from ADAPTERS.
//
// Default agent names: gemini -> neon, muse -> muse, grok -> grok,
// chatgpt -> gpt. The agentName setting overrides them.

import { GeminiAdapter } from './gemini.js';
import { MuseAdapter, DEFAULT_MUSE_DOMAIN } from './muse.js';
import { GrokAdapter } from './grok.js';
import { ChatGptAdapter } from './chatgpt.js';

export const ADAPTERS = {
  gemini: GeminiAdapter,
  muse: MuseAdapter,
  grok: GrokAdapter,
  chatgpt: ChatGptAdapter,
};

export const DEFAULT_AGENT_NAMES = {
  gemini: 'neon',
  muse: 'muse',
  grok: 'grok',
  chatgpt: 'gpt',
};

export function defaultAgentName(site) {
  return DEFAULT_AGENT_NAMES[site] || 'neon';
}

/**
 * Which site this tab is on, by hostname. museDomain is a setting
 * (default muse.ai) so the Muse domain is easy to change.
 * Returns 'gemini' | 'muse' | 'grok' | 'chatgpt' | null.
 */
export function selectSite(hostname, museDomain = DEFAULT_MUSE_DOMAIN) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return null;
  if (host === 'gemini.google.com' || host.endsWith('.gemini.google.com')) return 'gemini';
  if (host === 'grok.com' || host.endsWith('.grok.com')) return 'grok';
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return 'chatgpt';
  const muse = String(museDomain || DEFAULT_MUSE_DOMAIN).toLowerCase();
  if (host === muse || host.endsWith(`.${muse}`)) return 'muse';
  return null;
}

/** Effective agent name: the setting wins, else the site default. */
export function effectiveAgentName(agentNameSetting, site) {
  const name = String(agentNameSetting || '').trim();
  return name || defaultAgentName(site);
}
