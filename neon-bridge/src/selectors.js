// The one map of every selector the script uses.
// A Gemini UI change means editing this file, not hunting through code.
//
// Each key maps to an ordered list of CSS selectors tried in order.
// Keys marked 'spec' were given as verified page facts; keys marked
// 'unverified' are best guesses the owner must check on the live page
// (see README.md "Selectors not yet verified"). Text matching (model
// names, "Send" / "ارسال") is done by the adapter using the strings in
// TEXT_MATCH below — never match on other UI text, because the UI
// language may be Persian.
//
// Model names are always matched in English: "Hydrogen", "Neon 4",
// "Carbon" (locked).

export const SELECTORS = {
  // Prompt editor (contenteditable). [spec]
  // Extra fallbacks borrowed as an idea from Gemini Prompt Queue
  // (nihaltp/uscripts, MIT): generic contenteditable textbox.
  editor: [
    'rich-textarea .ql-editor',
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
  ],

  // Send button. Primary is the aria-label; the rest are fallbacks.
  // The data-testid / title variants are borrowed as an idea from
  // Gemini Prompt Queue (nihaltp/uscripts, MIT). The final fallback
  // (last enabled button in the input area) is implemented by the
  // adapter, not as a selector. [spec, fallbacks unverified]
  send: [
    'button[aria-label*="Send" i]',
    'button[data-testid="send-button"]',
    'button.send-button',
    'button[title*="Send" i]',
    'button[aria-label*="ارسال"]',
  ],
  // The input area that contains the send button (for the last-button fallback).
  inputArea: ['rich-textarea', '[data-testid="input-area"]'],

  // Conversation turns. [spec]
  userQuery: ['user-query'],
  modelResponse: ['model-response'],
  messageContent: ['message-content'],
  // Thinking sections inside an answer — excluded when reading text.
  modelThoughts: ['model-thoughts', '[data-thoughts]', '.thinking-content'],
  // Code blocks inside an answer. [spec]
  codeBlock: ['pre code'],

  // Stop-generation button (present while Gemini is answering).
  // data-testid variant borrowed as an idea from Gemini Prompt Queue.
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="توقف"]',
  ],

  // Busy indicators (also from Gemini Prompt Queue): a generation is
  // in progress when any of these is present, even without a stop
  // button. Used together with the stop button in waitForCompletion.
  busyIndicators: ['[aria-busy="true"]', '[data-loading="true"]', '[role="progressbar"]'],

  // Model picker: the button in the input bar showing the current
  // mode name, and the menu it opens. [unverified — see README]
  modelPickerButton: [
    'button[aria-label*="model" i]',
    'button[aria-label*="Model" i]',
  ],
  modelMenu: ['[role="menu"]', '[role="listbox"]'],
  modelMenuItem: ['[role="menuitem"]', '[role="option"]', 'li'],
  // The last menu row opens the thinking-level submenu. [unverified]
  thinkingSubmenuRow: ['[role="menu"] > *:last-child', '[role="listbox"] > *:last-child'],
  thinkingOption: ['[role="menuitemradio"]', '[role="option"]', '[aria-checked]'],

  // Toasts / inline errors. [unverified]
  errorToast: ['[role="alert"]', '.error-toast', '[data-testid="error-toast"]'],

  // Sign-in / captcha / unusual-traffic markers (checked by text too).
  signInLink: ['a[href*="accounts.google.com"]'],

  // Permission-prompt dialogs (MCP tool approval). [unverified]
  permissionDialog: ['[role="dialog"]', '[role="alertdialog"]'],
};

/** Text fragments the adapter may match on (model names only in English). */
export const TEXT_MATCH = {
  modelNames: { neon: 'Neon 4', hydrogen: 'Hydrogen', carbon: 'Carbon' },
  sendLabels: ['Send', 'ارسال'],
  stopLabels: ['Stop', 'توقف'],
  signedOut: ['Sign in', 'ورود'],
  captcha: ['captcha', 'unusual traffic', 'ترافیک غیرمعمول'],
  // Permission-prompt buttons. Exact (anchored) match only: "Allow
  // all" or "Allow once" must never match. Persian: «اجازه دادن» =
  // Allow, «همیشه اجازه داده شود» = Always allow.
  permissionButtons: {
    always: [/^always allow$/i, /^همیشه اجازه داده شود$/],
    allow: [/^allow$/i, /^اجازه دادن$/],
  },
};

/** Which selector keys still need a live-page check by the owner. */
export const SELECTOR_VERIFICATION = {
  editor: 'spec',
  send: 'spec-primary-only',
  inputArea: 'unverified',
  userQuery: 'spec',
  modelResponse: 'spec',
  messageContent: 'spec',
  modelThoughts: 'spec',
  codeBlock: 'spec',
  stopButton: 'unverified',
  busyIndicators: 'unverified',
  modelPickerButton: 'unverified',
  modelMenu: 'unverified',
  modelMenuItem: 'unverified',
  thinkingSubmenuRow: 'unverified',
  thinkingOption: 'unverified',
  errorToast: 'unverified',
  signInLink: 'unverified',
  permissionDialog: 'unverified',
};
