# Neon Bridge as a Chrome extension (server use)

The server Chrome (Chromium in Docker) loads this folder with `--load-extension`, so no Tampermonkey and no clicking is needed.

- `bridge.js` = a copy of `../dist/neon-bridge.user.js` (keep it in sync: `build.mjs` should copy it here).
- `shim.js` provides `GM_getValue/GM_setValue/GM_deleteValue/GM_xmlhttpRequest` on top of `chrome.storage` and the background worker.
- `local-config.json` (NOT in git) is written by the server's `bridge_update` command with `backendUrl`, `bridgeKey`, `workerId`; it seeds the settings on start.
- Update on the server: queue the control-switch command `bridge_update` (fetches this folder from GitHub through Supabase and restarts Chrome).
