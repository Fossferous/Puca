# Server modes

A **mode** is a named set of channels that the channel list shows only while the
mode is on, with an optional background picture and accent colour. It exists for
the channels a server needs for one thing: a game with a town square and a dozen
private rooms, a weekly event, a season. They are clutter the rest of the time, and
deleting and recreating them loses their permissions and history.

- A channel in no mode is always listed.
- A channel in a mode is listed while that mode is on. A channel can be in several.
- A subchannel goes with its collection: tick the collection and all of it comes and
  goes together.
- **One mode is on at a time.** Picking a mode replaces the current one.

The user-facing description is in [USER_GUIDE.md](USER_GUIDE.md#server-modes); the
routes and frames are in [API_REFERENCE.md](API_REFERENCE.md#server-modes). This
file says why it works the way it does.

## Hiding is not access control

A mode tidies the list. Permissions stay the only thing that keeps anybody out, and
nothing in this feature changes one.

A channel a mode hides is still there for everyone allowed to see it:

- it is still in `GET /servers/:id/channels`, with `mode_ids` saying why a client
  should not list it, and an older client lists it;
- a #mention, a notification or a link still opens it, and it can be joined;
- its messages are kept, its keys are untouched, and it comes back with the mode.

The opposite design was considered and refused. Making the switch deny
`VIEW_CHANNEL` would make older clients obey too, but `broadcast_perms_changed_and_evict`
bumps `servers.member_generation`, so **every channel on the server would rotate its
key on every switch**, and a permission a person set by hand would have to be
remembered and restored. A second gate on join and send ("hidden means refused") was
refused too: "why can't I get in?" would then have two answers.

So the settings screen says this in as many words, and the client never presents a
hidden channel as protected.

### Exceptions to hiding

The list keeps a hidden channel in two cases (`listedNow` in
`frontend/src/api/serverModes.ts`):

- **what you have open**, until you leave it: a list must not lose what you are
  reading, the rule Hide Muted Channels already had;
- **a voice channel with people in it**: a call nobody can see is not tidy, it is a
  secret. Everyone is disconnected when a mode ends (below), so this only shows for
  someone who rejoined from a link or an older client, and it shows honestly.

A hidden channel's unread messages stay out of the server rail's bubble, because
nothing in that server's list could clear them. Its own count comes back with the
mode. (A message arriving live can show in the bubble until the next refresh, at most
a minute later: only the server knows every server's modes.) Entering a server opens
the first channel it lists, never a hidden one.

## Turning a mode off ends its calls

The owner's decision: when a switch hides a voice channel, the server disconnects
everyone in it. A channel the old and the new mode share keeps its call. Text
channels are not touched.

This is the one thing the server itself does to a hidden channel, and it is a
disconnect, not a lock: nothing refuses a later join. It is not rank-checked,
because it is what the switch means rather than an action on a person, so anyone
with **Switch Modes** can end a call the owner is in, by turning the mode off, even
one in a channel hidden from them. They are told only how many they could see: a
room hidden from someone must read like no call at all. The audit log, which only
administrators read, has the whole count.

Whoever presses the switch is warned how many people it will cut off first. The
people cut off are told why ("Blood on the Clocktower ended, so this call ended"):
the `ServerModeChanged` frame goes out before the disconnects for that reason, and
because a client that hears `RoomLeft` first has nothing to say about it.

Deleting the mode that is on is turning it off. An edit never disconnects anyone.

## Who can do what

| | |
|---|---|
| Define, edit and delete modes | **Manage Channels**. Assigning a channel to a mode is managing channels |
| Turn a mode on or off | **Switch Modes**, a new permission nobody has by default |
| Call everyone back | **Move Members**, with a drag's own rules |

The owner and administrators can do all of it. Switch Modes is separate so that a
Storyteller role can run a game without being able to delete channels.

**It is bit 31, the last one JavaScript's 32-bit operators reach,** and they read it
as the sign. `mask | bit` on a role holding it comes out negative, in this client
(which masks it with `unsignedMask`) and in every older client's role editor, which
sends the whole mask back on any edit. So `known_bits` in `src/role_handlers.rs`
stores what such a number means: the low 32 bits, positive. The next permission bit
needs a different plan on the client, such as BigInt.

An editor who does not hold Switch Modes can neither grant nor remove it, the same
carve-out as the restricting bits. Nobody holds it by default, so without that a
manager recolouring a Storyteller role would take the role's one right away.

A manager sees and edits only the channels they can see. `channel_ids` replaces
those, so a manager's save cannot quietly drop a channel hidden from them, and
`GET /modes` never names one to them, not even as the main channel.

## The AFK channel

An idle member is moved into the AFK channel, so it can't be hidden: the mode editor
refuses it, and a channel made AFK leaves its modes.

## What the mode can carry

**A main voice channel** (`home_channel_id`), where the two below go. It is one of
the mode's own channels or one that is always listed. If another mode later takes it
over, nobody could follow, so the client offers no Join and the server refuses Call
everyone back.

**Call everyone back** pulls everyone in the mode's voice channels into the main
one, for the moment a game's private rooms are done with. Each person goes through
`perform_voice_move`, the same checks as dragging them, so someone ranked at or above
the caller stays and is counted (`skipped`). The caller's own client walks over.

**The start notice** tells members a mode started, with Join for the main channel.
It is a status line, the activity notice's shape: no sound, no focus taken, no
phone notification, and not for a server you muted or the mode you just switched on
yourself. If you are looking at another server it says which, and offers to open it.

**Turn off when empty** (`auto_off`, on by default per mode) turns the mode off once
its voice channels and its main channel, which may be an always-listed one, have been
empty for 30 minutes. A once-a-minute tick in `main.rs` stamps
`active_mode_occupied_at` while someone is there, and only a mode someone has been in
can time out: turning one on is often the first thing that happens. Voice rooms live
in memory, so a restart reads as everyone leaving; it starts the window again instead.
It writes an audit row with no actor.

## The look

### Background

**A plain server asset, like the server icon**, not end-to-end encrypted: whoever
runs the server can see it, and the settings screen says so. Sealing it would need
the key of one of the mode's channels, so anyone without that key (a new member,
until someone online hands it over) would get no background, for a picture that is
rarely secret. It is uploaded through `uploadFile` like every picture stored in the
clear, and every place that guards `servers.icon_file_id` guards
`server_modes.background_file_id` too: who may fetch it, the in-use refusal, a
deleted account's purge. Replacing it reclaims the old file, caller-scoped, and only
if nothing else points at it.

`prepareBackground` makes it at most 1920 px on the long edge and a flat JPEG, so
every member, phones included, downloads something bearable (4 MiB is the server's
cap for a request that skipped the client). A GIF is refused rather than flattened:
whoever chose it expects it to move, and an animated background is hostile to anyone
photosensitive.

It is a CSS background on `.chat-main` rather than a layer inside it, because a
positioned child would need `position: relative` on an element whose containing block
the message toolbar and pickers depend on.

**Readability is measured, not assumed.** A theme-coloured veil lies over the picture,
and `scrimAlpha` makes it exactly as opaque as this picture needs on this theme:
`measureExtremes` finds the picture's darkest and lightest points from a 32x32
reduction, and the veil is the least (from 60%) that keeps `--text-normal`,
`--text-muted` and `--text-link` at 4.5:1 against both. A colour already below that on
its own theme (the light theme's links are 2.6:1 on plain white) may lose at most a
tenth of what it has: no veil can lift it, and only hiding the picture would keep
every last bit. So a dark picture shows far more on a dark theme than a bright one
does. A picture that cannot be measured is treated as pure black and white.

### Accent colour

One `#rrggbb`, and `accentTokens` adapts it per reader: the chosen hue and saturation,
at the nearest lightness where a white button label is at 4.5:1 and the colour is at
3:1 on the theme's surfaces. It is set on the document while the mode's server is on
screen, so menus and dialogs portaled to `<body>` take it too. Dark themes and light
themes can leave it looking a little different, and that is what makes it readable on
both.

### Declining it

Someone else's picture behind your messages is yours to decline. **High Contrast**
hides the look outright, and **Server Backgrounds and Colours** in Settings turns it
off for anyone. Neither changes which channels are listed.

## Old clients and old servers

Clients ship before the backend, so all four combinations have to make sense:

- **An old client on a new server** lists every channel, as it does today. The new
  frames reach it and it drops them, as it drops every frame type it does not know. It
  cannot define or switch modes. If someone in a hidden voice channel is on one, they
  are disconnected like anyone else, and can walk back in because their list shows the
  channel.
- **A new client on an old server** sees no `active_mode_id` on the server row (absent,
  not null), so it never asks for modes and shows no selector or tab.
- **Rolling the server back**: the migration is additive, and an older binary ignores
  the tables and a permission bit it does not know.

## Not built, on purpose

- **Scheduling.** Game nights are rarely at fixed times, and it needs time-zone UI.
- **A role granted while a mode runs.** It would turn a display switch into a
  permission change, and every role change makes channel keys rotate.
- **Swapping the server icon.** The background and accent already say what is on.
- **Several modes at once.** Only one could set the background, so it would need a rule
  for which wins. Nothing in the schema prevents it later except `active_mode_id` being
  one column, which is the point for now.

## Proof

- `src/mode_handlers_tests.rs`: permissions, who is disconnected and in what order, a
  dropped request, hidden channels unnamed and surviving a save, the file guards, Call
  everyone back's rank rule, the auto-off, the rail. Needs `TEST_DATABASE_URL`.
- `frontend/src/tests/serverModes.test.ts`: the rules, and the colour arithmetic on the
  eight themes as read from `styles/theme.css`, with negative controls.
- `frontend/src/tests/modesUi.test.tsx`: the selector, its menu, the notice, the settings
  tab, the role editor's positive masks, the personal switch.
- `frontend/e2e/modes-walk.mjs`: the whole story live through a real backend, two
  accounts, a 1280x800 desktop and a 390x844 coarse-pointer phone, all eight themes with
  and without high contrast.
