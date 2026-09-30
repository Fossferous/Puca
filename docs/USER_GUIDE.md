# Púca User Guide

This guide names buttons by the label or tooltip the app actually shows.
Hover a control to see its tooltip; if a name here does not match what you
see, the guide is wrong — please report it.

---

## Getting Started

### Creating an Account
1. Open the Púca app, or your server's web address in a browser
2. Click **Don't have an account? Register**
3. Enter a username and password. If the server requires an invite code, an
   **Invite code** field appears — ask whoever runs the server for one
4. Click **Create Account**
5. **Save your recovery code.** The app now shows twelve words, once. They are
   the only way to reset a forgotten password *without losing your encrypted
   messages*, and nobody — not even the server — can recover them for you.
   Write them down or use **Copy to clipboard**, tick **I've written down or
   saved my recovery code**, then click **Done**. You can generate a new code
   later in **Settings → My Account**, which retires the old one.

### Forgot your password?
On the sign-in screen, click **Forgot your password? Use your recovery code**:
enter your username, the twelve words, and a new password. Your keys and
history are kept. Without the code, see
[`LOST_RECOVERY_CODE.md`](LOST_RECOVERY_CODE.md) — an email reset (if the
server has email set up) gets you back in but does not recover old messages.

### Interface Overview
Left to right on a desktop window:

| Area | What it holds |
|------|---------------|
| Server rail | A strip of round icons. **Direct Messages** is pinned at the top; below it, one icon per server you belong to; at the bottom, **Join a Server** and **Create a Server** |
| Channel list | The server name with a **Server Settings** button, then text and voice channels; your name and avatar are in the bar at the bottom |
| Chat area | Messages, the pinned-messages button, and the message box |
| Member list | Everyone on the server. A crown marks the **Server Owner** |

On a phone the same areas are tabs along the bottom (**Chat**, **Members**, …).

---

## Servers

### Create a Server
1. Click **Create a Server** at the bottom of the server rail
2. Pick a template (or skip the questions)
3. Under **SERVER NAME**, enter a name; optionally click **UPLOAD** to set an icon
4. Click **Create**

### Join a Server
1. Click **Join a Server** at the bottom of the server rail
2. On the **Have an Invite** tab, paste the invite link or bare code and click **Look Up Invite**, then **Join Server**
3. Or use the **Discover** tab to browse servers listed in the public directory

### Server Settings
1. Click **Server Settings** (the cog beside the server name at the top of the channel list)
2. **Overview** holds the server name, description and icon (**Change**). Only the owner can edit them
3. Click **Save Changes**

The same dialog has **Roles**, **Emoji**, **Invites** and, for the owner, **Moderation** tabs.

### Server menu
Right-click a server icon in the rail for **Mark as Read**, **Invite People**,
**Mute Server**, **Notification Settings**, **Hide Muted Channels**,
**Server Settings**, **Edit Server Profile** (your nickname on that server),
**Leave Server** and **Copy Server ID**. The owner sees **Disband Server**
instead of Leave.

---

## Messaging

### Send a Message
- Type in the message box and press **Enter**
- **Shift+Enter** inserts a new line

### Format Text
| Syntax | Result |
|--------|--------|
| `**bold**` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `__underline__` | underlined |
| `~~strike~~` | ~~strike~~ |
| `` `code` `` | `code` |
| ```` ``` ```` on its own lines | code block |
| `> quote` | block quote |
| `\|\|spoiler\|\|` | Blurred until clicked |
| `[text](https://example.com)` | a link that reads *text* |

### Mention Users and Channels
- Type `@` and pick from the **MEMBERS** list that appears
- Type `#` and pick from the **CHANNELS** list
- `@everyone` and `@here` are highlighted as mentions

### Links
- Click a web address in a message (or a link preview under it) to open it. In the desktop app and the Android app it opens in your web browser; in the browser it opens in a new tab
- A plain email address is not a link. Write it as `[text](mailto:someone@example.com)` and clicking it opens your mail app
- An **invite link to this server** opens Púca's own **Join a Server** screen instead, with the invite already looked up — see [Use an Invite](#use-an-invite). An invite link to any other site opens in your browser like any other link
- In the Android app, a link to `https://localhost` (any path or port) other than an invite is not opened: on the phone that is the app's own address, and following it would restart Púca, so Púca says why instead

### Message actions
Hover a message to see its toolbar. The tooltips are:

| Tooltip | What it does | Who sees it |
|---------|--------------|-------------|
| **Add Reaction** | Opens the emoji picker for a reaction | everyone |
| **Reply** | Replies to the message; your reply shows which one it answers | everyone |
| **Quote** | Copies the message text into the message box as a `> quote` for you to add to | everyone |
| **Forward** | Sends the text to another channel or DM | everyone |
| **Edit** | Opens an **Edit message:** prompt | your own messages |
| **Pin Message** | Pins it; the **Pinned messages** button in the chat header lists pins | moderators |
| **Delete for me (hides it only for you)** | Hides the message on your devices only | everyone |
| **Delete for everyone** | Removes it for all members, after a confirmation | your own messages, and moderators |

That is the toolbar in a server channel. In a direct message it has only
**Add Reaction**, **Quote**, **Forward** and **Delete for me (hides it only
for you)** — there is no Reply, Edit, Pin Message or Delete for everyone in a
DM.

### Attach Files
1. Click **Attach file** (the paperclip beside the message box)
2. Select one or more files. Each appears as a chip above the box while it uploads; a chip has **Mark as spoiler** and **Remove** buttons
3. Press **Enter** to send. The send button waits until every upload has finished

### Paste Images
1. Copy an image (or a file) to the clipboard
2. **Ctrl+V** in the message box — it becomes a chip, the same as an attached file
3. Press **Enter** to send

---

## Reactions

### Add a Reaction
1. Hover over any message
2. Click **Add Reaction** in the hover toolbar (the same button sits at the end of an existing reaction row)
3. Pick an emoji from the picker, or search with **Search emojis...**

### React with Custom Emojis
- This server's custom emojis appear in a row above the standard picker
- Hover one to see its `:name:`; click it to react

### Remove a Reaction
- Click your existing reaction under the message to toggle it off

---

## Voice Chat

### Join Voice
1. Click a voice channel in the channel list
2. Allow microphone access when the browser or app asks
3. You are connected. Clicking the channel again opens the voice view; it never disconnects you
4. If a warning appears instead, the app did not connect you — read it, then press **Join Voice** if you still want to join

A channel's **Speak** and **Connect** permissions (see
[Channel permissions](#channel-permissions-manage-channels)) change what
happens:

- **Without Speak** you still join, listen-only: you hear everyone, nobody
  hears you, and the app does not ask for microphone access. The panel reads
  **Voice Connected · can't speak**.
- **Without Connect** you cannot join. The panel says
  **You don't have permission to join this voice channel.**

### Voice Controls
The voice panel's buttons, by tooltip:

| Tooltip | Action |
|---------|--------|
| **Mute** / **Unmute** | Stop or resume sending your microphone. Reads **Push to talk — hold your key to speak** in push-to-talk mode, **No microphone detected — listen-only mode** if there is none, and **You don't have permission to speak in this channel** if you do not have the Speak permission there |
| **Deafen** / **Undeafen** | Stop hearing everyone, which also mutes you |
| **Noise suppression** | A picker, not a button: choose the microphone filter — **No suppression**, **Standard** or **RNNoise (ML)**. **DeepFilter (Max)** is listed too once **DeepFilterNet noise suppression** is ticked under **Settings → Advanced** |
| **Turn On Camera** / **Turn Off Camera** | Share your webcam |
| **Share Screen** / **Stop Sharing** | See [Screen Sharing](#screen-sharing) |
| **Disconnect** | Leave voice |

On a phone the less-used buttons sit behind **More voice controls**.

Without the Speak permission the panel's status line reads
**Voice Connected · can't speak** instead of **Voice Connected**, and the
microphone stays closed for the whole call. If Speak is taken away while you
are in the call, your microphone is closed at once and the status line
changes. If it is given back, the panel says
**You can speak in this channel now. Leave and rejoin it to use your microphone.**
The microphone is not reopened mid-call; disconnect and join the channel again.

### Mute vs Deafen
- **Mute**: others cannot hear you; you still hear them
- **Deafen**: you hear nothing AND are muted

### Calls in the background (Android)
Switching to another app does not drop your microphone: while a call is live
(and the microphone permission is granted) the app's keep-alive service holds
the microphone foreground type for the duration of the call, and releases it
when you leave. Android 14+ only allows that type to be taken while the app
is in the foreground, which is why it is set up the moment you join.

---

## Screen Sharing

### Start Sharing
Desktop and browser only — a phone cannot share its screen.

Púca remembers the **Resolution**, **Frame Rate** and **Audio to share** you
last picked, and **Share Screen** uses them without asking. So if you turn the
quality down because your machine struggled, every share after that starts
there.

If your computer cannot keep up with the share while it is running, the voice
panel offers to drop it a step — one click, applied to the share already going
out, so nobody watching is interrupted. Taking that step is also remembered. It
asks once, and will only ask again after you have taken a step and it is still
struggling. Lowering the frame rate saves more than lowering the resolution if
you need a bigger reduction; both are in the Screen Share dialog.

1. Join a voice channel
2. Click **Share Screen** in the voice panel. The picker opens straight away
3. Pick a window, screen or tab. You are live
4. Sound, in the desktop app: share a game's window and the stream carries that game's audio, found from the window itself. Share a whole screen and Púca asks which apps' audio to carry; tick them and click **Go Live**. Closing that list instead shares nothing
5. Sound, in a browser: tick **Share audio** in the browser's own picker. The app cannot tick it for you

To change the settings first, click the arrow beside **Share Screen**
(**Stream settings**). It opens the **Screen Share** dialog with
**Resolution**, **Frame Rate** and, in the desktop app, **Audio to share**:

- **The shared window's app**: the default, as in step 4
- **Choose apps after picking the window**: always show the app list, with the window's app already ticked
- **No audio**: video only

While you are sharing in the desktop app, **Stream audio sources** beside
**Stop Sharing** adds an app's audio to the stream (music alongside the game,
say), removes one, or changes its volume, without restarting the stream.

While you are sharing, the same arrow (**Stream quality**) changes the
**Resolution** and **Frame Rate** of the stream that is already going out,
up or down, without the picker and without dropping anyone watching. Each
change applies at once, and is remembered for your next share. A window or
screen is never sent larger than it is: ask for 1440p from a 1080p window and
the stream says it is capturing 1080p. One exception: a share sent at several
sizes (**Settings → Advanced → Screen sharing**, **Send my screen at several
sizes**) fixes each size when it starts, so its quality changes on the next
share instead.

### Viewing Streams
When someone shares, their entry in the voice view shows a **LIVE** badge and a
**Watch stream** button. The chat header also gains a **Watch live streams**
button. Several streams can be watched at once; **Switch to Grid View** /
**Switch to Focus View** changes the layout.

### Stream Controls
Hover a stream for its buttons, or right-click it for the same items as a menu:

| Control | Action |
|---------|--------|
| **Mute stream** / **Unmute stream** | Silence that stream's audio (the menu row is **Mute**) |
| **Fullscreen** | Expand that stream to the whole screen |
| **Pop out (stays on top when Púca is tabbed out)** | Picture-in-picture, where the browser or app supports it |
| **Stop Watching** | Remove it from your view |
| **Request Control** | Ask the sharer for keyboard and mouse control of their screen; they must accept |
| **Stream Attenuation** | Automatically reduce stream volume when people are talking |
| **Show Stream Stats** / **Hide Stream Stats** | Menu only. A live readout on the stream, refreshed every second: resolution, frame rate, video and audio bitrate, codec and whether it is decoded in hardware, packet loss, dropped frames and round trip |

Your own stream has **Stop sharing your screen** and, in the menu, **Stop
Sharing**, **Stream Quality** (the same panel as the arrow) and **Show Stream
Stats**. On your own stream the readout shows the
encoding side: what you are sending, whether it is encoded in hardware, and
what is holding the stream back (**Limited by**: CPU, bandwidth, or nothing).

---

## Roles & Permissions

### View Roles (Everyone)
1. Click a member in the member list
2. Their profile popup lists their roles under **Roles**

### Manage Roles (Owner, or a role with Manage Roles)
1. Open **Server Settings → Roles**
2. Click **+ Create Role**
3. Set **Role Name**, **Role Color** and **Permissions**
4. Click **Save Changes**

### Assign Roles (Owner)
1. Click a member in the member list
2. Under **Manage Roles** in their popup, tick or untick roles

### Permissions
The role editor groups them; the labels are: View Channels, Attach Files,
Add Reactions, Send Messages, Read Message History, Manage Messages, Add
Tasks, Complete Tasks, Manage Tasks, Connect, Speak, Video, Stream, Mute
Members, Move Members, Create Clips, Manage Channels, Manage Roles, Manage
Server, Kick Members, Ban Members, Create Invites, and Administrator (full
access to all permissions).

### Channel permissions (Manage Channels)
A role's permissions apply in every channel. To change what a role may do in
one channel only:

1. Right-click the channel in the channel list and choose **Edit Channel**
2. Open the **Permissions** tab (it appears only if you have Manage Channels)
3. Pick a role from the list
4. Each permission has three buttons, by tooltip: **Inherit** (use the role's
   server-wide setting), **Allow** and **Deny**
5. Click **Save Permissions**

Every channel lists View Channel, Send Messages, Add Tasks, Complete Tasks,
Manage Tasks, Manage Messages and Create Clips. A voice channel also lists:

| Row | What **Deny** does in this channel |
|-----|------------------------------------|
| **Connect** | The role cannot join the call, and anyone already in it is disconnected |
| **Speak** | The role can join and listen, but people on a current version of Púca don't hear their microphone. It does not silence their screen-share audio |
| **Video** | The role cannot turn on a camera |
| **Stream** | The role cannot share a screen |

How the settings combine:

- Denies never apply to the server owner or to administrators.
- When a member's roles disagree, an **Allow** on any of them wins over a
  **Deny**. Any role's setting also wins over the @everyone role's, so to
  silence one role in a channel where @everyone is allowed to speak, deny
  Speak on that role.
- A **Deny** of Connect or Speak takes effect straight away for people already
  in the call. A new **Allow** of Speak applies when they leave and rejoin.
- Speak covers the microphone only. Someone sharing their screen with sound is
  still heard through the share, so to silence someone completely deny
  **Stream** as well (and see the next point about a share already running).
- Video and Stream are checked each time someone turns on a camera or starts
  sharing; a camera or share already running is not stopped. In an SFU channel
  a new **Allow** applies after the member rejoins.

### Kick and Ban (Owner)
The member's profile popup has **Kick** and **Ban** buttons; each asks for
confirmation first.

---

## Direct Messages

### Start a DM
1. Click a member in the member list
2. Click **Message** in their profile popup (right-clicking the member offers **Message** too)
3. The conversation opens

### DM Conversations
- Click **Direct Messages** at the top of the server rail
- Open conversations are listed under **Direct Messages**; the **Find or start a conversation** box searches people and starts a new one

---

## Tasks

### Open Tasks
- Click **Direct Messages** at the top of the server rail, then **Tasks** in the left column
- The tab bar holds **All tasks**, **Calendar**, **Reminders**, your lists and every checklist channel from your servers; **New list** (the plus at its right end) starts a list
- **Refresh** (the circling arrows at the right end of the tab bar) reads your lists again, so a change made on another device shows without leaving Tasks; what you type or tick, just before or while it reads, is saved first and stays as it is
- Start an item with `## ` (say, `## Before you start`) to make it a **heading**: a section title with no checkbox that is not counted as a task. **Turn into heading** on a row does the same, and **Turn into item** turns it back. A heading that still has a due time (an older version can give it one) shows **Remove due time**

### Paste a checklist
- Paste step-by-step instructions — say, an AI assistant's answer — into **Add a task…** in a list, or **Add an item…** in a checklist channel, and Púca asks first
- **Add N items** adds each step as its own item, in order, without the numbers, bold marks or the "Here's how:" line (a section heading inside the list, such as "Security", becomes a heading, and the button says so: **Add 6 items and 1 heading**); **Add as one item** puts the whole paste on one line in the box for you to add; **Cancel** adds nothing
- Paste it into the **New list** name instead and the question says it will make a new list, and what the list will be called: what you had typed there, else the checklist's heading, else its first step. **Add N items** makes the list with the steps in it; **Add as one item** makes it with the steps, on one line, as its one item
- A one-line paste pastes as usual, and one paste adds at most 200 items

---

## Púca Notes (notes)

Púca Notes shows your task lists as notes, Google-Keep style. It uses the
account you are already signed in to.

- **In the desktop app** it opens inside Púca: click **Tasks & notes** on the
  server rail, and click it again to go back to the channel or conversation
  you last had open (or to the home screen, if there is none). Going to a
  channel and back keeps your place in Notes. The Tasks view is still there:
  click **Direct Messages** at the top of the rail, then **Tasks** in the left
  column.
- **In the browser** it is at `/notes/` on your server's web address. Open it
  with **Open in Púca Notes** (the note button beside **New list** in the
  Tasks view of the web app).

Inside Notes:

- **Take a note…** starts a new list — type a title and items (Enter adds the
  next). On a phone, the **New note** button at the bottom right does the same.
  In the Android app, **Open Púca Notes to** in the account menu can start the
  app on **A new note** or **A new list** instead — when it starts, and when
  you come back to it after five minutes or more — on that phone only.
  A new note or list opened from outside the app — that setting, a
  long-press shortcut, the quick tile, the widget, or an app such as
  MacroDroid sending the shortcut's intent (the details are in
  [Púca Notes](NOTES.md)) — opens ready to type, with the keyboard up, in
  the Púca Notes app from the release after 0.9.826 on.
- Click a note to open it. Inside, items work exactly as in Tasks: tick,
  edit, add subtasks, drag by the grip to reorder or nest, set a due time
  from the clock, attach pictures from the paperclip.
- An item that starts with `## ` is a **heading** — a section title with no
  checkbox, never counted as a step; **Turn into heading** on an item makes
  one, and **Turn into item** turns it back. One that still has a due time
  shows **Remove due time**.
- **Pin** keeps a note at the top (it is the same favourite as the Tasks tab
  bar). **Colour**, **Labels** and **Archive** are Notes' own, and follow your
  account to every device, sealed. **Search** looks through titles and items.
- **Reminders** in the left column lists every item with a due time, grouped
  **Overdue**, **Today** and **Upcoming**. The Tasks view in Púca itself has
  the same list as a **Reminders** tab, beside **Calendar** — so you can see
  what is due in Púca's phone app too, where Púca Notes' page is not
  reachable. A due-item notification opens it, except in the desktop app,
  where clicking one opens nothing yet. An item in a shared
  checklist that someone else set is marked *Reminds whoever set it*: it goes
  off for them, not for you.
- **A checklist from somewhere else** — say, step-by-step instructions from an
  AI assistant — goes in as a checklist. On your phone, **Share** it to
  **Púca Notes**. Anywhere, paste it into a new note's title or an item and
  choose **Add N items**. Either way the list's heading becomes the title,
  each section heading in it a heading, and each step an item. Press
  **Done** to save it. Pasted into a note
  that is already open (its title or **Add an item…**), the steps are added
  once you choose **Add N items**, and a note of yours with no name yet takes
  the heading as its name (the question says so first). Púca's own Tasks view
  takes the same paste (see *Tasks*, above).
- Archiving or deleting a note offers **Undo** for a few seconds.
- **Export notes as Markdown** or **as JSON**, under **Account** at the top,
  saves every note to a file, not encrypted. In the desktop app you choose
  where it goes.
- Shortcuts: `/` search, `c` new note, `r` refresh, `?` help.

Every checklist channel from your servers appears as a shared note with the
server's name on it, following the permissions you have in that channel.

---

## Friends

### Open the Friends panel
- Click **Direct Messages** at the top of the server rail, then **Friends** in the left column

### Add a Friend
- From the member list: click a member, then **Add Friend** in their popup (it changes to **Request Sent**)
- From the Friends panel: open the **Add Friend** tab, enter their username, click **Send Friend Request**

### Manage Requests
1. In the Friends panel, open the **Pending** tab
2. Incoming requests show **Accept friend request** and **Decline friend request** buttons; outgoing ones are marked **Pending**
3. The **Online** and **All** tabs list your friends, each with **Message** and **Remove friend** buttons

---

## Profile & Settings

### Upload Avatar
1. Click your name in the bar at the bottom of the channel list (tooltip **Edit Profile**)
2. Under **Avatar**, click **Upload Avatar** and select an image
3. Adjust the crop, then click **Save Avatar**

Your avatar appears in your messages, the member list and your profile popup.
The same dialog sets your **Display Name** and custom **Join / Leave Sounds**.

### Settings
The cog beside your name (tooltip **Settings**) opens **My Account**,
**Privacy & Safety**, **Appearance**, **Accessibility**, **Notifications**,
**Voice & Video**, **Keybinds** (not on phones), **Language** and **Advanced**.
**Log Out** is at the bottom of that list.

---

## Custom Emojis

### Upload an Emoji
1. Open **Server Settings → Emoji**
2. Under **Add Emoji**, click **Choose Image** and select a picture
3. Enter a name (e.g. `pepehype`)
4. Click **Add**

Any member can add one. The owner can delete any emoji (**Delete**); other
members can delete only the ones they uploaded.

### Use Custom Emojis
- They appear in a row above the standard picker when you add a reaction
- Their `:name:` shows as a tooltip

---

## Invites

### Create an Invite
1. Right-click the server in the rail and choose **Invite People** (the voice view also has **Invite people to this server**)
2. Under **Create New Invite**, set **Expire After** and **Max Uses**
3. Click **Generate Invite Link**
4. Click **Copy** on the new entry under **Active Invites** and share it. **Revoke invite** ends it early

### Use an Invite
1. Click the invite link where someone posted it in Púca — a message, a link preview, or a note in Púca's Tasks or Notes view. The **Join a Server** screen opens with the invite already looked up, in the desktop app, the Android app and the browser alike. Whatever you had open (a note, a call, a half-written message) stays where it was behind it
2. Or click **Join a Server** at the bottom of the server rail, paste the link or code and click **Look Up Invite**
3. Click **Join Server**. For a server you are already in, this takes you to it

An invite link clicked OUTSIDE Púca — in an email, another chat app, or Púca Notes' own page or Android app — opens the web app in your browser at the invite, not the desktop app. Sign in there, or copy the link and paste it into **Join a Server** in the app.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Esc` | Close the Settings dialog |
| `Ctrl+V` | Paste an image or file as an attachment |
| `Ctrl+Shift+M` | Toggle Mute (in a call) |
| `Ctrl+Shift+D` | Toggle Deafen (in a call) |

The two call shortcuts, plus **Open Settings**, **Search Messages**, **Push to
Talk (hold)** and **Push to Mute (hold)**, can be rebound under **Settings →
Keybinds**. Push to talk and push to mute only do anything once you switch
**Voice & Video** to that mode.

---

## Troubleshooting

### Can't connect to server
- Read the dialog's title. **This app is out of date** means the sign-in worked but this copy of Púca is too old for the server: update it; retrying will not help
- **Can't reach the server**: check your internet connection; if that is fine, ask whoever runs the server whether it is restarting
- **Live connection failed**: the server answered but the live connection did not open. Click **Try again**; if it keeps failing, click **Sign out** and sign in again

### "Púca’s server has refused this computer at its sign-in screen"
- Shown under **Reach this computer after it restarts** (Devices → This device) when Púca's server has refused this computer's sign-in-screen connection more than once, at least ten minutes apart. It says when the refusals started and when the most recent one was. While it lasts you cannot connect to the computer when nobody is signed in to it, for example after a restart, even though the box is ticked. While you are signed in and Púca is running you can still connect, lock screen included
- The computer only checks again while it is locked, so the message can be out of date. To check now: lock the computer for a minute, unlock it, and open Devices again. If the message has gone, nothing needs fixing
- If it is still there: untick **Reach this computer after it restarts**, tick it again, then set the passphrase again under **Passphrase for the sign-in screen**
- The same refusal can come from a fault on the server. If the warning comes back after you have done this, ask whoever runs the server

### Voice not working
- Check the microphone permission for the app or site
- Open **Settings → Voice & Video** and check the input device
- Calls are encrypted end to end by default, and a browser that cannot do that (Firefox, Safari, iOS) is muted rather than carried in the clear — the indicator beside the peer names the reason. Use the desktop app, or Chrome or Edge

### Screen share black screen
- Use the desktop app, or Chrome or Edge
- Try sharing the entire screen instead of a single window

### Send a problem report to the server owner
- When calls or streams misbehave, open **Settings → Advanced → Send diagnostics to the server owner**, or right-click the voice panel and choose **Send diagnostics to the server owner…**. Do it while the problem is happening, or soon after
- Pick the server whose owner should get it (the one you are in is picked first), optionally say what went wrong, and press **Send report**. It takes a few seconds, because it measures your call first
- The owner receives a text file in an encrypted direct message from you: the same measurements **Copy diagnostics** takes and, in the desktop app, the app's log (call and stream quality over the last hours, and the names of programs whose audio you shared). No messages, passwords or addresses are included, and the Windows account name is removed from any file path
- On a phone or in a browser there is no log file, so the report holds the measurements only
