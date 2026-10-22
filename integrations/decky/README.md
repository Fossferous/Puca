# Púca for Steam Deck (Decky Loader plugin)

How to install and use it: [docs/STEAM_DECK.md](../../docs/STEAM_DECK.md).
The page's half of the contract: [docs/EMBEDDING.md](../../docs/EMBEDDING.md).

## How it works

Steam's Game Mode UI is Chromium (CEF). The plugin keeps Púca's live web
client in a hidden Steam **browser view**, the same machinery as Steam's own
web browser. So Púca is the server's current version, runs end-to-end
encryption as in any Chromium, and keeps running while a game is in front.
The approach follows Deckcord (a Discord plugin for Decky). The code is this
plugin's own.

- **`src/` (frontend, Steam's own page).**
  - Creates the view (`browserView.ts`).
  - Draws the Quick Access panel and the `/puca` full view (`components/`).
  - Opens the microphone (`micBridge.ts`).
  - Turns a back button into push-to-talk (`ptt.ts`).
  - Turns notifications into Steam toasts (`controller.ts`).
- **`main.py` + `py_modules/` (backend, Python inside Decky).**
  - Attaches to that one view over Steam's DevTools endpoint on 127.0.0.1:8080.
  - Injects the page shim before Púca's scripts run, and opens the configured
    address.
  - Relays between page and frontend. Only messages from Púca's own main-frame
    page are accepted (`puca_cdp.PucaPage`).
  - Stores the plugin's four settings.
- **`src/shim/pageShim.ts` (inside the Púca page).** Built separately into
  `dist/page-shim.js`.
  - Declares the plugin as Púca's embedding host.
  - Holds the receiving end of the microphone bridge.

**Why the microphone takes a detour.** Steam's browser refuses
`getUserMedia` to any site that is not Steam's own. Measured on a Deck,
2026-10-22, it refused in a browser view, in an iframe, and with a DevTools
permission grant. Capture does work in Steam's own page. So the frontend
captures there and sends the track to the page over a local
`RTCPeerConnection`, with no ICE servers, so it never leaves the Deck. Púca
then encrypts it for the call like any microphone.

Two measured details:

- the page must play the bridged track on a **muted** `<audio>` element, or
  Chromium delivers silence to Web Audio and to the encoder;
- the bridge adds about 40 ms (a 1 ms round trip, plus Chromium's jitter
  buffer).

## Build and test

```bash
npm ci
npm run typecheck
npm test                 # vitest: settings, push-to-talk, the page protocol
npm run test:py          # unittest: the backend's checks (aiohttp not needed)
npm run package          # build + out/puca-decky-<version>.zip (+ .sha256)
```

The zip is deterministic: the same sources give the same bytes.
`@decky/ui`, React and Steam's own globals are provided by Decky at run time
and are not bundled. `@decky/api` (LGPL-2.1) is bundled, with its licence in
the zip.

## Try a build on a Deck

You need SSH to the Deck and its `sudo` password. Plugins live in the
root-owned `~/homebrew/plugins`.

```bash
scp out/puca-decky-<version>.zip deck@<deck>:/tmp/
ssh -t deck@<deck> 'sudo rm -rf ~/homebrew/plugins/puca && sudo unzip -q /tmp/puca-decky-<version>.zip -d ~/homebrew/plugins/ && sudo systemctl restart plugin_loader'
```

To debug, forward Steam's DevTools port. `127.0.0.1:8080` is local to the
Deck, so nothing is exposed to the network:

```bash
ssh -N -L 8080:127.0.0.1:8080 deck@<deck>
```

Then open `chrome://inspect` → Configure → `localhost:8080`. The page to
inspect is **SharedJSContext** for the plugin's frontend, and the Púca page
for the web client. The backend logs to
`~/homebrew/logs/puca/`.

To test against a local Púca instead of a real server, set the address to
`http://127.0.0.1:<port>`. Loopback http is a secure context, so encryption
still runs. Then reverse-tunnel your dev server and backend to the Deck:

```bash
ssh -N -R 5173:127.0.0.1:5173 -R 3000:127.0.0.1:3000 deck@<deck>
```
