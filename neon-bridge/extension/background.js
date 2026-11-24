// Neon Bridge extension: background service worker.
// - storage for the GM_* shim (chrome.storage.local, keys as the userscript uses them, e.g. "nb2-bridgeKey")
// - one-time seeding from local-config.json (written next to this file on the server, never committed)
// - GM_xmlhttpRequest replacement (fetch with timeout), limited to host_permissions
// - injects bridge.js (the built userscript) into the tab once the shim has its storage

async function seedFromLocalConfig() {
  try {
    const r = await fetch(chrome.runtime.getURL("local-config.json"), { cache: "no-store" });
    if (!r.ok) return;
    const cfg = await r.json();
    const all = await chrome.storage.local.get(null);
    const add = {};
    for (const [k, v] of Object.entries(cfg || {})) {
      const key = k.startsWith("nb2-") ? k : "nb2-" + k;
      // local-config always wins for connection settings, so a key rotation on the server applies on restart
      if (["nb2-backendUrl", "nb2-bridgeKey", "nb2-workerId"].includes(key) || all[key] === undefined) add[key] = v;
    }
    if (Object.keys(add).length) await chrome.storage.local.set(add);
  } catch (_) { /* no local config: settings come from the panel */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "init") {
      await seedFromLocalConfig();
      sendResponse({ ok: true, store: await chrome.storage.local.get(null) });
    } else if (msg?.type === "set") {
      await chrome.storage.local.set({ [msg.key]: msg.value });
      sendResponse({ ok: true });
    } else if (msg?.type === "del") {
      await chrome.storage.local.remove(msg.key);
      sendResponse({ ok: true });
    } else if (msg?.type === "inject") {
      await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
        files: ["bridge.js"],
      });
      sendResponse({ ok: true });
    } else if (msg?.type === "xhr") {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), msg.timeout || 30000);
      try {
        const r = await fetch(msg.url, {
          method: msg.method || "GET",
          headers: msg.headers || {},
          body: msg.method && msg.method !== "GET" && msg.method !== "HEAD" ? msg.data ?? undefined : undefined,
          signal: ctl.signal,
          cache: "no-store",
        });
        sendResponse({ ok: true, status: r.status, text: await r.text() });
      } catch (e) {
        sendResponse({ ok: false, timeout: e?.name === "AbortError", error: String(e) });
      } finally {
        clearTimeout(t);
      }
    } else {
      sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
});
