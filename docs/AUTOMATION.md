# Automation hooks (supported contract)

An automated account (see [STREAM_ONLY.md](STREAM_ONLY.md)) drives the Púca
web client in a headless browser. CSS classes, button text and the layout of
the page change from release to release; the `data-testid` attributes below do
not. They are a **supported contract**:

- each one stays on the element and meaning listed here;
- renaming or removing one is a breaking change, said so in the changelog;
- `frontend/src/tests/automationHooks.test.tsx` fails if one goes missing,
  moves to another control, or is added to the client without being listed
  here.

Anything not in this table (classes such as `.server-icon` or
`.vp-screenshare`, tooltips, the order of buttons) is not part of the
contract.

## The hooks

| `data-testid` | Element | What it does |
|---|---|---|
| `server-icon` | A server in the server rail; carries `data-server-id` | Click to select that server |
| `voice-channel` | A voice channel's row in the channel list; carries `data-channel-id` | Click to open the channel. Opening it joins the call |
| `voice-join` | The **Join Voice** button | Shown only when opening the channel did not join (a warning was shown first). Click to join |
| `voice-connected` | The voice panel's connection line | Present while this device is in the call |
| `voice-share-screen` | The **Share Screen** button | Click to start sharing (the browser's screen picker opens) |
| `share-go-live` | The share dialog's start button | Only when the share dialog is shown (the arrow beside Share Screen, or picking app audio in the desktop app) |
| `voice-stop-share` | The same button while sharing (**Stop Sharing**) | Click to stop sharing |
| `voice-leave` | The **Disconnect** button | Click to leave the call |

Setup, done once by people rather than by the automation:

| `data-testid` | Element |
|---|---|
| `settings-join-without-mic` | **Settings → Voice & Video → Join voice without a microphone** |
| `create-stream-only-role` | **+ Stream Only Role** in **Server Settings → Roles** |
| `role-automated-streaming` | The role editor's **Automated Streaming** section |
| `role-stream-only` | Its **Stream only** checkbox |
| `role-no-receive` | Its **No receive** checkbox |
| `role-stream-channel` | One voice channel's checkbox under **Voice channels this role may stream in**; carries `data-channel-id` |

## A typical run

1. Sign in once with **Stay signed in on this device** ticked; the session
   then lasts as long as the account opens Púca at least once a month.
2. Find the server and channel ids over the API: `GET /servers` and
   `GET /servers/:id/channels` (a stream-only account sees only the voice
   channels opened for it). `GET /servers/:id/voice-users` says who is in
   each call.
3. Click `[data-testid="server-icon"][data-server-id="<server>"]`, then
   `[data-testid="voice-channel"][data-channel-id="<channel>"]`.
4. Wait for `[data-testid="voice-connected"]`. If `[data-testid="voice-join"]`
   appears instead, read the warning beside it before clicking it.
5. Click `[data-testid="voice-share-screen"]`. The client calls the browser's
   `getDisplayMedia`, so the headless browser must be set up to answer it
   with the video to share.
6. To stop, click `[data-testid="voice-stop-share"]`; to leave,
   `[data-testid="voice-leave"]`.

A stream-only account joins without a microphone by itself, so no microphone
prompt appears. The share button is not shown in a phone browser (phones have
no screen picker), and on a narrow touch screen the call's controls are
collapsed behind **More voice controls**; run the automation at a desktop
window size.
