# Voice hotkeys on the desktop

How push-to-talk, push-to-mute, toggle mute, toggle deafen and save-clip
reach the app from inside a game, why they used to fail "about half the
time", and how to prove they work now.

## The pieces

| Where | What |
|---|---|
| `frontend/src-tauri/src/hotkeys.rs` | The native feed. A dedicated **time-critical** thread installs `WH_KEYBOARD_LL` + `WH_MOUSE_LL` hooks and pumps messages. The hook callbacks do microseconds of work (a watch-slot lookup, an edge check against a down-state bitmap, a channel append). Two timers on that thread: a **20 ms key-state poll** and a **60 s hook re-arm**. Two other threads keep everything else off it: the **emitter** (the Tauri `emit`) and the **foreground probe** (once a second; it opens another process and reads its token, which is far too much for the thread Windows times). |
| `frontend/src/api/hotkeys.ts` | The registry. Hold actions (PTT/PTM) and press actions (toggles), fed by the in-app `keydown`/`keyup` listeners and, on the desktop, by the native feed's `global-hotkey` events. |
| `frontend/src/api/hotkeyScope.ts` | Which binds are watched system-wide (the switch, or a bind the user chose). |
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
both hooks are re-installed on the spot (`rearms_on_evidence`) instead of at
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
hooks, not to raw input, not to the key-state table (UIPI). No capture
method works, and no re-arm helps. The hook thread probes the foreground
process once a second, compares integrity levels, and emits
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

## Reading the diagnostics

In DevTools, in a call:

```js
await __pucaHotkeysDebug.snapshot()
```

| Field | Meaning |
|---|---|
| `feed.active` false | the feed was never asked for — check `host.lastComputed.ids` and `hotkeyScope.ts` |
| `native.hook_live` false | `SetWindowsHookExW` refused |
| `native.watching` missing a VK | the bind never reached the native side. A key bound to two actions appears ONCE: one slot per key, or the poll would read the second slot as a press the hook missed |
| `native.events_seen` stuck | the hook receives nothing — is the game elevated? (`native.foreground_blocker`) |
| `native.poll_presses` rising | the hook is being removed under load; the poll covered it |
| `native.poll_releases` rising | key-ups are happening where the hook cannot see them; the poll covered it |
| `native.down_bits` non-zero at rest | a slot believes its key is held — the poll will clear it within 40 ms |
| `native.foreground_blocker` non-empty | the app in front runs elevated; nothing here can see its keys |
| `native.self_injected_bits` non-zero | those slots are held by our OWN remote-control injection; the poll is deliberately blind to them |
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
7. Come back to Púca and run the snapshot. `events_seen` should be well
   above the number of presses (edges, both directions); `poll_releases`
   should be ≥ 1 from step 5; `poll_presses` shows how often the hook was
   dead under load.
8. Now launch the game **as administrator** and alt-tab in. Hotkeys will
   not work — that is Windows, not Púca — and on alt-tabbing back the amber
   banner names the game and stays up while you read it. Close the game, or
   click into any ordinary window, and it clears within a second.
9. If you use My Devices: let someone control this machine and have them
   type the letter your push-to-talk is bound to. Your mic must stay shut,
   and `native.self_injected_bits` must be non-zero while they hold it. Your
   own press of that key must still work while they are connected.

Anything else is a bug: report the snapshot with it.
