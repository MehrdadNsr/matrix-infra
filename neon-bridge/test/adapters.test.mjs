import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSite, defaultAgentName, effectiveAgentName } from '../src/adapters/index.js';
import { defaultCodeEnabled } from '../src/core/chat.js';

describe('adapter selection by hostname', () => {
  it('picks gemini for gemini.google.com and subdomains', () => {
    assert.equal(selectSite('gemini.google.com'), 'gemini');
    assert.equal(selectSite('www.gemini.google.com'), 'gemini');
  });
  it('picks grok / chatgpt', () => {
    assert.equal(selectSite('grok.com'), 'grok');
    assert.equal(selectSite('chatgpt.com'), 'chatgpt');
    assert.equal(selectSite('www.chatgpt.com'), 'chatgpt');
  });
  it('picks muse for the configured domain', () => {
    assert.equal(selectSite('muse.ai'), 'muse');
    assert.equal(selectSite('app.muse.ai'), 'muse');
    assert.equal(selectSite('muse.example.com', 'muse.example.com'), 'muse');
    assert.equal(selectSite('muse.ai', 'muse.example.com'), null);
  });
  it('returns null for unknown hosts and lookalikes', () => {
    assert.equal(selectSite('example.com'), null);
    assert.equal(selectSite('chatgpt.com.evil.com'), null);
    assert.equal(selectSite('fakegemini.google.com'), null);
    assert.equal(selectSite(''), null);
  });
});

describe('agent names', () => {
  it('defaults per site', () => {
    assert.equal(defaultAgentName('gemini'), 'neon');
    assert.equal(defaultAgentName('muse'), 'muse');
    assert.equal(defaultAgentName('grok'), 'grok');
    assert.equal(defaultAgentName('chatgpt'), 'gpt');
  });
  it('the setting wins over the site default', () => {
    assert.equal(effectiveAgentName('custom', 'gemini'), 'custom');
    assert.equal(effectiveAgentName('', 'grok'), 'grok');
    assert.equal(effectiveAgentName('  ', 'chatgpt'), 'gpt');
  });
});

describe('codeEnabled defaults', () => {
  it('only Gemini has code flows by default', () => {
    assert.equal(defaultCodeEnabled('gemini'), true);
    assert.equal(defaultCodeEnabled('muse'), false);
    assert.equal(defaultCodeEnabled('grok'), false);
    assert.equal(defaultCodeEnabled('chatgpt'), false);
  });
});
