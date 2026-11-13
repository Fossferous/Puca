# Discord in a window of its own

The Windows desktop app can open Discord's own website in a window of its own,
for people you still talk to on Discord. You sign in on Discord's page and use it
as you would in a browser. This page says how that window is kept apart from
Púca, what Púca can and cannot see, the risks that remain, and how to sign out
and clear it. How to use it day to day is in
[USER_GUIDE.md](USER_GUIDE.md#discord-in-a-window-of-its-own-windows-desktop-app).

It is **off by default**. Nothing of it exists on your PC until you turn on
**Settings → Advanced → Desktop App → Show Discord in the server rail** and press
the Discord button. The web app and the phone apps have no Discord button at all.

## What Púca can and cannot see

- **Púca's code never runs in that window.** No script of Púca's is put into
  Discord's page, and the page has no way to call into Púca.
- **Púca cannot read the page, your messages or your Discord sign-in.** The
  window decides only where a page may load, from its address, and how to
  answer a permission request, from its kind and the site asking.
- **Your Púca server never sees any of it.** The window talks to Discord
  directly, the same way a browser would. Nothing from it goes through Púca's
  server, and Púca's connection to your server is not in that window's program.
- **Your Discord sign-in is kept in a separate store on this PC**, a folder of
  its own (`%LOCALAPPDATA%\com.sovereign.chat\discord-profile`), apart from
  Púca's own browser data. Signing out of Púca does not sign you out of Discord,
  and clearing one does not touch the other.
- **Discord sees what you do in Discord**, as it does in a browser or in its own
  app. Púca changes nothing about that.

## How the isolation is built, and where to check it

Everything here is in this repository. The names are functions, constants and
tests you can search for.

**A separate program with no Púca in it.** The Discord window is a second
process of the Púca program, `Puca.exe --discord-window`. The first lines of
`run()` in `frontend/src-tauri/src/lib.rs` send that process to
`run_window_process` in `frontend/src-tauri/src/discord_window.rs` before Tauri,
Púca's plugins, its tray, its connection to your server or anything else of
Púca's starts. The test `the_discord_process_starts_nothing_of_puca_s` keeps
that order.

**No Tauri, so no bridge.** That process is a plain Windows window hosting
Microsoft's WebView2 directly (`frontend/src-tauri/src/discord_host.rs`). It does
not use Tauri, the framework the rest of the desktop app is built on, because a
Tauri webview always carries Tauri's bridge: a script with the app's invoke key
in every page, a message channel to the app, and its `ipc` and `tauri` protocols,
which would let a page reach the app's command endpoint and its own files
(in Tauri's own source, the function prepare_pending_webview in its
manager/webview.rs, and the WebView2 part of wry, the library under it, in the
versions this app locks). In the Discord window:

- no script is ever added to the page or run in it;
- web messages from the page are off (`SetIsWebMessageEnabled(false)`), and
  there are no host objects (`SetAreHostObjectsAllowed(false)`);
- nothing intercepts the page's requests, so `ipc.localhost` and
  `tauri.localhost` are just names with nothing of Púca's behind them;
- there is no developer console (`SetAreDevToolsEnabled(false)`): "paste this
  code into the console" is how Discord accounts are stolen.

Two tests in `discord_host.rs` hold this:

- `nothing_above_the_tests_can_put_anything_into_the_page` lists every WebView2
  call the window makes (`ALLOWED_CALLS`). Any other call fails it: one that
  runs or adds a script, passes web messages, adds a host object, intercepts or
  watches requests, reads the page, its title or cookies, or opens a debugging
  channel. `webview2_is_used_in_this_file_alone` keeps such a call from hiding
  in another file.
- `the_page_sees_no_bridge` builds the window's real webview, hidden and on a
  throwaway profile, and runs a page there. That page finds no Tauri globals,
  a message it sends never reaches the host, and nothing answers on
  `ipc.localhost` or `tauri.localhost`. The negative control puts a bridge in
  on purpose (an injected script, web messaging on, both names intercepted the
  way Tauri serves them), and the same page then finds each of them.

**Púca's own window cannot reach it either.** Púca has two commands for it,
`discord_window_open` (open the window or bring it forward) and
`discord_window_clear_data` (close it and delete its folder). Neither touches
the page. Púca's capability file, `frontend/src-tauri/capabilities/default.json`,
names Púca's own window only. Two tests check it: `capability_files` in
`discord_window.rs` (no capability may match the Discord window, leave its
windows unnamed, or grant a website), and `frontend/src-tauri/tests/discord_acl.rs`
(the capability set the build compiled in, put through Tauri's own access
checks). The second one is a backstop, since the Discord window has no Tauri at
all.

**Its own profile, held exclusively.** `profile_dir_from_env` is the only folder
it uses. WebView2 opens it with exclusive access (`create_environment`), so no
other program, Púca's own window included, can open a browser on Discord's data
while the window is open. Before WebView2 starts, the window takes out every
`WEBVIEW2_` environment variable except the one that picks the runtime, and
`SSLKEYLOGFILE` (`scrubbed`): between them they could point WebView2 elsewhere,
attach a debugger, or write its encryption keys to a file. A WebView2 too old
to have the window's gates for external programs and screen sharing gets no
Discord window at all, rather than one without them, and says so.

**Discord's domains only.** A page may load in the window only from
discord.com and its subdomains, discord.gg (invites) and discordapp.com (its
old name), over https on the normal port (`navigation`). Any other web address
opens in your browser instead, and only when you pressed something
(`navigation_action`, `popup_action`). A page cannot open site after site in
your browser by itself. Anything that is not a web address (`file:`,
`javascript:`, a link that starts another program) goes nowhere, from the page
or any frame in it. A popup never becomes a window: a Discord address loads in
this window, and anything else goes to your browser. An address that cannot be
read is refused. What Discord loads into its page (pictures, its CDN, the
captcha at sign-in) is not a page of its own and is not affected.

**The title says where you are.** There is no address bar. The title bar shows
the current site, for example "Discord · discord.com", and changes with every
navigation (`window_title`). It never shows the page's own title. A lookalike
domain shows as its real, encoded name.

## Permissions

`permission_decision` in `discord_window.rs` decides, per site and per kind.
Nothing is ever granted to any site but Discord's own app (discord.com, and its
PTB and Canary versions). Discord's app is given nothing without a question,
with one exception: whether it may play sound and video by itself (autoplay) is
left to WebView2's own rule, which asks nothing.

| Asked for | From Discord's app | From any other site |
|---|---|---|
| Microphone, camera | WebView2's own question (and Windows' own microphone and camera settings) | Refused |
| Reading the clipboard | WebView2's own question | Refused |
| Notifications | Púca's question, only after you pressed something in Discord that asked | Refused |
| Sharing your screen | WebView2's own picker | Refused |
| Playing sound and video by itself (autoplay) | WebView2's own rule, with no question | Refused |
| Location, and everything else | Refused | Refused |

WebView2 has no question of its own for notifications. Without one, it refuses
them all, so Púca asks: "Discord is asking to show notifications on this PC.
Press OK to allow them." Cancel is the default button, so Enter, Space or Esc
allow nothing. A request Discord's page makes by itself, without your press, is
refused without a question. **OK** is remembered in Discord's profile. **Cancel**
is not, so Discord's own "enable notifications" can ask again later. Discord's
notifications go from its page to WebView2's own notification display; Púca
never receives them. Turn them off in Discord: **User Settings → Notifications**.

## Voice calls

A Discord voice or video call works in that window, as in a browser: WebView2
asks for the microphone and camera the first time, and screen sharing uses
WebView2's own picker. What it will not do, because it is Discord's website and
not its app:

- Push to talk works only while the Discord window is focused (Discord's own
  limit for its website). Use Voice Activity if you play with it in the
  background.
- No game activity and no overlay.
- Púca's own streams never carry the Discord window's sound: when you share an
  app's audio in Púca, the Discord window counts as part of Púca and is not
  offered, even after Púca has restarted while the window stayed open
  (`is_pucas_own` in `frontend/src-tauri/src/audio_capture.rs`).
- A screen share from the Discord window keeps Windows' "sharing your screen"
  bar and its **Stop sharing** button. Púca's **Hide Windows' "sharing your
  screen" bar** setting hides only Púca's own bar: with the Discord window behind
  a game, that bar is the one sign on the desktop that the share to Discord is
  still running, and Púca's tray icon does not turn amber for it
  (`own_webviews` in `frontend/src-tauri/src/capture_bar.rs`, which asks the
  same `boost_targets` rule in `stream_boost.rs` that keeps a Púca share from
  raising the Discord window's priority).

## Downloads

A file you download from Discord is saved the way Edge saves it: into your
Downloads folder, with WebView2's own download list, checked by SmartScreen.
Nothing opens by itself, and nothing goes through Púca's own file handling. The
window does not handle downloads at all.

## The risks that remain

- **Another program running as you can reach the window.** It can do to this
  window what it can do to any window on your desktop: send it keys and clicks,
  or put a window of the same name in its place. That is part of the next point.

- **Malware on your PC can read saved sign-ins.** Any program running as you can
  read any browser's or app's saved sign-in, this one included, just as it could
  read the official Discord app's. Keeping it in its own folder protects it from
  Púca, not from a program that already controls your PC.
- **A Púca update is trusted like any installed app.** A malicious update could
  change what this window does, as a malicious update of any app could. Púca's
  updates are signed with a key that never touches the server, the source is
  public, and this page names the code to check.
- **WebView2's own security updates come from Microsoft.** The window runs on the
  WebView2 runtime that Windows keeps up to date along with Microsoft Edge, not
  on a browser Púca ships. Púca's installer only installs it if it is missing.
- **The look of notifications is WebView2's.** How a notification appears, and
  what a click on it does, is WebView2's own behaviour, not something Púca
  draws.

## Sign out and clear its data

**Settings → Advanced → Desktop App → Sign out of Discord and clear its data on
this PC** closes the Discord window, waits for it to go, then deletes its folder,
`%LOCALAPPDATA%\com.sovereign.chat\discord-profile`, and nothing else. That
folder holds your Discord sign-in, cookies, cache and settings, and the window's
size and place. Turning **Show Discord in the server rail** off offers the same.

What it leaves:

- your Discord account, untouched; you can sign in again later;
- files you downloaded, where you saved them;
- Discord notifications already in Windows' notification centre;
- the sign-in at Discord's end. Deleting the folder signs this PC out, but
  Discord may count that sign-in as open until it expires. To end it, use
  **Log Out** in Discord before clearing, or remove the device under Discord's
  **User Settings → Devices**.

Without Púca, the same is: close the Discord window, wait a few seconds, and
delete that folder. **Log Out** in Discord's own settings signs you out too, but
leaves Discord's cache and settings behind.

## Checking it yourself

In `frontend/src-tauri`:

```bash
cargo test discord
```

That runs the window's rules, the no-injection checks, the real-webview probe
(hidden, on a throwaway profile, a page of the test's own, nothing from the
network) and the capability tests. In `frontend`:

```bash
npx vitest run src/tests/discordWindowEntry.test.tsx
```

That covers the rail entry and these settings, in the full and the Lite build.
