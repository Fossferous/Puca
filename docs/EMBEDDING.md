# Embedding Púca (embedding hosts)

An **embedding host** is a program that runs Púca's web client somewhere that
is not an ordinary browser tab and drives it from controls of its own. The one
that exists is **Púca for Steam Deck** ([STEAM_DECK.md](STEAM_DECK.md), source
in `integrations/decky/`). It keeps the web client in a hidden Steam browser
view, puts the call in the Deck's Quick Access menu, and shows notifications
as Steam toasts.

This page is the contract between the web client and a host:

- `frontend/src/api/embedHost.ts` and `frontend/src/api/embedApi.ts`
  implement it;
- `frontend/src/tests/embedHost.test.ts` and `embedApi.test.ts` pin it.

A change that breaks something listed here raises `apiVersion`.

## Opting in

The host defines `window.__PUCA_EMBED_HOST__` **before the app's scripts run**,
for example with DevTools' `Page.addScriptToEvaluateOnNewDocument` or a webview
preload script:

```js
window.__PUCA_EMBED_HOST__ = {
  apiVersion: 1,                    // required; any other value: not embedded
  name: 'Púca for Steam Deck',      // shown in Settings and log lines
  getUserMedia(constraints) {},     // optional: supplies the microphone
  notify(notification) {},          // optional: shows notifications
  onStateChange(state) {},          // optional: receives the state below
  isForeground() {},                // optional: is the app on screen?
  idleSeconds() {},                 // optional: how long since the person used the device?
};
```

Without that object nothing changes. The app does not install
`window.pucaEmbed`, and every hook below does exactly what the browser would
have done. The declaration is read once, on first use, and its functions are
copied out. A script that runs later therefore cannot opt a page in, and
cannot swap a host function.

The host must declare itself only on the Púca origin it means to embed. The
declaration gives the page nothing a page script could not already do. It
gives the HOST the page's microphone track, its notifications and its call
state.

## What the app asks of the host

### `getUserMedia(constraints) → Promise<MediaStream>`

When this is present, the app calls it instead of
`navigator.mediaDevices.getUserMedia` for every microphone capture: joining a
call, a restart after a lost device, a noise-mode change, and the mic test in
Settings. A camera asked for in the same call still comes from the browser.

The host receives the app's audio constraints as they are. It decides what it
can honour.

- **Errors.** Refuse with a `DOMException` carrying the browser's error names.
  The app chooses between showing the microphone-permission help
  (`NotAllowedError`) and joining listen-only (`NotFoundError`,
  `NotReadableError`, `AbortError`, `OverconstrainedError`) by that name.
- **No audio track.** An answer without an audio track is treated as
  `NotReadableError`.
- **Stopping.** The app stops tracks it no longer needs with `track.stop()`.
  That is the host's signal to close its own capture.
- **Settings.** The input-device list is replaced by
  "*name* supplies the microphone: the system's default input", because the
  host, not the app, chooses the device.

Why it exists: Steam's browser refuses `getUserMedia` to every site that is
not Steam's own. Measured on a Deck (Steam client build 1791918634,
Chromium 126), the refusal (`NotAllowedError`) came in each of these places:

- in a browser view;
- in an iframe inside Steam's own page;
- with a DevTools permission grant in force.

### `notify({ id, title, body, key, kind })`

When this is present, the app's notifications go to the host instead of the
browser's Notification API. That covers:

- message notifications;
- due-task reminders;
- the Settings test notification.

The app judges each one with the same rules as everywhere else:

- the **Enable Desktop Notifications** setting;
- muted servers and channels;
- never your own messages;
- only while the app is not on screen.

There is no browser permission to ask. The setting's switch needs none with a
host.

- `kind`: `'message' | 'tasks' | 'test'`.
- `key`: collapses repeats from one conversation: `dm:<id>`,
  `chan:<serverId>`, `tasks-due`, `test`.
- `body`: **content-free** ("New message"), as on every platform: messages
  are end-to-end encrypted, and a notification survives where people can see
  it.
- When the person taps it, call `pucaEmbed.activateNotification(id)`. The
  app then does what clicking the browser's notification would have done
  (for a channel message, open that channel). This works once; only the 20
  most recent notifications are kept.

### `isForeground() → boolean`

This answers "is the app on screen?" when deciding whether a notification is
due. A hidden Steam browser view reports `document.hasFocus()` as true all
the time, which alone would hold every notification back. A host that cannot
answer (missing, or throwing) falls back to the page's own focus.

### `idleSeconds() → number | null` (may return a Promise)

This answers "how many seconds since the person last used the device?" for
input the page itself never receives. The app's move to the AFK channel uses
it where the desktop app uses the system's idle time. Rules:

- **Who is idle.** By Discord's rules: someone who has neither spoken nor
  touched anything for the server's AFK time is moved. Someone playing a game
  is not.
- **Why a host must answer.** A page in a hidden view sees no input while its
  person plays. Without an answer, a player who only listens is moved
  mid-game. Púca for Steam Deck answers from the Deck's own controls: whether
  any is touched or pressed, never which.
- **Page input still counts.** Input inside the page (typing in the full view)
  counts as well; the more recent of the two decides.
- **No answer.** `null` means "cannot tell right now": the app falls back to
  input inside the page alone, as in a browser tab.
- **Errors.** A function that throws, or answers anything but a finite
  number ≥ 0, is treated like a failed desktop probe. The app waits a whole
  window again rather than move someone who may be there.
- **Desktop.** The desktop app's own probe is used instead whenever it has
  one.

### `onStateChange(state)`

The app calls this with the state snapshot below whenever it changes.

- Bursts are coalesced; speaking flips several times a second per talker.
- A snapshot is sent only when something in it changed.
- An exception thrown here is logged and ignored.

## What the host can call: `window.pucaEmbed`

The app installs this object, frozen, at startup when a host declared itself.
Every command goes through the same code as the app's own controls:

- joining is the voice channel click's path;
- mute and deafen are the buttons' presses;
- push-to-talk is the registered hold action.

| Call | Returns | What it does |
|---|---|---|
| `apiVersion` | `1` | |
| `getState()` | `EmbedState` | The snapshot below, now. |
| `listVoiceChannels(serverId)` | `Promise<{ id, name, canConnect, members: { id, username }[] }[]>` | The server's voice channels and who is in each. Empty when signed out. |
| `joinVoice(serverId, channelId)` | `Promise<{ ok: true } \| { ok: false, error }>` | Joins that channel's call, or moves this device's call there (mute and deafen come along, as with a click). `ok` means the call is starting; `state.call.connected` says when it has. A warning the app shows before some joins can hold it back until the person opens the app. |
| `leaveVoice()` | `boolean` | Leaves the call, as **Disconnect**. |
| `setMuted(muted)` | `boolean` (got there) | Presses **Mute** if needed. Refused while deafened, in an AFK channel, or without SPEAK, as the button is. |
| `setDeafened(deafened)` | `boolean` | Presses **Deafen** if needed. |
| `setInputMode('open' \| 'pushToTalk' \| 'pushToMute')` | `boolean` | Saves **Settings → Voice & Video → Input mode** for this device. |
| `holdPushToTalk(held)` | `boolean` (an action was held) | The host's push-to-talk button. See below. |
| `activateNotification(id)` | `boolean` | The person tapped notification `id`. |
| `downloadSite()` | `Promise<string \| null>` | The server's download site: the origin of `download_url` in its `/app-version`, read fresh, or `null` when it publishes none. https only, or plain http on the device's own loopback (a local test server). A host looks for its own updates there, so the address comes from the server the person uses. |

### Push-to-talk is a lease

`holdPushToTalk(true)` holds the current input mode's hold action:

- push-to-talk opens the microphone;
- push-to-mute shuts it;
- voice activity, or being out of a call, has nothing to hold, and the call
  returns `false`.

A hold lasts **1.5 seconds** unless `true` is sent again. Send it every half
second or so while the button is down, and `false` on release. A host that
dies mid-press, or loses its connection to the page, therefore cannot leave a
microphone open. Losing window focus does not release a host's hold (it does
release a held key), because the host's button is not a key the window can
lose.

## The state

```ts
interface EmbedState {
  apiVersion: 1;
  appVersion: string;             // the web client's version
  signedIn: boolean;
  user: { id: number; username: string } | null;
  servers: { id: string; name: string }[];
  currentServerId: string | null; // open in the full app: a default for a picker
  call: null | {
    serverId: string | null;
    channelId: number;
    channelName: string;
    connected: boolean;           // in the call
    connecting: boolean;
    muted: boolean;               // the mute in force (own, or imposed by the call)
    deafened: boolean;
    noMicrophone: boolean;        // in the call without one (none, no SPEAK, or by choice)
    inputMode: 'open' | 'pushToTalk' | 'pushToMute';
    holdDown: boolean;            // push-to-talk / push-to-mute held right now
    members: {
      id: number; username: string;
      speaking: boolean; muted: boolean; deafened: boolean;
      noMicrophone: boolean;
      self: boolean;              // the signed-in account
    }[];
  };
}
```

## What embedding does not change

- **End-to-end encryption.** Calls, messages and files are encrypted in the
  page exactly as in a browser. The host receives the microphone track
  before encryption, which is what supplying the microphone means. It never
  receives keys or message text.
- **Where the code comes from.** An embedded web client is still code the
  server sends on every load, with the trust that implies
  ([SECURITY_MODEL.md](SECURITY_MODEL.md)). The desktop app, which ships its
  own code, is not affected.
- **The automation hooks.** [AUTOMATION.md](AUTOMATION.md)'s `data-testid`
  contract is for driving the page in a headless browser. This API is for a
  host that lives beside the page.
