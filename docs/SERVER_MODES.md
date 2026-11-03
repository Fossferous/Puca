# Server modes

A **mode** is a named set of channels that the channel list shows only while the
mode is on, with an optional background picture and accent colour. It exists for
the channels a server needs for one thing: a game with a town square and a dozen
private rooms, a weekly event, a season. They are clutter the rest of the time, and
deleting and recreating them loses their permissions and history.

- A channel in no mode is always listed.
- A channel in a mode is listed while that mode is on. A channel can be in several.
- A subchannel goes with its collection, voice or text: tick the collection and all
  of it comes and goes together. A voice channel under a ticked collection is in the
  mode everywhere: hidden with it, warned about, disconnected when it ends, counted by
  Turn off when empty and reached by Call everyone back. This is the usual layout for
  a game's private rooms. Its row stays under Voice Channels, like any other voice
  channel: the collection's own list and feed are for its text channels.
- **One mode is on at a time.** Picking a mode replaces the current one.

The user-facing description is in [USER_GUIDE.md](USER_GUIDE.md#server-modes); the
routes and frames are in [API_REFERENCE.md](API_REFERENCE.md#server-modes). This
file says why it works the way it does.

## Hiding is not access control

A mode tidies the list. Permissions stay the only thing that keeps anybody out, and
nothing in this feature changes one.

A channel a mode hides is still there for everyone allowed to see it:

- it is still in `GET /servers/:id/channels`, and an older client lists it. A channel is
  listed only if its own `mode_ids` and its collection's `parent_mode_ids` each allow the
  mode that is on: an empty list allows any mode, and the AFK channel is exempt;
- a #mention or a notification still opens it, and it can be joined;
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
  reading, the rule Hide Muted Channels already had. A subchannel opened from a mention
  brings back its collection's header and itself, not its siblings; an open collection
  keeps its text subchannels;
- **a voice channel with people in it**: a call nobody can see is not tidy, it is a
  secret. Everyone is disconnected when a mode ends (below), so this only shows for
  someone who rejoined from a mention or an older client, and it shows honestly.

A hidden channel's unread messages stay out of the server rail's bubble, because
nothing in that server's list could clear them. Its own count comes back with the
mode. (A message arriving live can show in the bubble until the next refresh, at most
a minute later: only the server knows every server's modes.) Entering a server opens
the first channel it lists, never a hidden one.

Every other list of channels follows the same rule, so no two disagree: Move to on a
member, the targets for forwarding and for Send to Púca, a collection's merged feed,
All Checklists, the Tasks tab bar, the Púca Notes grid, and the voice channels an
embedding host is given (`docs/EMBEDDING.md`). Two keep their whole view on purpose. A
save of the Tasks tab order puts a hidden tab back in its slot, and Notes' prune still
sees a hidden channel, so a mode switch never reads as the channel having been deleted.
Searching Notes still finds its note, and its reminders still come due.

**A notification still reaches a hidden channel**, on the server you are looking at or
another one. On Android a notification the app posts itself opens the channel when the
list there would have no row for it. One delivered by the native socket while the app
is closed carries only the server (`PushFrames.java`), so it opens the server as it
always has; changing that needs a new APK.

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
their `RoomLeft` carries `reason: "mode_ended"`, to the connections that held the call
and no others, so what they are told follows from what actually happened to them
rather than from a guess at their channel's modes. `ServerModeChanged` goes out first,
which is how the client knows what the mode was called.

A warning is about the mode that was on when it was asked, and so is a menu left open, which
asks nothing at all if that mode's rooms were empty. Frames keep arriving behind an open menu on
every platform, and on the desktop behind the question, which is in the page, so if the mode has
moved by the press or the answer, nothing is switched and the app says so; deleting a mode does
the same. The request names only what to turn on, so the server would otherwise end whichever
mode is on by then. **Call everyone to** a main channel, pressed in a menu left open, is refused
the same way, since its request names only the server: it would move people to the main channel
of the mode that is on by then, under a message naming the old one. A native dialog stops the
page, so on the web and Android the gap while one is being answered is the server's alone and
is left open.

**Someone the room has lost track of goes too.** A LiveKit session whose socket is not
in `voice_<id>` (it died, or the backend has just restarted) has no room entry to find,
so it is cut at LiveKit directly and counted, as a transport change already did. A
socket that sleeps through the switch would otherwise replay itself back into the ended
call when it reconnects, so the sessions that held the call, and those whose socket had
just died in it, are tombstoned for that room: the replay is refused with the same
reason. A deliberate join clears it. What this cannot catch is a mesh call replayed
after a backend restart, since the tombstones are in memory too; that person sits alone
in a listed channel and can hang up.

Deleting the mode that is on is turning it off, so it takes **Switch Modes** as well as
Manage Channels. An edit never disconnects anyone.

## Who can do what

| | |
|---|---|
| Define, edit and delete modes | **Manage Channels**. Assigning a channel to a mode is managing channels |
| Turn a mode on or off | **Switch Modes**, a new permission nobody has by default |
| Delete the mode that is on | Both: it turns the mode off |
| Call everyone back | **Move Members**, with a drag's own rules. Holding only this still gets the selector's menu, while a mode is on and has a main channel to go to |

The owner and administrators can do all of it. Switch Modes is separate so that a
Storyteller role can run a game without being able to delete channels.

The selector is the only control that switches a mode, so its menu is a real one from the
keyboard: the focus goes to its first item, the arrow keys, Home and End walk it, Escape gives
the focus back to the selector and Tab closes it and goes on from there. Opened with a mouse or
a finger the focus goes to the menu and to none of its items, since nothing would show it there
and a stray Enter or Space could turn the mode off. The arrow keys still go in from there. When
that menu closes the focus goes to nothing, not back to the selector, where the same stray keys
would open it again with Off under the focus.

**It is bit 31, the last one JavaScript's 32-bit operators reach,** and they read it
as the sign. `mask | bit` on a role holding it comes out negative, in this client
(which masks it with `unsignedMask`) and in every older client's role editor, which
sends the whole mask back on any edit. So `known_bits` in `src/role_handlers.rs`
stores what such a number means: the low 32 bits, positive. The next permission bit
needs a different plan on the client, such as BigInt.

An editor who does not hold Switch Modes can neither grant nor remove it, the same
carve-out as the restricting bits. Nobody holds it by default, so without that a
manager recolouring a Storyteller role would take the role's one right away. The role
editor shows the row disabled, with the reason, for such an editor.

A manager sees and edits only the channels they can see. `channel_ids` replaces
those, so a manager's save cannot quietly drop a channel hidden from them, and
`GET /modes` never names one to them, not even as the main channel.

## The AFK channel

An idle member is moved into the AFK channel, so it can't be hidden: the mode editor
refuses it, a channel made AFK leaves its modes, and one under a ticked collection does
not go with it. It can't be a main channel either, because a voice move refuses to take
anyone back out of it: a channel made AFK stops being one.

## What the mode can carry

**A main voice channel** (`home_channel_id`), where the two below go. It is one of
the mode's own channels or one that is always listed. If another mode later takes it
over, nobody could follow, so the client offers no Join and the server refuses Call
everyone back.

**Call everyone back** (in the menu as **Call everyone to** and the main channel's
name) pulls everyone in the mode's voice channels into the main one, for the moment a
game's private rooms are done with. Each person goes through
`perform_voice_move`, the same checks as dragging them, so someone ranked at or above
the caller stays and is counted (`skipped`). The caller's own client walks over.

**The start notice** tells members a mode started, with Join for the main channel.
It is a status line, the activity notice's shape: no sound, no focus taken, no
phone notification, and not for a server you muted or the mode you just switched on
yourself. If you are looking at another server it says which, and offers to open it.

**Turn off when empty** (`auto_off`, on by default per mode) turns the mode off once
its voice channels and its main channel, which may be an always-listed one, have been
empty for 30 minutes. A once-a-minute tick in `main.rs` stamps
`active_mode_occupied_at` while someone is there, and joining stamps it too, so a visit
shorter than a tick counts. Only a mode someone has been in can time out: turning one
on is often the first thing that happens. Voice rooms live in memory, so a restart
reads as everyone leaving; it starts the window again instead. It writes an audit row
with no actor.

"Someone there" means a person. A LiveKit session with no room entry is somebody (the
room only lost track of them). A stream-only account is not, because it can sit there
unattended (`docs/STREAM_ONLY.md`), though a switch still disconnects it. The stamp
keeps moving while the option is off, and ticking the option again starts a fresh 30
minutes: the room may have emptied long ago.

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

**The picture is tone-mapped on the reader's device, not veiled.** A flat veil holds
text to AA by dimming the whole picture as far as its brightest part needs, and it
greys everything: one bright moon took a night scene to an 88% veil. So `mapPicture`
decodes the stored picture, works on at most 1600 px of it, and answers a new picture for
this reader's theme (`planTone` and `toneMap` in `api/serverModes.ts`):

- **On a dark theme** nothing may be brighter than `PICTURE_CEILING`, a WCAG luminance
  of 0.125. The picture is exposed so that its 75th percentile lands well under that,
  and whatever is still too bright rolls off towards the ceiling without reaching it. Each
  pixel is scaled in linear light, so it keeps its hue and saturation. A very dark picture
  may be brightened by up to half. A moon is in the top quarter, so it costs only the moon.
- **On a light theme** nothing may be darker than `PICTURE_FLOOR`, a luminance of 0.3. A
  dark picture is stretched up (shapes in a night sky would otherwise merge), and what is
  still too dark gains light by mixing towards white, which keeps its hue and gives up
  only the saturation that takes.

**AA is not the whole of reading.** It asks about the worst pixel, and says nothing of detail
the size of the words, which competes with them: over confetti the text passed at 4.7:1 and was
still work to read. So the mapped picture's busyness is measured too, as the spread of lightness
in a patch of about a word by a line, in the busiest quarter (`measureDetail`). A sky, a moon or
a landscape is left as it is, down to the byte. A busy picture has its fine detail's lightness
brought towards the mean around it until it reaches `DETAIL_TARGET`, keeping at least
`DETAIL_KEEP_MIN` of it (`softenDetail`). Colour is not touched, and shapes larger than a word
are not either. The text's shadow is a tight dark halo with a soft one around it (light on a
light theme); the check above does not count it. A shadow has its own colour, so an unrevealed
spoiler resets it (its letters are transparent and the halo would draw them), and so does the
composer's autocomplete list, a solid surface of its own. A button takes none from the browser.

The bound holds every pixel by construction, so what is left to measure is what the
browser does afterwards. The result is stored as a JPEG, which rings a little at hard edges
and moves colour around, and it is scaled to the window. That costs up to about 0.03 of
luminance at the sharpest edges.

**A picture has to carry the weakest text on the screen, so the text moves too.** While a
picture shows, `.chat-main` sets its own text colours (`pictureTextColours`): each keeps its
hue and goes only as far as it must to hold 5.3:1 over the worst pixel the curve allows, 6:1
for message text and headings. That 5.3 is what absorbs the JPEG. On a dark theme this makes
secondary text nearly white and message text white, which is what readability forced: with the
theme's own `--text-muted`, a picture could never be brighter than a luminance of about 0.03.
Links keep their hue and get paler. The rest of the window keeps the theme's colours.

Text the app writes in the brand colour (a link, a name with no role colour, who a reply
answers) takes a reading colour made from it (`--mode-brand-text`), because an accent is chosen
to carry a white label: over a picture it measured 1.28:1. `@everyone` reads in the warning
colour that holds, and Light's darkened amber and red on the not-encrypted tag give way to it. A
file's chip, whose colours for saved and failed are fixed, gets a surface of its own.

Everything translucent over the picture leans away from the text, so that it can only add
contrast: the composer (`--mode-composer-bg`, the theme's surface at 55%, so the picture runs
behind it; the header was already clear), hover and selection (`--bg-modifier-*`), and a row
that mentions you (`--mode-mention-bg`). Measured, amoled's own selection grey over a moon
leaves 3.64:1, and the usual gold of a mention 4.05:1. A soft halo on the text (`text-shadow`)
is extra margin and is not counted in any measurement. A name's role colour gets the same
treatment as the theme's colours (`pictureRoleColour`), so it keeps its hue and moves only as
far as it must.

**Readability is measured on what is rendered.** `e2e/modes-look-real-browser.mjs` (a gate)
reads a screenshot of each picture as CSS draws it and compares every text colour with every
pixel: six pictures, eight themes, two sizes. Its tightest case is 4.71:1. A too-strong curve,
the old veil at the most it could show, and the theme's own text colours are its negative
controls, and each fails. `e2e/modes-walk.mjs` does the same for each run of real text in
the real app, against only the pixels behind that text.

**It is a `data:` URL, not an object URL**, because it stays up as long as the mode is on
screen and a long-lived Blob is what keeps decrypted attachments on disk (`api/authedMedia.ts`).
So there is nothing to revoke. Every shell's policy allows `img-src data:`, and the gate renders
it under all five. It costs a decode, 5.5 MiB of pixels for a moment, and 750 KiB of text kept
while it shows: 100 ms on a desktop and about 540 ms at a 6x CPU throttle, once per mode
and theme, in bands so the page keeps breathing. Changing theme maps it again, and until that
finishes there is no picture, since the old mapping is unreadable on the new theme. A
picture that cannot be read gives no picture.

A mode never changes anyone's theme. `settingsStore`'s `applyTheme` is the only writer of
`data-theme`, and nothing in the app follows the time of day or the system's light or dark
setting; a test holds that.

### Accent colour

One `#rrggbb`, and `accentTokens` adapts it per reader: the chosen hue and saturation,
at the nearest lightness where a white button label is at 4.5:1 and the colour is at
3:1 on the theme's surfaces. It is set on the document while the mode's server is on
screen, not behind Friends, Devices or Notes, so menus and dialogs portaled to `<body>`
take it too. Dark themes and light themes can leave it looking a little different, and
that is what makes it readable on both.

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
  channel. Its rail bubble does leave out a hidden channel's unread messages, though it
  lists the channel: the server cannot tell which client asks. That lasts until it
  updates, and the channel's own count still shows once the server is open.
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
- `frontend/src/tests/chatModeQuestion.test.tsx`: a switch or a delete answered after the mode moved, through
  the real Chat and the real in-page question. `modeLookRetry.test.tsx`: a picture that failed to download.
- `frontend/e2e/user-menu-move-to-real-browser.mjs`: the selector's menu from real keys, with a right click's
  as the negative control, and at 390x844.
- `frontend/e2e/modes-walk.mjs`: the whole story live through a real backend, two
  accounts, a 1280x800 desktop and a 390x844 coarse-pointer phone, all eight themes with
  and without high contrast. With a loopback LiveKit (header of the file) it also runs on
  channels with `sfu_mode` on and asks LiveKit's `ListParticipants` who is in each
  `sfu_<id>` room: a switch takes everyone out, including a client that ignores being told
  and a session whose socket died; a channel shared with the next mode keeps the same
  session; Call everyone back moves them; the auto-off counts a person in a call and a
  session with no room entry, and not a stream-only account.
- `frontend/e2e/modes-look-real-browser.mjs`: the tone curve in a real browser (see *The
  look*), with no server, so it is one of the gates.
