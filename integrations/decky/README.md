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
  - Opens the microphone (`micBridge.ts`), and notices when it delivers only
    digital silence: a muted or zeroed system microphone (`micSilence.ts`).
  - Turns the backend's back-button signal into Púca's push-to-talk hold
    (`ptt.ts`).
  - Turns notifications into Steam toasts (`controller.ts`).
- **`main.py` + `py_modules/` (backend, Python inside Decky).**
  - Attaches to that one view over Steam's DevTools endpoint on 127.0.0.1:8080.
  - Injects the page shim before Púca's scripts run, and opens the configured
    address.
  - Relays between page and frontend. Only messages from Púca's own main-frame
    page are accepted (`puca_cdp.PucaPage`).
  - Reads the Deck's controls during a call (`puca_buttons.py`): the
    push-to-talk button, and whether any control is in use, which it tells
    the page so Púca's AFK move does not take a player out of the call
    (`idleSeconds`, docs/EMBEDDING.md). In Settings, it reports which back
    button is pressed, so push to talk is chosen by pressing it.
  - Fetches the plugin's own updates (`puca_update.py`): see *Updates*.
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

**Why push-to-talk reads the controller itself.** Steam's button feed for its
own interface, `SteamClient.Input.RegisterForControllerInputMessages`, cannot
be counted on for this. Tests on a Deck in Game Mode, 2026-10-22/23:

- it reported the lower right grip (its button 33) in most rounds;
- in one round, while another app was in front, it reported nothing at all
  for the same button, and push to talk matters most while a game is in
  front;
- the backend's own reader caught every hold in every round.

The backend reads the Deck's controller from `/dev/hidraw`, which SteamOS lets
the signed-in user read; no root is needed.

- **Layout.** The Linux driver's (`drivers/hid/hid-steam.c`,
  `steam_deck_button_mappings`):
  - message type `0x09` is the input state;
  - L4 and R4 are byte 13 bits 1 and 2;
  - L5 is byte 9 bit 7, and R5 is byte 10 bit 0.
- **Stream.** The controller sends that state 250 times a second whether
  anything is held or not (measured: one of its three nodes, with a frame
  counter stepping by 1).
- **Scope.** Only the chosen bit is looked at, and only while a button is
  chosen and Púca is in a call.
- **Signal.** The backend sends `puca_button`: `true` when the button goes
  down and every 500 ms while it stays down, and `false` when it comes up,
  when the controller goes quiet for a second, and when the watch stops.
- **Safety.** The frontend renews Púca's 1.5 s hold lease with each
  heartbeat, so a lost release, or a backend that dies mid-hold, cannot leave
  the microphone transmitting.
- **In games.** hidraw gives every reader its own copy of each message, so
  this takes nothing from Steam and keeps working while a game has focus.

## Updates

The plugin updates itself from the download site of the person's own Púca
server: the page's `downloadSite()` (docs/EMBEDDING.md) names it, and the
site publishes `steam-deck/puca-decky.json` beside the zips
(`deploy/ops/dual-ship.sh decky`).

- **When.** 20 seconds after Púca is up, then every six hours. A newer
  version shows **Update** at the top of the panel, never during a call:
  installing restarts Púca.
- **Signed.** The plugin runs inside Steam, with more reach than the page, so
  a server alone must not be able to change it. An update is installed only
  when it is signed with the release key whose public half the plugin carries
  (`update-key.json`, put in by `npm run release`). The signature covers
  `puca-decky-update/1`, the version and the zip's SHA-256
  (RSASSA-PKCS1-v1_5, SHA-256), and is checked in the frontend with
  WebCrypto (`src/update.ts`). The version inside it is what stops an old,
  genuinely signed release being offered again as new.
- **Installed by Decky.** The backend downloads the zip into the plugin's
  runtime directory and checks its SHA-256. The frontend checks the signature
  again, then asks Decky to install the file with that same SHA-256, which
  Decky checks once more. Decky shows its own confirmation, then reloads the
  plugin. The download is a local file, so Decky reports nothing to its
  plugin store about it.
- **No key, no updates.** `npm run package` builds without one: fine on a
  test Deck, wrong for anything published, and `dual-ship.sh decky` refuses
  it.

To make a release:

```bash
npm ci
npm run release -- --key <release key>   # build, package with the key's public half, sign, verify
../../deploy/ops/dual-ship.sh decky out/puca-decky-<version>.zip out/puca-decky.json
```

Raise `version` in `package.json` first: installed plugins offer only a
newer version. Every release must be signed with the same key, because
installed plugins accept only the key they were installed with. Púca's own
releases use the mobile OTA key (`mobile-updater-rsa.key`, already in the key
backups). The two signatures cannot stand in for each other: the OTA's
checksum is a bare SHA-256 under the key, this a DigestInfo over a text that
begins `puca-decky-update/1` (`tests/update.test.ts` checks both ways).
`dual-ship.sh decky` checks the release with `scripts/verify_update.py`, a
second implementation, against the key the published release carries before
it uploads anything.

## Build and test

```bash
npm ci
npm run typecheck
npm test                 # vitest: settings, push-to-talk, the page protocol
npm run test:py          # unittest: the backend's checks, the back-button reader, updates (aiohttp not needed)
npm run package          # build + out/puca-decky-<version>.zip (+ .sha256), without an update key
```

The zip is deterministic: the same sources give the same bytes, on any
machine (text goes in with LF line ends, whatever the checkout used). Its
`package.json` must keep `"type": "module"`: Decky imports `dist/index.js` as
an ES module only then, and otherwise evaluates it as a legacy script, which
fails at the first `export`. `scripts/package.py` refuses to build a zip
without it, and `tests/test_package.py` checks it against Decky's own rule.
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
