// Neon Bridge extension: GM_* shim for the userscript, then asks the background to inject bridge.js.
// Runs in the extension's isolated world; bridge.js is injected into the same world, so it sees these globals.
(() => {
  if (window.top !== window) return; // @noframes
  if (globalThis.__nb2ShimLoaded) return;
  globalThis.__nb2ShimLoaded = true;

  const cache = Object.create(null);

  globalThis.GM_getValue = (key, fallback) => (key in cache ? cache[key] : fallback);
  globalThis.GM_setValue = (key, value) => {
    cache[key] = value;
    chrome.runtime.sendMessage({ type: "set", key, value });
  };
  globalThis.GM_deleteValue = (key) => {
    delete cache[key];
    chrome.runtime.sendMessage({ type: "del", key });
  };
  globalThis.GM_xmlhttpRequest = (d) => {
    chrome.runtime.sendMessage(
      { type: "xhr", method: d.method, url: d.url, headers: d.headers, data: d.data, timeout: d.timeout },
      (res) => {
        if (chrome.runtime.lastError || !res) { d.onerror && d.onerror({ error: chrome.runtime.lastError?.message }); return; }
        if (!res.ok) { (res.timeout ? d.ontimeout : d.onerror)?.(res); return; }
        d.onload && d.onload({ status: res.status, responseText: res.text });
      },
    );
  };

  chrome.runtime.sendMessage({ type: "init" }, (res) => {
    if (res?.store) Object.assign(cache, res.store);
    chrome.runtime.sendMessage({ type: "inject" });
  });
})();
