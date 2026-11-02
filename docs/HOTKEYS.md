# Voice hotkeys on the desktop

How push-to-talk, push-to-mute, toggle mute, toggle deafen and save-clip
reach the app from inside a game, why they used to fail "about half the
time", and how to prove they work now.

## The pieces

| Where | What |
|---|---|
| `frontend/src-tauri/src/hotkeys.rs` | The native feed. A dedicated **time-critical** thread installs a `WH_KEYBOARD_LL` hook — plus a `WH_MOUSE_LL` hook **only while a mouse button is bound** (every mouse event on the machine waits on a mouse hook, so none is installed that nothing reads; a rebind mid-call adds or removes it in place on that thread) — and pumps messages. The hook callbacks do microseconds of work (a watch-slot lookup, an edge check against a down-state bitmap, a channel append). Two timers on that thread: a **20 ms key-state poll** and a **60 s hook re-arm**. Two other threads keep everything else off it: the **emitter** (the Tauri `emit`, every log line the hook thread has to write, and a look at the foreground for each release the poll supplied) and the **foreground probe** (once a second; it opens another process and reads its token, which is far too much for the thread Windows times). |
| `frontend/src/api/hotkeys.ts` | The registry. Hold actions (PTT/PTM) and press actions (toggles), fed by the in-app `keydown`/`keyup` listeners and, on the desktop, by the native feed's `global-hotkey` events. |
| `frontend/src/api/hotkeyScope.ts` | Which binds are watched system-wide (the switch, or a bind the user chose). |
| `frontend/src/api/hotkeyReport.ts` | The `--- voice hotkeys ---` section of **Send diagnostics** and **Copy diagnostics**. |
| `frontend/src/components/VoicePanel.tsx` | Arms the feed while in a call; re-syncs on every settings save. |
| `frontend/src/components/HotkeyBlockedBanner.tsx` | "Voice hotkeys can't reach *game*" when the window in front runs elevated. |

## Two sources, one edge detector

Windows **silently removes** a low-level hook whose callback misses its
latency budget (`LowLevelHooksTimeout`). There is no error, no event, and
`hook_live` stays true. That budget is wall time, so a game plus the encoder
saturating the CPU is exactly the condition — and a hook also never sees a
key released somewhere it cannot look (a UAC prompt, an elevated game).

Either way the slot's DOWN bit stays set. That has two effects, and the
second is the one people reported: push-to-talk stays open, and because a
set bit swallows the next key-down as auto-repeat, **the next press is
eaten too**. One lost key-up costs the current hold and the next press.

So the hook thread also **polls `GetAsyncKeyState` for every watched key
every 20 ms** and feeds the same edge detector. The hook still gives edges
with no latency; the poll guarantees the truth catches up. A disagreement
must hold for **two consecutive ticks** (~40 ms) before the poll wins,
because the key-state table and the hook are updated by different threads
and one tick can read the old state a few microseconds after the hook
reported the new one. Both timers live on the hook thread, so the hook
callback and the poll never run at the same time and share the bitmap
without a lock.

What that buys: a lost release costs ~40 ms of extra mic instead of the rest
of the call; a removed hook degrades to 20 ms polling latency instead of to
nothing. And a **press** the poll had to supply is proof the hook is gone —
a live hook reports a key-down before the key-state table even updates — so
the hooks (the mouse hook only while a mouse button is bound) are
re-installed on the spot (`rearms_on_evidence`) instead of at
the next 60 s tick. `poll_presses` / `poll_releases` count how often the
poll had to step in.

**Modifiers** come from the hook's own stream OR-ed with the key-state
table. Microsoft documents that a low-level hook runs before the table is
updated for the key it reports, so a Ctrl pressed in the same burst as the M
of a Ctrl+M toggle could read "up" at emit time and the toggle failed its own
modifiers. The hook has already seen Ctrl's down edge; the poll clears the
bit if the table says the modifier was released, so it cannot stick.

**The feed lives as long as the call.** It used to be torn down and rebuilt
by the React effect that recomputes the watch list — which re-runs when the
clip buffer arms, i.e. when a game goes fullscreen, mid-call — releasing a
held push-to-talk and losing the key's eventual release. A rebind or an
input-mode change now swaps the watch list in place.

With "swap mouse buttons" on, VK 1 and 2 are left to the hook alone: the
poll reads *physical* buttons, the hook *logical* ones, and they would
disagree forever.

## A save while a key is held

A save can change the watch list while a key is down, without anyone touching
that key. `computeNativeWatch` builds the list in order (Toggle Mute, Toggle
Deafen, then push-to-talk or push-to-mute, then save-clip), so turning on **Use
Mute and Deafen from other apps**, or **Reset** on Toggle Mute, moves the
push-to-talk key to another slot. A save that leaves the list as it was, which
is most of them (a slider drag saves on every tick), touches nothing.

**A set DOWN bit is a release the page is owed.** The rewrite used to clear the
bit of every slot that changed and send nothing. The page still held the key,
the key-up then read as "up, and already up" and was dropped, and the poll agreed
with that, so the person stayed muted or live until their next press. It took a
release within about 40 ms of the save: any later and the poll had put the bit
back by supplying a press, which was also read as proof of a dead hook and
re-armed for nothing. What happens now, while a key is held:

| A save that... | Does this |
|---|---|
| moves the key to another slot | its down bit and its injection mask move with it (`rewrite_watch`). No edge is sent, and its release arrives as usual |
| stops watching the key | the native side sends its release on the spot (`native.releases_on_rewrite`), because no later edge can come for it. The page honours a release for an action the feed no longer covers: that list stops a global key *starting* an action, and a release starts nothing |
| moves the binding to another key, or clears it | the page ends the hold at the save. **Reset** and the trash button do not go through capture, and with the binding cleared nothing else could ever have ended it |
| changes only the binding's modifiers | nothing: the same key still has to come up |

A hold ends when the key that **started** it comes up, so a release is matched
against that key and not against the binding as it is by then. Capture still
releases every hold when it starts, because dispatch is suspended from there on.

Two more ways a feed can change under a held key, both handled by the page: a
re-registration that **fails** while the feed is live releases what was held (no
native key-up can come now, and the blur that would have released it already
happened), and a **stop** releases it too. `stop()` in `hotkeys.rs` clears its
bits and sends nothing, relying on exactly that.

## The key that ends a capture

Capture in the Keybinds tab ends when the bind is saved, and that save starts
watching the key, which is still down: a press normally lasts longer than the
~40 ms the poll takes to notice a watched key that is down. The same keystroke
then reached the page as a press the hook missed, with capture already over.
Rebinding **Toggle Mute** while muted unmuted you.

The native side cannot tell. It must not try either: a key that joins the list
while someone really is holding it should reach the page, which is why a rewrite
gives a newly watched key no down bit. So the page keeps it: the modal marks the
key spent before it saves (`markKeySpentByCapture`), and the native feed's press
for a spent key runs nothing.

| What ends it | Why |
|---|---|
| the native key-up | that channel is ordered, so nothing of this keystroke can follow it |
| the in-app key-up, plus 150 ms | not ordered against the native feed: the poll's press can already be on its way |
| a first press in the window (not a repeat) | a new keystroke, whatever became of the last one's key-up |
| 5 s | only for a key-up nobody heard. A longer hold is fine: the poll's press comes once, early on |

Bare **Esc**, which cancels a capture, is marked the same way. A combination the
capture refused as already taken is not: nothing was saved, and capture goes on.

## The poll must never see our own injections

The hooks ignore input stamped `PUCA_INJECT_TAG` — every `SendInput` the
remote-control agent makes — so a controller typing on the host can never
trigger the host's own bindings. `GetAsyncKeyState` has no such notion:
injected input updates the key-state table exactly like a finger. A poll
that trusted it would hand a remote controller the host's microphone, by
the same mechanism the hooks exist to refuse.

So a tagged edge does not just get dropped: it **masks** its watch slot
(`self_injected_bits`), and the poll is blind to that slot until the table
says the key is up again. Two consequences worth stating, because both are
tested with positive controls:

- A **physical** press during an injected hold still works. It arrives
  through the hook, which is not masked, only the poll is.
- The mask cannot stick. It lifts on the tagged release, and also whenever
  the key reads up — so a hook that dies mid-injection cannot leave the
  user's own key dead.

## Ownership while the feed is live

The hook sees every transition of a watched key — including the ones typed
into Púca's own window. So while the native feed is live:

- **Modifier matching follows who is in front.** With another window in
  front the press path subset-matches, because a game holds crouch and
  sprint modifiers while you press your toggle. With Púca in front it
  matches exactly, as the in-app listener does: subset matching there would
  fire a bare-`D` action on a `Ctrl+Shift+D` keystroke, running two commands
  from one press. Holds subset-match always.
- **Press actions it covers fire from the native feed only.** The in-app
  listener still swallows the keystroke (`preventDefault`) but does not fire
  the action. One owner, no double toggle, and **no focus test decides
  anything**. The old rule dropped native events whenever
  `document.hasFocus()` was true — the WebView's own bookkeeping, forced
  true under a debugger and not the OS's view of the foreground window.
  Every time it was wrong, every hotkey was dead in the game.
- **Hold actions fire from both feeds**; `held` makes that idempotent, and a
  release is honoured from whichever feed sees it (press in the game,
  release after alt-tabbing back, or the reverse).
- Each native event carries `foreground` (from `GetForegroundWindow`), used
  only for the editable-target rule: with Púca in front and the caret in the
  composer, a plain bound letter is typing, not a command. Ctrl/Alt combos
  fire regardless, exactly as in-app.

## Injected input

The remote-control agent stamps every `INPUT` it sends with
`puca_input::PUCA_INJECT_TAG` in `dwExtraInfo`, and the hooks ignore **only
that**. The old rule skipped everything flagged `LLKHF_INJECTED`, which is
also how a gaming mouse's driver (G HUB, Synapse) delivers a remapped side
button and how AutoHotkey delivers anything — exactly the keys people bind
push-to-talk to, dead in every game profile.

## What cannot be captured, and how the user is told

A process running **above ours in integrity** (a game launched "as
administrator") gets its input routed by Windows to no lower process: not to
hooks, not to raw input, not to the key-state table (UIPI). Only a level that
was actually READ and is higher counts: a process we cannot inspect at all is
reported as unknown, never as elevated, because telling someone to relaunch a
game as administrator when their hotkeys work is worse than saying nothing.
No capture
method works, and no re-arm helps. A dedicated probe thread — never the hook
thread, whose latency Windows measures — checks the foreground process once a
second, compares integrity levels, and emits
`global-hotkey-blocked { process }` on change; the banner names the game and
the two real fixes (run it normally, or run Púca elevated too). Dismissal is
per process.

The answer is **latched while Púca itself is in front**. The only moment the
user can read the banner is after they alt-tab out of the game that caused
it, and a plain change-detector would clear it at exactly that moment — the
banner would only ever have existed underneath a fullscreen game. The latch
releases when an ordinary other window comes to the front, when the blocking
process exits, or when the call ends. `native.foreground_blocker` reports the
latched answer for the same reason: a snapshot is read with Púca in front,
where a fresh probe is empty by definition.

### A key held when such a window comes to the front

With an elevated window in front, or a secure screen (a UAC prompt, the lock
screen, which leave no foreground window to ask about), `GetAsyncKeyState` reads
up for every key, whatever the finger is doing. The poll sees a key it believes is
down reading up, and after its two ticks supplies a release. That release may be
false, and what it does depends on the action:

| Action | What the release does | So |
|---|---|---|
| push-to-talk | closes the microphone | it takes effect at once: closing costs nothing |
| push-to-mute | **opens** the microphone, on someone still holding mute | the hold stays, and the mic stays shut |

The emitter thread decides which case it is, with a fresh probe at the moment it
delivers the release, because the blocker thread's answer is up to a second old
and the table goes blank at once. It marks the edge `blocked`, counts it
(`native.poll_releases_blocked`) and remembers the key as owed
(`native.releases_owed`). `registerHold`'s `keepOnBlockedRelease` is what makes
push-to-mute ignore that edge.

Once a second the blocker thread looks at the owed keys, if the table can be read
again. A key that reads up gets a plain release; a key that reads down, once the
poll has supplied its press, has its release owed by the hook and the poll like any
other. So someone who let go behind the window stays muted until they leave it, by
at most a second past that, and can do nothing about it from inside: no capture
method can see the key. Someone still holding it never opens at all.

## Settling a report of a stuck key

**Send diagnostics** is enough: it carries the report and all of `puca.log`.
**Copy diagnostics** has the report and not the log. **Neither ever holds a key
that is not a bound hotkey**. The hook callbacks see every key on the machine and
write none of it down; the poll reads only watched keys; every key named below came
from the watch list or from the person's own settings. Tests pin each of those
(`rewrite_tests` in `hotkeys.rs`, `src/tests/hotkeyReport.test.ts`).

In `puca.log`:

```
[hotkeys] the poll supplied a release the hook missed: vk=86, poll_releases=3, 2 more since the last line
[hotkeys] the poll supplied a release the hook missed: vk=86, poll_releases=4, 0 more since the last line (an elevated window or a secure screen is in front: every key reads up)
[hotkeys] watch list changed with a key down: still watched vk=[86], released now vk=[77]
[stream-diag] [hotkeys] voice.ptt released: its keybind changed while it was held
[stream-diag] [hotkeys] released what was held: the native feed could not be re-registered
```

The first two say different things: the hook lost a key-up, or a window hid the
key, in which case the second is the one written and it may not have been a release
at all. Each is at most one line every 10 s, says how many of its own kind it held
back, and does not rate-limit the other; `poll_releases` still counts every one. The
key's edge goes out before the line is written, so a stalled disk never delays a
microphone closing. The third appears only when a key was down: the list also
changes whenever the clip buffer arms, and that is not news.

In the report, under `--- voice hotkeys ---`:

| Line | Says |
|---|---|
| `input mode` | what the settings say, and the call's mode too if it differs |
| `other apps` | the **Use Mute and Deafen from other apps** switch |
| `bind` | one per action in the Keybinds tab: the combination and its virtual-key number, or `not set`; Toggle Mute and Toggle Deafen also say why they are or are not system-wide (`hotkeyScope.ts`) |
| `call` | in voice, AFK channel, listen only, speak denied, clip buffer armed |
| `feed` | live or not, the actions it covers, what it was last asked to watch |
| `held now` | the hold actions the page believes are down |
| `in front` | whether an elevated window is hiding keys now, and how many times one has come to the front since the app started: the first clears on a click in any ordinary window and at the end of the call. Not its name: the log has that, from when it happened |
| `presses` | `feed.ownershipDeferrals` and `feed.nativeDispatches` |
| `native` | a fixed list of `hotkey_diag` fields, numbers and yes/no only, so a field added there later reaches a report only if someone adds it to `NATIVE_FIELDS` in `hotkeyReport.ts` |
| `feed log` | the last start and stop calls with their reasons, each with its local time (the clock `puca.log` uses) and how long before the report it was |

Reading it: `held now` names an action while `native` has `down_bits=0` and
`releases_owed=0`, with the key up, means the page is waiting for a release nothing
is going to send, which is a bug. `poll_releases` rising faster than
`poll_releases_blocked`, with `held now` empty, means the hook is losing key-ups and
the poll is covering them, as it should. `poll_releases_blocked` rising is not the
hook: a window was hiding keys. `listen only: yes` with `speak denied: yes` and an
empty feed is the channel's permission (no SPEAK drops every mic hotkey), where
plain listen-only would keep Toggle Mute and Toggle Deafen watched. A `bind` that is
`not set` for the action in `input mode`, or a key missing from `watching`, is a
setup question and not a stuck key.

## Reading the diagnostics

In DevTools, in a call:

```js
await __pucaHotkeysDebug.snapshot()
```

| Field | Meaning |
|---|---|
| `feed.active` false | the feed was never asked for — check `host.lastComputed.ids` and `hotkeyScope.ts` |
| `native.hook_live` false | `SetWindowsHookExW` refused |
| `native.mouse_hook_wanted` true, `native.mouse_hook_live` false | a mouse button is bound but Windows refused the mouse hook: that bind runs on the 20 ms poll only. Both false is the normal keyboard-only case |
| `native.watching` missing a VK | the bind never reached the native side. A key bound to two actions appears ONCE: one slot per key, or the poll would read the second slot as a press the hook missed |
| `native.events_seen` stuck | the hook receives nothing — is the game elevated? (`native.foreground_blocker`) |
| `native.poll_presses` rising | the hook is being removed under load; the poll covered it |
| `native.poll_releases` rising | key-ups are happening where the hook cannot see them; the poll covered it |
| `native.poll_releases_blocked` | of those, how many a window hiding every key produced: maybe not releases at all, see *A key held when such a window comes to the front* |
| `native.releases_owed` non-zero | keys told "up" while the table was blank and still awaiting a real reading. Push-to-mute keeps holding through them |
| `native.down_bits` non-zero at rest | a slot believes its key is held — the poll will clear it within 40 ms |
| `feed.held` names an action while `native.down_bits` and `native.releases_owed` are 0 and the key is up | the page is waiting for a release nothing will send: a bug, see *A save while a key is held* |
| `native.releases_on_rewrite` | releases sent because a save stopped watching a key that was down |
| `native.foreground_blocker` non-empty | the app in front runs elevated; nothing here can see its keys |
| `native.self_injected_bits` non-zero | those slots are held by our OWN remote-control injection; the poll is deliberately blind to them |
| `native.poll_presses_suppressed` rising | presses the poll refused because the remote-control injector was holding a key. Expected during a device session, and zero otherwise |
| `native.foreground_unreadable` true | the foreground process could not be inspected at all (protected, anti-cheat, another user). NOT a blocker: nothing is claimed about it |
| `feed.ownershipDeferrals` climbing while `feed.nativeDispatches` does not | the in-app feed is standing down for a native feed that has gone quiet — the one failure mode the single-owner rule can have |
| `feed.blocker` | the same, as the frontend last heard it (drives the banner) |
| `native.rearms` | re-installs so far (60 s clock plus evidence) |
| `native.rearms_on_evidence` | of those, how many the poll's proof triggered: each one is a hook Windows had removed. Deliberately disarmed for a second around a blocker, where `GetAsyncKeyState` returns 0 for everything and tabbing back looks identical to a missed press |

## Manual test protocol (in a game)

1. Set a push-to-talk bind you chose yourself (a chosen bind is watched
   system-wide; an untouched default is in-app only). Join a voice channel
   with someone who can hear you.
2. Launch the game **normally** (not as administrator). Alt-tab into it.
3. **Hold** PTT for a sentence, release, wait two seconds, hold again. Do
   this twenty times over a few minutes of play, with sprint/crouch
   modifiers held during some of them. Every hold must transmit; every
   release must close the mic within a blink.
4. Press PTT, and **while holding it** alt-tab back to Púca, then release.
   The mic must close. Then the reverse: hold in Púca, alt-tab into the
   game, release there.
5. Trigger a UAC prompt (start any installer) while holding PTT and release
   on the prompt. Within ~40 ms of the prompt appearing the mic closes — the
   poll saw the release the hook could not. Back in the game, the **next**
   press must work (this is the case that used to eat it).
6. Toggle mute with its bind from inside the game, ten times. It must
   alternate every time — never skip, never double.
7. With Púca's **Settings → Keybinds** open, hold PTT and with the other hand
   flip **Use Mute and Deafen from other apps**, letting go of PTT straight away.
   The mic must close. Then hold PTT and press **the trash button** on its own
   bind: the mic closes the moment you press it, key still down. The log has a
   `[hotkeys] watch list changed with a key down` line for the first and a
   `released: its keybind changed` line for the second.
8. In a call and muted, open **Settings → Keybinds**, click **Toggle Mute** and
   press a new key for a normal length of time. You must still be muted, and the
   next press of that key must unmute you.
9. Come back to Púca and run the snapshot. `events_seen` should be well
   above the number of presses (edges, both directions); `poll_releases`
   should be ≥ 1 from step 5; `poll_presses` shows how often the hook was
   dead under load.
10. Now launch the game **as administrator** and alt-tab in. Hotkeys will
    not work — that is Windows, not Púca — and on alt-tabbing back the amber
    banner names the game and stays up while you read it. Close the game, or
    click into any ordinary window, and it clears within a second.
11. In push-to-mute, hold the key and alt-tab into that game, still holding it.
    The mic must stay shut. Come back still holding: still shut, until you let go.
    Do it again, letting go inside the game: the mic stays shut until you are
    back, then opens within a second. `poll_releases_blocked` rises, and the log
    line ends `every key reads up)`.
12. If you use My Devices: let someone control this machine and have them
    type the letter your push-to-talk is bound to. Your mic must stay shut,
    and `native.self_injected_bits` must be non-zero while they hold it. Your
    own press of that key must still work while they are connected.

Anything else is a bug: send diagnostics with it, or report the snapshot.
