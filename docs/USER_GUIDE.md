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

### Staying signed in
The sign-in screen has **Stay signed in on this device**. Ticked, the device
stays signed in for up to a year, as long as Púca is opened at least once a
month. Unticked, a sign-in lasts a day after you last used Púca (still up to
a month while you keep using it), so a day away means signing in again. It
starts ticked in the desktop and Android apps and unticked in a browser, and
the device remembers your answer (Púca Notes shares it). **Sign out** ends
either kind at once, and so do **Sign out of every device** and a password
change.

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
| Member list | Everyone on the server. A crown marks the **Server Owner**. Under it, **Active in your servers** lists the voice channels that have people in them in any of your servers ([below](#active-in-your-servers)) |

On a phone the same areas are tabs along the bottom (**Chat**, **Members**, …).
In the Android app, **Back** closes whatever is open on top first: a menu, a dialog, a sheet, Settings,
Server Settings, a profile or the picture viewer, one at a time, newest first. With nothing open, Back leaves the
app as it always has. (This needs an Android app installed after 0.9.836; on an older one Back always leaves the
app.)

### The channel list: folding, and who is in a voice channel
**Fold what you are not reading.** The **Text Channels** and **Voice Channels** headings are buttons
with an arrow, as a category is in Discord, and so is the arrow in front of each collection. Press one
(or Tab to it and press Enter or Space) to fold it away, and again to bring it back.

- A folded **Text Channels** keeps the channel you have open and **every channel with unread
  messages** (a muted channel's unread does not keep it). Messages are end-to-end encrypted, so the
  list cannot tell which unread channel has a mention for you; none is folded out of sight, and a
  mention still pings and still lights the server's bubble in the rail. The heading says how many
  channels it is holding back (**4 hidden**).
- A folded collection does the same for its own channels.
- A folded **Voice Channels** keeps every room with someone in it, and the one you are in, and
  takes the empty rooms away (**1 empty**).
- Folds are your own and stay on this device: one per server, never sent to the server, so nobody
  else's list changes. **Hide Muted Channels** (the server menu above) is separate and still works.

**Who is in a voice channel.** The people in a room are listed under its name. To check a room, rest the
mouse on its row, or Tab to it: a card names everyone in it, with who is muted, deafened or sharing, or
says **Nobody is here**. Enter or Space on a focused row joins it, the same as a click. A touch screen has
no hover, so a phone opens no card: it lists the people under the room, and a room with nobody under it is
empty.

### Active in your servers
Under the member list, **Active in your servers** shows every voice channel with someone in it in
any server you belong to, not only the one you have open, grouped by server, with who is in each.
Press a row to go to that server; its voice row is scrolled into view and outlined for a moment, and
the call is **not** joined (joining opens your microphone, so it is the room's own row you press). Rest
the mouse on a row for everyone in the room. It only ever lists servers you are a member of and
channels you are allowed to see. While it is still looking, or could not read a server, it says that
instead of saying nobody is there. The arrow folds it. To turn it off, untick **Settings → Appearance → Active in Your Servers**; it then stops
looking at your other servers' calls too.

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

The same dialog has **Roles**, **Modes**, **Emoji**, **Invites** and, for the owner, **Moderation** tabs.

### Server menu
Right-click a server icon in the rail for **Mark as Read**, **Invite People**,
**Mute Server**, **Notification Settings**, **Hide Muted Channels**,
**Server Settings**, **Edit Server Profile** (your nickname on that server),
**Leave Server** and **Copy Server ID**. The owner sees **Disband Server**
instead of Leave.

### Server modes
A mode is a set of channels that only show in the channel list while it is on,
with an optional background picture and accent colour. It suits channels you only
need for one thing, such as the town square and private rooms of a game of Blood on
the Clocktower. One mode is on at a time.

**Set one up** (Manage Channels). In **Server Settings**, open **Modes**, type a
name and press **Add mode**. Then tick the channels it should show, and press
**Save**. A collection's subchannels show and hide with it. You can also choose:

- **Main voice channel**: where **Join** goes when the mode starts, and where **Call
  everyone to** brings people.
- **Background**: a JPEG, PNG or WebP picture. It is shown behind the chat in its own
  colours. Each person's device darkens or lightens it only as far as messages need to
  stay readable on their theme, so one bright moon does not dim the whole sky. A very
  busy picture, such as confetti or a crowd, also has its fine detail softened so that it
  does not compete with the words; its colours stay, and a calm picture is untouched. While a
  picture shows, smaller text in the chat is a little lighter (or, on the Light theme,
  darker) than usual, for the same reason. The picture never changes anyone's theme. It
  is stored unencrypted, like the server icon, so whoever runs the server can see it.
  Animated pictures are not supported.
- **Accent colour**: recolours buttons and highlights while the mode is on. It is
  lightened or darkened for each person's theme so button labels stay readable.
- **Turn off when empty**: on by default. The mode turns itself off once its voice
  channels and its main voice channel have been empty for 30 minutes, counted only
  after someone has been in them.

**Switch it** (the **Switch Modes** permission, which the owner and administrators
have and nobody else has until a role is given it). Press **Mode** under the server's
name and pick a mode, or **Off**. Everyone online sees the channels and the look
change at once, and gets a quiet notice with a **Join** button. It makes no sound and
sends no phone notification, and you won't see it for a server you have muted.

**Turning a mode off disconnects everyone in its voice channels**, and you are warned
first if anyone is in them. Voice channels under a collection you ticked count as the
mode's. Switching straight to another mode does the same, except in channels both modes
share. Messages in its text channels are kept and come back with the mode. Deleting a
mode that is on turns it off, so that takes **Switch Modes** as well.

**Call everyone to** (Move Members) is in the same menu while a mode is on, followed by
the name of its main voice channel: it pulls everyone in the mode's voice channels into
that channel. It can't move anyone ranked at or above you, and tells you how many it left.

**A mode tidies the list. It does not keep anyone out.** Anyone allowed to see a channel
can still open it from a mention or a notification, and people on an older
version of Púca see every channel. To keep someone out of a channel, use its permissions
(*Channel permissions*, below). A voice channel with people in it stays listed even while
hidden, so a call is never invisible.

**Don't want other people's backgrounds?** Turn off **Server Backgrounds and Colours** in
Settings, under Accessibility. **High Contrast** also hides them.

For how this works and why, see [SERVER_MODES.md](SERVER_MODES.md).

---

## Messaging

### Send a Message
- Type in the message box and press **Enter**
- **Shift+Enter** inserts a new line
- If the channel goes away while you are writing (it is deleted, you lose access to it, or you are no longer on the server), Púca moves you to another channel and empties the box, so nothing can go to the wrong people. A notice has your words until you dismiss it. Pressing another channel yourself keeps what you wrote in the box

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
| `\|\|spoiler\|\|` | Hidden until clicked, or until you Tab to it and press Enter or Space (press again to hide it), along with any code, code block, quote, link, picture, mention or file in it. The first press only reveals, and a link in a spoiler has no preview under the message. A screen reader calls it "Spoiler, button" and does not read what is in it until it is revealed; on a Windows contrast theme it is a solid bar |
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
| **Quote** | Copies the message text into the message box as a `> quote` for you to add to. An attachment is quoted as its name (`Image: photo.png`), not as the file | everyone |
| **Forward** | Sends the text to another channel or DM | everyone |
| **Edit** | Opens an **Edit message:** prompt with the message's text. A message with attachments says **Edit message (attachments are kept):** — you change the words, and the files stay as they were | your own messages |
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

A picture shows in the message. A video, and an audio file (mp3, m4a, aac, ogg, opus, wav, flac, weba), gets a player
right there instead — audio under its file name — and nothing plays until you press play. Every file keeps its
download button underneath. A file the player cannot open, or a type it does not know, is just the download button.
A video with no picture your device can show — a sound-only .webm, or a video in a format your device cannot
decode — gets the audio player, marked **Sound only: no picture to show**; download it to watch it elsewhere.

A photo in **HEIC** (what most phone cameras save) is turned into a JPEG on your device before it is sent, so
everyone can see it: in the Android app (Android 9 or newer), in the desktop app when Windows has the HEIF Image
Extensions and HEVC Video Extensions from the Microsoft Store, and in Safari. Its chip shows the JPEG and its name
ends in .jpg. The JPEG keeps only the picture: not the location, camera or time the phone stored with it. Where
your device cannot convert it (a browser other than Safari, a PC without those extensions), the HEIC is sent with
its location, camera and time removed; if they cannot be removed, it is not sent and its chip says why. A HEIC
picture someone sent is shown in the Android app (and **Download** in its picture viewer saves the JPEG you see);
elsewhere it is a card with its name, size and a **Download** button that saves the file. In the desktop app the card also has **Show photo**, which opens
it with Windows' own decoder (it needs those two extensions). It waits for you because that decoder runs inside the
app, without the protection the app gives every other picture.

### Watch a Video
Videos in messages and DMs, posted clips, a clip's preview before you post it and videos attached to tasks all
have the same player, with every control on it at every size — a narrow portrait video included:

- **Play / pause**: the round button in the middle of the picture, or the one at the left of the bar on a wider video.
  With a mouse, clicking the picture plays and pauses too
- **Timeline**: shows the time so far (and the length, where there is room); click or drag along it to skip
- **Volume**: the speaker button. On a wide video it mutes and the slider sits beside it; on a narrow one it opens a
  small panel with **Mute** and the slider. A video's volume is its share of **Settings → Voice & Video → Output
  Volume**: at 50 % Output Volume, a video at 100 % plays at half, and moving Output Volume changes a video that is
  already playing. The level you set is where the next video starts until you close the app
- **Speed**: the `1×` button — 0.5×, 0.75×, 1×, 1.25×, 1.5× or 2×, without changing the pitch. A speed stays with that
  video until you close the app
- **Full screen**: the corners button. It fills the screen in a browser and the whole window in the desktop app; in the
  Android app it fills the whole screen (the status and navigation bars step aside until you leave it; a swipe from
  the edge brings them back), and turning the phone sideways gives a landscape picture. Leave it with the same
  button, **Esc**, or (with an Android app installed after 0.9.836) **Back**

With the player focused (click it, or **Tab** to it): **Space** or **K** play/pause, **←** / **→** skip 5 seconds,
**↑** / **↓** volume, **M** mute, **F** full screen. These keys do nothing anywhere else, so typing in the message
box never controls a video.

On a phone, tap the picture to show or hide the controls — a tap on the picture never starts the video — and they
hide by themselves a moment after it starts playing. Scrolling the chat with a finger that starts on a video's
timeline scrolls the chat; it does not skip the video. A video attachment under a spoiler cannot be played or focused
until the spoiler is revealed (Púca Clips are not hidden by spoilers). Nothing ever plays by itself.

Attachments load by themselves, with nothing to click: the ones on screen first, then the ones nearest to it, a
couple of big files at a time, and then, while nothing nearer is loading and up to a limit, the rest of the channel,
so one you scroll to is normally ready when it appears. Each is downloaded and decrypted on your device. Only the
few players nearest the screen are live at once: every one on screen, then the next ones in the direction you are
scrolling. A video waiting for its player already takes the player's space (for MP4, MOV, WebM and MKV files,
which is nearly all of them), so nothing moves as you scroll, and a video you paused carries on from where you left
it when you come back to it. The files within about two screens of what you are reading stay ready; those further
away, or in a channel you left, are kept up to a limit so going back needs no download, and past it the oldest are
dropped and load again when you come back. The ones kept are kept **encrypted**: a file is decrypted only while it
is on or near the screen, and a couple of seconds after you switch to another app Púca lets go of everything it is
not playing, showing in the picture viewer or saving, so no readable copy waits on the phone. Coming back shows them
again a moment later (about a second and a half for a channel's few pictures and videos on a test phone) from the
encrypted copy, with nothing downloaded again (docs/SECURITY_MODEL.md, *Decrypted attachments on your own storage*).

You can also drag files from your computer onto the messages, in the desktop
app as in the browser, wherever you could send a message. Wherever a message is shown in short — the
**Replying to** bar, the line above a reply, **Pinned messages**, search
results, and the toast for a direct message — an attachment appears as a small icon and its file name; a spoiler
shows only **Spoiler image** (or video, audio, file), and the words of a `||spoiler||` are one **Spoiler**
whatever they hold (text, code, a link, a mention, a file name), however it was revealed in the message. Search finds an attachment by its file
name, and a message by its words, except what a spoiler hides. **Quote** is the exception: it copies the message into the box as it is,
with the `||` around the spoiler, so the quote is a spoiler too. Notifications from the system never carry what a message says.

### Photos and where they were taken
Púca removes the hidden details a phone adds to a photo (where it was taken, the phone's model, the exact time) before it sends a JPEG, PNG or WebP, so the people you send it to see the picture and nothing else. Nothing is compressed or resized, and portrait photos still arrive upright. If a photo is too damaged for that, it is not sent and the message tells you to re-save it. Photos sent earlier keep their details.

### Paste Images
1. Copy an image (or a file) to the clipboard
2. **Ctrl+V** in the message box — it becomes a chip, the same as an attached file
3. Press **Enter** to send

### Save a File on Android
- In the Android app (version 0.9.834 or newer — it needs the new app, not just an update inside it), **Download** on a clip or an attachment saves it where your phone's own apps look: videos in **Movies/Puca**, pictures in **Pictures/Puca**, music in **Music/Puca**, anything else in **Download/Puca**. Google Photos and your gallery show a saved clip with its length, and you can skip around in it. Saving the same file twice gives the second copy a `(1)` after its name
- What decides the folder is what the file really is, not what it is called: a video with the wrong name gets `.mp4` added, and a file whose name says picture, video or sound when it is not one goes to **Download/Puca** with `.bin` added (`cat.mp4.bin`), so the phone does not treat it as one. Rename it if you trust it. Some text files get `.bin` too, because phones use their extension for media as well: a TypeScript file `notes.ts` (`.ts` is also a video format) is saved as `notes.ts.bin`, and a drawing `logo.svg` as `logo.svg.bin`
- A picture's **Download** button in its full-screen view saves it to **Pictures/Puca** (on an older Android app, to `Documents/Puca`)
- While an attachment saves, its button shows how much has arrived (`— 12.3 MB`); if it fails, it says why (`— no longer on the server`, `— the connection dropped, try again`, `— could not be decrypted`)
- Downloads keep going with the screen off or the app in the background. A long one shows a notification with its progress and a **Cancel** button (a quick one can flash it for a moment too, for example in the first two minutes after you open the app); if it finishes while you are not in the app, a notification says it was saved (tap it to open the file) or that it failed. A clip's **Cancel** button next to **Download** stops it too, and leaves nothing half-written behind
- While a clip downloads, its button shows how much has arrived (`Downloading 45%`, then `Saving…`); a clip you press Play on, or a large attachment, shows the MB arriving until it can play
- An attachment you already see in the chat is downloaded once more when you save it (at most 25 MB), so the phone can write it straight into the right folder
- On an older Android app, or Android 9 and older, saving still puts the file in `Documents/Puca` under a new name each time, as before. A large file is written there as `<name>.part` and gets its real name only once it is complete; if the app is closed before then, the `.part` file is what is left: delete it and save again. A clip saved that way has no length in its file; the new app adds it

### Save a Clip on Windows or in a Browser
- **Download** on a clip saves it with its length and a seek index, the same file the Android app saves for that clip: File Explorer and the file's Properties now show how long it is (Media Player could already skip around in a downloaded clip, and still can). The picture and sound are exactly what was recorded

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

If the voice channel you are in is deleted, or you lose access to it, you leave its call, a message names the channel,
and any share you were watching closes.

A channel's **Speak** and **Connect** permissions (see
[Channel permissions](#channel-permissions-manage-channels)) change what
happens:

- **Without Speak** you still join, listen-only: you hear everyone, nobody
  hears you, and the app does not ask for microphone access. The panel reads
  **Voice Connected · can't speak**.
- **Without Connect** you cannot join. The panel says
  **You don't have permission to join this voice channel.**

To join calls with no microphone at all, tick **Settings → Voice & Video →
Join voice without a microphone** (it applies on this device, from your next
join). The app then never asks for microphone access, the panel reads
**Voice Connected · no microphone**, you hear everyone and can still share
your screen, and the others see a dashed microphone (**No microphone**) next
to your name instead of the muted one. You are never moved to the AFK channel
for being idle while joined this way.

### Voice Controls
The voice panel's buttons, by tooltip:

| Tooltip | Action |
|---------|--------|
| **Mute** / **Unmute** | Stop or resume sending your microphone. Reads **You joined without a microphone — nobody can hear you** when you joined without one on purpose, **Push to talk — hold your key to speak** in push-to-talk mode, **No microphone detected — listen-only mode. Mute now to stay muted when it comes back** if there is none, and **You don't have permission to speak in this channel** if you do not have the Speak permission there. With no microphone the button, and your **Toggle Mute** key, still work (except while you are deafened, in an AFK channel, or without the Speak permission): they decide whether you come back muted when a microphone returns, and the button then reads **No microphone detected — you stay muted when it comes back. Click to unmute**; deafened, it reads **No microphone detected — you are deafened, so you stay muted when it comes back**. If you were muted or deafened when your microphone dropped out, you come back muted |
| **Deafen** / **Undeafen** | Stop hearing everyone, which also mutes you |
| **Noise suppression** | A picker, not a button: choose the microphone filter — **No suppression**, **Standard** or **RNNoise (ML)**. **DeepFilter (Max)** is listed too once **DeepFilterNet noise suppression** is ticked under **Settings → Advanced** |
| **Turn On Camera** / **Turn Off Camera** | Share your camera. It opens the camera you used last on this device (see [Cameras: front, rear and the camera menu](#cameras-front-rear-and-the-camera-menu)) |
| **Camera: choose which camera** | The arrow beside the camera button, while it is on and there is more than one camera: the camera menu |
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

### Cameras: front, rear and the camera menu
With your camera on, your own picture sits in a small window you can drag
anywhere.

- **Flip**, the round button in the corner of your picture, switches between
  the front and the rear camera: from the front camera to the phone's main rear
  camera, and back. On a computer with more than one webcam it goes on to the
  next one. It is shown only when there is another camera to go to.
- **Tap your picture** (or click it), or use the arrow beside the camera button,
  for the camera menu: every camera the device has, by its name, the one in use
  ticked, then **Switch to the rear camera** (or the front), **Full screen** and
  **Turn off camera**. An iPhone lists each of its rear lenses (**Back Camera**,
  **Back Ultra Wide Camera**, **Back Telephoto Camera** and so on); an Android
  phone lists the cameras its maker lets apps use, which on many phones is one
  front and one rear camera. A webcam's name is shown without the numbers some
  add in brackets.
- **Full screen** shows your picture across the screen with **Flip Camera**,
  **Cameras**, **Exit Fullscreen** and **Turn Off Camera**.
- Your picture is shown as a mirror would show you only while the camera faces
  you. A rear camera is shown as it is, so writing it films reads the right way
  round. A webcam that does not say which way it faces is taken to face you.
  Everyone else sees your camera as it is, whichever camera it is.
- The camera you switch to is kept on that device: the next time you turn your
  camera on, in any call, it is that one. **Settings → Voice & Video → Camera**
  chooses it before a call, but only once Púca has been allowed to use the
  camera: until then it lists only **Default** (the front camera on a phone).
  On a phone that means turning your camera on in a call once after opening
  Púca; the cameras are then listed by name. A camera that is not there any
  more (a webcam unplugged) gives way to the default one.
- If the camera you pick cannot be opened (another app holds it), you stay on
  the one you had and the panel says so.

The other camera goes out on the same connection as the first, so it is
end-to-end encrypted exactly as the first was, in an ordinary call and in an
SFU channel alike; nobody else in the call has to do anything.

### Mute vs Deafen
- **Mute**: others cannot hear you; you still hear them
- **Deafen**: you hear nothing AND are muted

### Move or disconnect someone in voice (Move Members)
With the Move Members permission (or as the owner), right-click a member who
is in one of the server's voice channels (under the channel in the channel
list, on a voice tile, or in the member list on the right; on a phone, tap
them under the voice channel) and use the **Voice** section. You do not have
to be in voice yourself.
- **Move to** opens the list of voice channels right under it; pick one. Someone who had muted or deafened themselves arrives still muted or deafened
- **Disconnect from voice** drops them out of the call; they can rejoin straight away

A member sitting in the AFK channel can be disconnected but not moved out of it.
Opened from the member list, the menu shows **User Volume** and **Mute** only
when you are in the call with them. On a computer you can also drag them onto
another voice channel in the channel list.

### Your call on another device
If you are in a voice channel on one device (your PC, say) and open Púca on
another (your phone), the second device shows a bar on every screen:
**You're in Lounge on your PC**, with the server's name under it and two
buttons:

- **Leave** ends the call on the PC. The PC drops out of voice and says
  **You left voice from your phone**.
- **Move here** ends the call on the PC and joins it on this device instead.
  The people in the call do not hear you leave and rejoin; the PC says
  **You moved the call to your phone**.

Tapping the same voice channel on the phone does the same as **Move here**:
the call moves, it is never connected on both devices at once. Tapping a
different voice channel moves you there, and the PC drops out of its call
with the same notice.

However the call comes over, it arrives as you left it: muted if you had
muted, deafened if you had deafened. The same goes for switching to another
voice channel during a call, on any device. Only a call you start from
nothing begins unmuted.

It works the other way round too: a call on your phone shows the bar on your
PC. The bar says **in a browser** for a computer's web browser (a phone's or
tablet's browser counts as your phone) and **on another device** when the
other device did not say what it is. A PC that was asleep or offline when its
call was moved or ended does not rejoin that call when it wakes up, and does
not rejoin any call while you are in voice on another device; click the
channel again if you want it there. The bar needs a server and an app
from this release or later: against an older server it is simply not shown.

### Calls in the background (Android)
Switching to another app does not drop your microphone: while a call is live
(and the microphone permission is granted) the app's keep-alive service holds
the microphone foreground type for the duration of the call, and releases it
when you leave. Android 14+ only allows that type to be taken while the app
is in the foreground, which is why it is set up the moment you join.

### Activities in a call: Poker and Blackjack
People in a voice call can play Texas Hold'em or Blackjack together, the way
Discord's Activities work, for **free chips that are worth nothing**: everyone
sits down with the same stack, nothing is kept when the table closes, and chips
can never be bought, sold or exchanged for anything.

- **Starting one:** in a call, press the **Activities** button (the rocket)
  beside the camera and screen-share buttons; on a phone, tap the arrow on the
  voice bar to show the controls, then the rocket. Pick **Poker** or
  **Blackjack**. The table opens for you and you sit down; the first time on
  each server you are told that chips are worth nothing and that the server
  deals the cards.
- **Everyone in the call sees it at once**, without reloading: a line at the
  top, "*name* started Poker", with **Join** and **Watch** (close it with the
  ×; it never pops up over what you are doing and makes no sound); a tile for
  the game in the call's grid, with how many are playing; and in the channel
  list the call shows the game and a small cards mark beside each player.
- **Joining or watching:** **Join** (on the line at the top, the tile, or the
  Activities picker) seats you at the first free seat; **Watch** opens the table
  without a seat. Without the **Play Games** permission you can always watch.
  **Back to call** returns to the call's grid and never leaves the call; your
  seat and the table are still there when you open the tile again. On a phone
  the message box steps aside at the table and comes back with Back to call.
- **For the server owner:** games are **on** for every server until the owner
  turns them off: **Server Settings → Overview → Allow games in voice calls**,
  next to the Clips switch. Turning them off ends every table at once and
  removes the Activities button from everyone's call straight away; turning
  them on brings it back the same way. Starting and joining need the **Play
  Games** permission (everyone has it by default; deny it on a role or a single
  voice channel like any other - someone who loses it gets up from the table,
  even if they were away from the call when it changed) and **Connect**. Anyone
  with **Move Members** can close a table or take a player out of their seat
  (to keep someone out, deny them Play Games).
- **One activity per call**, of either game. While one runs, the picker offers
  to join it, and the other game waits until it closes.
- **Watching** needs nothing but being in the call: everyone in it sees the
  table, and nobody sees another player's face-down cards.
- **Hold'em:** No-Limit, up to 6 players, 1,000 chips, blinds 5/10 (opened
  from the table view itself, a table may have its own stack and blinds). The
  next hand is dealt about 3 seconds after the last one ends, when two players
  can play.
- **Blackjack:** against the house, 6 decks, the dealer stands on soft 17,
  blackjack pays 3:2, split up to 4 hands (split aces get one card each), no
  insurance or surrender; bets 10 to 500. The round is dealt a moment (1.5
  seconds) after everyone at the table has bet, so the last bet is seen, or 15
  seconds after the first bet.
- **The clock:** each decision has 30 seconds. When it runs out you check if
  that is free, otherwise fold (Blackjack: stand); two in a row sit you out
  until you sit back in. A busted player may take a fresh stack.
- **Nobody at the table** for 5 minutes closes it.
- **Dropping out of the call** (a network blip, a closed laptop) keeps your
  seat, chips and cards for a few seconds; come back in time and you carry on.
  Stay away longer and you get up from the table (mid-hand, that folds your
  hand). Leaving keeps the chips you left with for when you sit down again.
- **The server deals the cards**, so whoever runs the server could see them.
  The table says so the first time you sit down; see
  [the security model](SECURITY_MODEL.md#card-games-the-server-deals-so-the-operator-could-see-the-cards).
- A server restart ends every table.

---

## Screen Sharing

### Start Sharing
From the desktop app, a browser, or the Android app (see
[From the Android app](#from-the-android-app) below). A phone's browser and
the iPhone cannot share a screen: browsers on Android have no screen sharing
for web pages, and neither has Safari on iPhone and iPad before iOS 27
(Púca does not offer the new iOS 27 one yet; it has not been tried). On those,
**Share Screen** in the voice panel is dimmed, and pressing it says why; on an
Android phone it points you to the Púca app for Android.

Púca remembers the **Resolution**, **Frame Rate** and **Audio to share** you
last picked, and **Share Screen** uses them without asking. So if you turn the
quality down because your machine struggled, every share after that starts
there.

If your computer cannot keep up with the share while it is running, the voice
panel offers to drop it a step — one click, applied to the share already going
out, so nobody watching is interrupted. It offers in two cases:

- **The encoder is short of CPU.** It offers a smaller picture first, and
  taking that step is also remembered for your next share.
- **The share keeps losing frames**, for about half a minute: frames it
  captures do not go out (it sends under about 70% of them). Viewers see that
  as stutter even when nothing says your computer is busy.
  It offers 30 fps, which sends about as many frames as the share was
  managing, more evenly (and in a channel that uses SFU mode, with less data
  for everyone watching), then a smaller picture once it is at 30. This step
  is for that share only: your next share starts at your own settings again,
  and **Stream quality** shows what the running share is really at.

Fewer frames on their own are not counted, however unevenly they come: a film
at 24 or a game capped at 30 under a 60 fps setting, scrolling a document, a
video, or a screen where little changes (someone typing) loses none, because
every frame captured is sent. It asks once, and will only ask again after you
have taken a step and it is still struggling. Lowering the frame rate saves more than lowering
the resolution if you need a bigger reduction; both are in the Screen Share
dialog.

1. Join a voice channel
2. Click **Share Screen** in the voice panel. The picker opens straight away
3. Pick a window, screen or tab. The **Share Screen** button turns on at once and pulses while the stream starts, which can take a few seconds for a game's window; then you are live
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
the stream says it is capturing 1080p. A share sent at several sizes (see
below) changes too, every size with it. When a change means the share should
go from one size to several, or back (see **Automatic** below), viewers see
the picture hold for about a second while it switches.

### From the Android app

1. Join a voice channel. On a phone, tap the arrow at the edge of the voice
   panel to show all its buttons
2. Tap **Share Screen**. Android asks in its own dialog whether Púca may
   share your screen. Choose **Share entire screen**, or (Android 14 and
   later) **Share one app** and then the app, and confirm. **Cancel** shares
   nothing
3. You are live. Everyone in the call can watch, in mesh and SFU channels
   alike, encrypted end to end like anything else in the call

The share keeps going while you use other apps: that is the point of
sharing a phone. While it runs, Android shows that the screen is being
recorded or cast, and Púca's notification **Sharing your screen** has a
**Stop sharing** button. **Stop Sharing** in the app stops it too, and so
does Android's own control in the status bar.

Android asks every time. Its permission lasts for one share only.

What is different from a computer:

- **No sound.** Only the picture is shared, never the phone's audio.
- **At most 1080p and 30 fps.** The phone turns every frame into a picture
  for the app and then encodes it again, so the larger sizes and 60 fps in
  the dialog are treated as 1080p and 30 fps. The picture keeps the phone's
  shape: upright when you hold it upright, and it follows when you turn it.
- **A still screen sends little.** Frames go out when something on the
  screen changes, plus about one a second while nothing does.
- It needs the new Android app (a new install from the download page, not
  only the in-app update), in Púca Lite too. In an older Android app,
  **Share Screen** says so when you press it.

### Let someone control your phone

While you share your whole screen from the Android app, someone watching
can ask to control the phone: to tap, swipe and type on whatever is on your
screen, and press Back, Home and Recents. Nothing happens until you allow
it, every time, twice: in Púca, and then in Android's own **Let "Name"
control this phone?**, which Púca's page cannot answer for you.

The first time, Android has to let Púca do it:

1. When someone asks, Púca shows **Allow control of this phone?** (and a
   notification, if you are in another app; tap it to open Púca)
2. If it says to turn on **Púca remote control** first, tap **Open
   Accessibility settings**, open **Púca remote control** and switch it on.
   Android explains what an accessibility service can do; Púca uses it only
   while you have allowed someone, and does not read your screen with it.
   If it says instead that Android has stopped Púca remote control for now,
   the switch is already on and there is nothing to turn on: an automation
   or testing app can make Android do that, and **Allow control** can be
   pressed once Android runs it again
3. If Android says it is a **restricted setting** (Android 13 and later, for
   an app installed from the download page): tap **Open App info** in Púca's
   prompt, tap the menu at the top right, choose **Allow restricted
   settings**, then switch **Púca remote control** on again
4. Back in Púca, **Allow control** can now be pressed
5. Android then asks **Let "Name" control this phone?**: **Allow** starts
   it, **Cancel** turns them down (as **Deny** does). It waits half a
   minute for an answer

To turn it off again: Android's **Settings › Accessibility › Púca remote
control**, off. Púca's prompt will then ask you to switch it on before anyone
can control the phone.

While someone is in control:

- an orange frame goes round your screen, over every app, with **"Name" is
  controlling this phone** and a **Stop** button at the top (your touches
  go through the frame and the words to the app underneath; only Stop
  takes a tap);
- Púca's notification **Sharing your screen** says who, and has **Stop
  control**;
- in Púca, the banner at the top has **Stop control**.

Any of those Stops ends it at once, and so does locking the phone, stopping
the share (from Púca or the notification), or leaving the call. It never
comes back by itself, not even when you share again: they have to ask
again, and you to allow again.

It works only while you share the **entire screen**. Shared one app
(Android 14 and later), Púca refuses control, because the person watching
could not see where a tap outside that app would land. Android does not say
which you chose, so an app that fills the whole screen looks like the entire
screen until you switch away from it, which ends control within a second; a
tap sent in that moment can reach the app you switched to. Choose **Entire
screen** to be sure. Typing goes into the
text box you or they tapped, and it does not press keyboard shortcuts. What
they type is never put into a password box, but their Enter still reaches
one, and a tap on your phone's own keyboard is a tap like any other, so they
can still type with that.

Control of a phone is in the full Púca app only, not in Púca Lite, and needs
the new Android app (a new install from the download page). Phones running
Android 7 cannot be controlled: Púca says so, and does not offer the switch
in Android's settings.

### Control someone's phone

When the person sharing is on a phone, **Request control** on their stream
asks them; once they allow it:

- **click** (or tap, on a phone) is a tap on their screen, **drag** is a
  swipe, a **right-click** is a long press, and the **mouse wheel** scrolls;
- typing on your keyboard types into the text box they have open; Esc is Back.
  Keyboard shortcuts do nothing on a phone, and neither do accents typed
  with a dead key or text from an input method for Chinese, Japanese or
  Korean;
- the stream's buttons gain **Back**, **Home** and **Recent apps** for their
  phone.

While you wait for an answer, the request's button on the stream is a
cancel button (the right-click menu only shows **Control Requested…**;
after a cancel you can ask that person again after a short wait). If
nobody answers for nearly three minutes (their app cannot be
controlled at all, Púca Lite for instance), the request is dropped.

### How much a share sends

In a channel that uses SFU mode, the most a share sends follows its
**Resolution** and **Frame Rate**, so fast motion (a game, a film) keeps
its detail instead of smearing into blocks:

| Resolution | 15 fps | 30 fps | 60 fps |
|---|---|---|---|
| 720p | 2.5 Mbps | 4 Mbps | 6 Mbps |
| 1080p | 3.5 Mbps | 6 Mbps | 10 Mbps |
| 1440p | 6 Mbps | 10 Mbps | 16 Mbps |
| 4K (**Source** of a 4K screen) | 8 Mbps | 14 Mbps | 20 Mbps |

These are ceilings, not targets: a still desktop sends far less. **Source**
uses the row for the size of what you share, so Source on a 1080p screen is
the 1080p row, and a very wide window counts as the larger picture it is. A
quality change while you are sharing changes the ceiling with it.

Each server has a ceiling of its own, because every viewer of a share costs
the server that much upload: the server's operator can set one, and one sized
to the server's upload applies otherwise (about 5.5 Mbps on the smallest
setting). A share never sends more than the server's ceiling, whatever its
quality. A server that has not been updated keeps every share at 4.5 Mbps,
as before.

Your own upload still decides in the end: on a slow connection the share
drops to a smaller picture by itself and comes back when it can.

### Several sizes, for viewers on slower connections

A share sent at one size has nothing smaller for a viewer whose connection
cannot carry it, and that viewer's picture freezes. So in a channel that uses
SFU mode a share can go out at three sizes, and each viewer gets the largest
one their connection carries: the full picture, a middle size (720p from a
1080p or larger picture, 540p from a smaller one) and 360p. A small window
gets only the sizes that are smaller than it, and one of 360 lines or less
is always sent at one size. **Settings → Voice & Video → Screen Sharing →
Send my screen at several sizes**:

- **Automatic** (the default): several sizes when your computer encodes video
  on its graphics card and the quality you picked sends more than 4.5 Mbps
  (1080p at 30 fps, 720p at 60 fps and up). On a graphics card the extra
  sizes cost almost nothing; in software they cost a lot of CPU, so a
  computer without a hardware encoder sends one size, and if the encoding
  turns out to be in software after all the share goes back to one size by
  itself.
- **Always**: several sizes for every share, in software too. For when someone
  watching you keeps freezing and your computer has CPU to spare.
- **Never**: one size. For when your game stutters while you share.

Changing it while you share applies to that share at once. The extra sizes
add about 1.5-2.5 Mbps to your upload; if your upload is already the limit,
that comes out of the full-size picture, which stays as large and as smooth
but less detailed in fast motion, so on a slow upload **Never** keeps the
most detail for the viewers who can take it. A viewer on a slow connection
may start on 360p and move up to the middle size once their connection has
shown it can carry it, which took from ten seconds to a minute and a half in
testing.
Someone watching one or two streams gets the full picture whenever their
connection carries it. Someone on an older version of Púca gets the middle
size in the grid view until they update (Focus view still shows them the full
picture).

A connection can have the bandwidth and still lose packets (busy Wi-Fi, say),
and then the full picture freezes. So when a stream you watch keeps losing
more than about 1% of its packets, or freezes twice in a minute while it is
losing them (half a percent or more) or has to ask for a fresh picture, your
Púca asks for the next smaller size (the middle one, from a share at three
sizes), and goes back to the full picture once it has gone about a minute
without losing them. If it has to step down again soon after, it waits twice
as long before the next try, up to eight minutes, so the picture does not keep
switching. Other freezes change nothing: one with no real loss behind it comes
from the sharer's side or from a picture that simply stopped changing (slides,
code), and a smaller size would freeze too. Nor does anything change for a
share sent at one size, or one you are controlling.

In a channel that does not use SFU mode, each viewer is sent their own copy
of your share, at up to 8 Mbps each, whatever the quality.

### Viewing Streams
When someone shares, their entry in the voice view shows a **LIVE** badge and a
**Watch stream** button, and the stream plays once you click it. By default
that holds for every stream, a stream-only account's included (an automated
account a server owner has set up; see
[Stream-only accounts](STREAM_ONLY.md)). To have streams start playing by
themselves, choose which in **Settings → Voice & Video → Open streams
automatically**: **Off** (the default), **From stream-only accounts** or
**All streams** in your voice channel. Such a stream opens from the call's
view as the stream view, and from the chat in the small player. Each opens
once: close it and it stays closed until it starts again. A stream that opens
while you are already watching another is added beside it without moving your
view, and nothing opens by itself while your browser asks to save data. The
chat header also gains a **Watch live streams** button. Several streams can be
watched at once; **Switch to Grid View** / **Switch to Focus View** changes
the layout.

Opening a text channel or a DM while you watch keeps the stream in a small
player over the chat (docked under the header on a phone). Every stream you
watch stays audible wherever you are in the app, each at its own volume and
mute, a boost above 100% included, on an iPhone or iPad too; on Android it may
keep sounding while the app is in the background, as a call's voices do.
**Stream Attenuation** lowers streams in the stream view only. (In a browser
that cannot run Web Audio, and in Firefox and Safari while an **Output
Device** other than the default is chosen, the small player plays a stream at
100% at most.) While a stream is popped out (**Pop out**, below), the
small player shows the next stream you are watching instead of a second copy,
and hides when every stream you watch is popped out.

If a stream keeps freezing for you while it plays fine for others, your
connection is slower than what the stream sends, or is losing its packets (see
[How much a share sends](#how-much-a-share-sends)). In a channel that uses
SFU mode, a share sent at several sizes gives you a smaller copy by itself,
for either reason
(see [Several sizes](#several-sizes-for-viewers-on-slower-connections)); if
the sharer's computer sends one size, they can choose **Always** under
**Settings → Voice & Video → Screen Sharing → Send my screen at several
sizes**, or lower the stream's **Resolution** or **Frame Rate**. If it
stutters for everyone watching, the cause is on the sharer's side: their
voice panel offers them a lower **Frame Rate** when their share keeps losing
frames (see [Start Sharing](#start-sharing)).

### Stream Controls
Hover a stream for its buttons, or right-click it for the same items as a menu:

| Control | Action |
|---------|--------|
| **Mute stream** / **Unmute stream** | Silence that stream's audio (the menu row is **Mute**) |
| **Stream volume** (touch screens) | The speaker button on each stream, on a phone or tablet (where the right-click menu is hard to reach): opens that stream's own **Stream Volume** and **Mute**, and takes the place of **Mute stream** there. From the keyboard, Tab to a stream's buttons and press Enter on it |
| **Stream Volume** | In the menu, or behind the speaker button on a touch screen. That stream's own volume, 0–200% in 1% steps, with the level shown beside it; with the slider selected, the arrow keys move it 1% and Page Up / Page Down 10%. The slider follows loudness, so quiet levels are as easy to set as loud ones; above 100% boosts it. Each stream you watch has its own, and moving one never moves another. Kept on this device for the person sharing and used every time you watch them, in the stream view and the small player. Someone you have never set starts at the last level you set on anyone (100% before you have set any) and keeps that as their own |
| **Fullscreen** | Expand that stream to the whole screen |
| **Pop out (stays on top when Púca is tabbed out)** | In the desktop app: that stream in its own window (see **Pop-out windows**, below). In a browser, picture-in-picture where the browser supports it |
| **Stop Watching** | Remove it from your view |
| **Request Control** | Ask the sharer for keyboard and mouse control of their screen (or touch control of their phone, see [Control someone's phone](#control-someones-phone)); they must accept. While waiting, the stream's own button cancels the request; in the right-click menu the row reads **Control Requested…** and cannot be pressed |
| **Stream Attenuation** | Automatically reduce stream volume when people are talking |
| **Show Stream Stats** / **Hide Stream Stats** | Menu only. A live readout on the stream, refreshed every second: resolution, frame rate, video and audio bitrate, codec and whether it is decoded in hardware, packet loss, dropped frames and round trip |

Your own stream has **Stop sharing your screen** and, in the menu, **Stop
Sharing**, **Stream Quality** (the same panel as the arrow) and **Show Stream
Stats**. On your own stream the readout shows the
encoding side: what you are sending, whether it is encoded in hardware, and
what is holding the stream back (**Limited by**: CPU, bandwidth, or nothing).

### Pop-out windows (desktop app)
In the desktop app, **Pop out** puts that stream in a window of its own. Pop
out several streams and each gets its own window (up to eight; popping out a
ninth opens it in place of the oldest, which goes back to the app). Every
window can be dragged anywhere and resized to any size, up to the whole
screen; double-click its title bar to maximize it. The window title is the
name of the person sharing.

Hover a pop-out window for its two buttons:

| Control | Action |
|---------|--------|
| **Keep on top** | On (the default): the window stays above other windows. Off: it behaves like an ordinary window |
| **Back to Púca** | Close the window and put the stream back in the app (the window's own close button does the same) |

Púca remembers each window's size, place and **Keep on top** setting, even
if you quit Púca with the window still open: the first window you pop out
opens where the first one was last time, the second where the second was, and
so on. A window whose screen has been unplugged reopens on the screen Púca is
on. The sound of a popped-out stream still plays
from the app, at the volume and mute you set there. While a stream is in its
own window, the small player in the app does not show it a second time.
Leaving the call, or the sharer stopping, closes its window.

In a browser, and in the Android app, **Pop out** uses the browser's or the
phone's own picture-in-picture instead, which the system limits in size.

---

## My Devices — controlling your own computers

With the full app (not Lite), **Devices** lists the computers you have
signed in to; **Connect** on one shows its screen and lets you drive it with
your mouse and keyboard. How it works and what it cannot reach is in
[Remote screen control](REMOTE_CONTROL.md).

A computer set up to be controlled with nobody at it (unattended access, or
access to its lock screen, in **Devices → This device**) keeps Púca up to
date by itself: when a new version is out it installs it and restarts, but
only while nobody is connected to it, no call is going on in Púca there, no
file is being sent to or from it directly or uploaded from it, no message is
written there and not sent, nothing is shown full screen there (a film, a
game, a presentation), and nobody has used its keyboard or mouse for 10
minutes — and not in the first 2 minutes after it comes online or wakes up, so
you can connect to it first. It waits until it has been behind for a day and
the version it takes has been out for two hours, nothing appears on its screen
while it installs, and Púca comes back in the tray. To install updates
yourself instead, turn off **Keep Púca up to date on this computer while
nobody is connected** on that computer. Its sign-in-screen service is not
updated this way: Windows asks permission for that, so someone at the
computer has to click **Update the service** when Púca offers it.

### Power off

**Power off** on a Windows computer's card in **Devices** shuts that computer
down straight away, without opening its screen. It asks first, naming the
computer, because it is forced: Windows closes every app on it without asking
it to save, the way `shutdown /s /f /t 0` does, so anything unsaved there is
lost, in every account signed in to it, even while it is locked. **Shut
down…** in the session's **More** menu is the gentle one, which lets apps ask
to save first.

It works on a computer **set up for unattended access** (**Devices → This
device** on it): it asks for that computer's unattended passphrase first, as
**Control** does, and it works while that computer is locked or at its
sign-in screen too, when it has lock-screen access. A computer without
unattended access refuses it: it still asks whoever is there to let the
connection in, as it does for **Control**, but even if they do, they agreed to
a connection, not to losing their unsaved work, so it is not powered off. Use
**Control** and **More → Shut down…** there instead. If somebody signs in at a
locked computer before it powers off, or the computer locks first, it is not
powered off either, and the card says so; no other session is opened in its
place. Leaving **Devices** while it runs does not lose it: the card says how it
went when you come back.

The card then says how it went: that the computer is powering off, or why
not — it is offline (it may already be off), it runs a Púca too old to know
the command (update Púca on it, or use **Control** and then **More → Shut
down…**), it is in another remote session, it is not set up for unattended
access, the passphrase was not given or not accepted, or Windows refused.

It is a full shutdown, never Fast Startup's hybrid one, so **Wake & connect**
can start the computer again where Wake-on-LAN is set up (see *To wake this
computer from another device* on the Devices page).

A friend's computer shared with you **with control** has **Power off** too,
when it is set up for unattended access; one shared view-only or for files
only does not, and refuses it if asked. It is only offered for Windows
computers: a Linux computer, a phone and this device have no **Power off**.
The computer needs this version of the Púca desktop app; the button itself
arrives with the ordinary update.

### From a computer
The bar above the picture:

| Control | Action |
|---------|--------|
| **Screen** | Pick which screen to see, or **All displays**. **Fit the picture to this window (less lag)** asks for no more pixels than you can see. **Fullscreen** fills your monitor (also **Ctrl+Alt+Enter**). **Zoom** in and out (or **Ctrl**+wheel over the picture), **Fit** to go back; zoomed in, push the pointer against an edge of the picture to move along it. **Show stats** puts the live numbers over the picture. **Privacy mode (blank that computer's screen)**, and the display power actions: **Turn displays off**, **Turn displays off, keep primary**, **Turn displays on**, **Disable other displays**, **Re-enable displays** |
| **Quality** | From **Max (15Mbps, 60fps)** down to **Low (1Mbps, 15fps)**. The tick is what that computer confirmed |
| **Keyboard** | Keys your own computer would keep for itself: **Ctrl + Alt + Del**, **Alt + Tab**, **Alt + F4**, **Esc**, **Windows key**, **Windows + D (show the desktop)**, **Ctrl + Shift + Esc (Task Manager)**, **Print Screen**. **Pinned keys…** puts keys of your choice on the screen as buttons (see *Pinned keys* below). **Type text…** types what you write or paste there as characters, so an emoji, an accented letter or a password from a manager arrives exactly as it is, whatever keyboard layout that computer uses; new lines press Enter, and invisible control characters (a pasted text can hold some) are left out, with a note saying how many. **Type this computer's clipboard** opens it with your clipboard in it. **Send the clipboard (paste it over there)** puts your clipboard on that computer, for Ctrl+V there |
| **Mouse** | **Draw the pointer here (no delay)** (on by default): your own mouse pointer is drawn over the picture, so it moves with no delay at all, and it takes that computer's pointer shape — the text cursor over a field, the hand over a link, nothing while a game hides it; a marker shows where it was left while your mouse is off the picture. With an older Púca on that computer, which cannot tell this computer its pointer shape, that computer draws its own pointer as before. **Game mode (send mouse movement, for games)**: click the picture to capture your mouse, Esc lets it go. **Sensitivity** for Game mode |
| **Files** | Browse, download from and upload to that computer |
| **More** | **Lock**, **Shut down…** (asks first), **Copy diagnostics** (five seconds of numbers while you keep using it, for a problem report; if a step gets no answer — a clipboard prompt you cannot see, say — it says which instead of waiting), **Back to Púca (keep the session)** |
| The stats chip | Frames a second and the delay from your hand to the picture, measured once a second while you control (with a newer Púca on that computer; otherwise "~" and only your side's share). "relay" when the picture is not coming directly. Click it for **Show stats**, which also has **Compare with the old timing**: a few seconds of measurements both ways, to see the difference on your own computers |
| **Fullscreen** | Same as in **Screen** |
| **Pause control** / **Resume control** | Watch without driving; nothing you press goes over. Also **Ctrl+Alt+Home** |
| **Disconnect** | End the session |

Your mouse moves that computer's pointer as you move it, click and scroll as
usual. Every key goes to that computer, **Esc** included, except three:

| Shortcut | Action |
|---------|--------|
| **Ctrl+Alt+Home** | Pause or resume control |
| **Ctrl+Alt+End** | Ctrl+Alt+Del on that computer (your own computer keeps the real Ctrl+Alt+Del for itself) |
| **Ctrl+Alt+Enter** | Fullscreen |

In fullscreen, where the browser allows it, the Windows key and Alt+Tab go
over too; hold **Esc** to leave fullscreen in a browser.

The picture also tells you when your input cannot land:

- **"… is running as administrator, so Windows blocks remote control from
  clicking or typing in it"**: the window in front (or under the pointer) on
  that computer belongs to a program running as administrator, and Windows
  ignores remote clicks and keys aimed at it. Close it, or start it again
  without administrator rights; for a game, start Steam or its launcher
  normally rather than as administrator.
- **"A game on … has taken the mouse pointer"**: a game is using the mouse
  to look around, which ordinary pointer moves cannot do. **Use Game mode**
  captures your mouse and sends its movement instead.
- **"… runs an older Púca: the pointer is drawn there and can lag"**: that
  computer's Púca is too old to let yours draw the pointer, so it draws it
  into the picture itself, a round trip behind your hand (and over a screen
  that is not changing, it may not move at all). Update Púca on that
  computer. **Dismiss** puts the line away for that computer until Púca
  restarts. A phone shows it too.
- **"… shared screen went dark — is its lid closed?"**: the person at that
  computer shared one screen, and it went dark (its lid closed, most often)
  or was disabled. The picture never moves to a screen they did not share, so
  the session ends instead. Connect again with the lid open, or ask them to
  share another screen, or **All displays**. On a laptop with no other screen
  the picture follows a closed lid only with unattended access.
- A Windows security screen (the lock screen, an administrator prompt), a
  fullscreen app holding the pointer on another screen, and a laptop with its
  lid closed each have their own message.

### From a phone
The bar at the bottom: **Display** (screens, quality, **Scale the picture to
this screen (less lag)**, **Privacy mode (blank their screen)**), **Keyboard**
(the keyboard bar, with Ctrl, Alt, Shift and Win that stay down for the next
key, Esc, Tab, the arrows and the editing keys), **Mouse** (**Mouse mode** — the
screen is a trackpad — or **Touch mode** — the pointer goes where you tap;
**Show virtual mouse** for left, middle and right buttons and scrolling;
**Follow the cursor while zoomed**; **Zoom to the text cursor while typing**;
**Open the keyboard when a text box is tapped**; **Copy diagnostics**),
**More** (**Pinned keys…**, **Browse files**, **Send clipboard**, **Insert
Ctrl + Alt + Del**, **Alt + Tab**, **Alt + F4**, the display power actions,
**Lock**, **Shut down…**), **Chat**, **Collapse** and **Close**. In **Mouse
mode**: tap to click, long-tap to right-click, double-tap and move to drag,
move three fingers up or down to scroll, two fingers to move the picture,
pinch to zoom.

### Pinned keys
**Pinned keys…** (in **More** on a phone, in **Keyboard** on a computer) puts
keys you choose on the screen as buttons, in a row like the virtual mouse's,
in both Mouse and Touch mode. Pick a key — any letter or digit, **F1** to
**F24**, the arrows, **Enter**, **Esc**, **Tab**, **Space**, **Backspace**,
**Delete**, **Home**, **End**, **Page Up**, **Page Down**, **Insert**, the
number pad, **Print Screen**, **Menu**, the lock keys, a modifier on its own,
or **Ctrl + Alt + Del** — tick any of **Win**, **Ctrl**, **Alt** and
**Shift** to hold with it, and press **Pin it**. Up to twelve. Ctrl + Alt +
Delete chosen that way is pinned as **Ctrl + Alt + Del**, the only form of it
Windows acts on; **Win + L** cannot be pinned, because Windows does not lock
for it from another device (use **Lock** in **More**).

- A button presses its key while your finger (or mouse button) is down and
  lets go when you lift it, like a real key: tap it for a keystroke, hold it
  to hold the key. A held **Ctrl** (or any modifier) pin works with the
  keyboard bar too: hold it and type **c** for Ctrl + C. **Ctrl + Alt + Del** is sent when you let go, through the
  Púca service on that computer, as in the **More** menu.
- In the list, the arrows move a key up or down, the bin unpins it, and
  **Show pinned keys on the screen** hides the row without unpinning. Drag
  the row by its grip to where your thumb wants it.
- The keys stay pinned in that phone or browser, for every computer you
  control from it. They are hidden while control is paused and on a screen
  you were only invited to watch.
- **Media and volume keys** (play, pause, next, mute, volume) and **Pause /
  Break** cannot be pinned: Púca on the computer cannot press them yet.
  Symbols are sent by their place on a US keyboard, as the keyboard bar's
  are. On a **Linux** computer, Print Screen, Scroll Lock, Num Lock and Menu
  do nothing.

**In the notification (Android app).** Tick **In the notification** on up to
three pinned keys. While you control a computer, Púca's notification
(**Device session active**) has them as buttons, so you can press them from
any app — or with Púca in the background — without opening it. The
notification then says what the last press sent (**Last sent: F5**).

- They work only with the phone unlocked. A button pressed on the lock screen
  sends nothing while the phone stays locked: on Android 12 and later,
  Android asks you to unlock first and sends the key once you have; on older
  versions it waits two seconds for you to unlock, and otherwise sends
  nothing (unlock and press it again). If your lock screen hides sensitive
  notification content, the buttons do not appear there at all.
- They come off the notification while control is paused, and go away when
  the session ends. The notification itself goes too, unless Púca keeps it
  for another reason (**Connected** for background notifications, **In a
  voice call**).
- On Android 14 and later you can swipe the notification away; its buttons
  come back the next time you open Púca.
- If Púca's notifications are turned off in Android Settings the buttons
  cannot show; the list in **Pinned keys…** says so. Turning off only the
  **Remote control keys** notification category hides them too.
- This needs an Android app from after 0.9.859; with an older one the list
  has no **In the notification** boxes.

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
2. Under **Manage Roles** in their popup, tick or untick roles. The popup
   scrolls when it holds more than fits (many roles, or a small window); on a
   phone it opens as a card above the bottom bar, and tapping outside it
   closes it

### Permissions
The role editor groups them; the labels are: View Channels, Attach Files,
Add Reactions, Send Messages, Read Message History, Manage Messages, Add
Tasks, Complete Tasks, Manage Tasks, Connect, Speak, Video, Stream, Mute
Members, Move Members, Create Clips, Manage Channels, Manage Roles, Manage
Server, Kick Members, Ban Members, Create Invites, Switch Modes (turn a server
mode on or off, see *Server modes*), and Administrator (full access to all
permissions). Under **Automated Streaming**, the owner and
administrators also see **Stream only** and **No receive** (next section).

### Automated streaming accounts (Owner)
An account that only streams into calls (one run by automation, for example)
can be held to exactly that by the server:

1. In **Server Settings → Roles**, click **+ Stream Only Role**
2. Optionally tick **No receive** (nobody's audio or video is sent to it; the
   others still see its stream), then **Save Changes**
3. Under **Voice channels this role may stream in**, tick the voice channels
   it may join
4. Give the account that role, and no other

A member with **Stream only** can see, join and share its screen in those voice
channels and nothing else: no text channels, no messages, no invites, no
microphone (it joins without one). Only the owner or an administrator can set
or clear these two, and they cannot be put on @everyone. The details, and
what the encryption does and does not promise here, are in
[Stream-only accounts](STREAM_ONLY.md); the stable hooks automation can click
are in [Automation hooks](AUTOMATION.md).

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
- A **Deny** of View Channel holds for people with Manage Channels too. A
  channel they cannot see (on its own, or through its collection) is not in
  their list, and they cannot rename it, move it, delete it or change its
  permissions by any other way either: the server answers them as if it did
  not exist. To undo a deny that hides a channel from you, ask the owner, an
  administrator or someone who can still see it. Nor can they put a channel
  into a collection they cannot see.
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

#### Collections and permissions

A collection's permissions reach the channels inside it. The rule:

- **A cross on a collection is a cross on every channel inside it**, for the
  people it denies. Deny **View Channel** to @everyone on a collection and its
  channels are gone for everyone but the people you let past: they are not in
  their channel list, a number typed into the address is refused as a channel
  that does not exist, no message or notification from them arrives, and a
  voice room inside cannot be joined.
- **A tick on the channel itself takes it back**, for the roles it names. A
  channel inside a denied collection that allows View Channel to a role is
  visible to that role (its collection is not, so it is drawn on its own in the
  list), and nothing else the collection denies comes back with it.
- **A tick on a collection grants nothing inside it.** It only lifts the cross
  on the collection itself: a role allowed on the collection gets past the
  collection's own cross, so it keeps the channels that cross would have taken
  from it. Whatever a channel gives a member on its own rules and their roles
  stays exactly as it was.
- A tick on the channel takes a cross back whichever role it is on: if the
  collection crosses View for a role and the channel ticks it for @everyone, a
  member of that role sees the channel. Inside one channel a role's cross would
  win over @everyone's tick; between a collection and its channel the channel's
  own tick wins.
- Collections inside a collection are followed all the way up (the app draws
  one level). A collection cannot be put inside one of its own channels.
- Moving a channel into or out of a collection changes who can see it, and
  takes effect straight away like any permission change.

**What a cross does not undo.** Someone who could read a channel before you
denied its collection still holds the keys they were given for what was already
written there, and can still read that history in the app they already have it
in. The channel's key changes when you save the cross, so what is written
afterwards is closed to them. Before the server enforced this, a collection's
cross hid the channels only from the sidebar and members could reach them in
other ways: if you used a cross on a collection to keep something private,
treat what was written in it until then as seen by everyone who was on the
server.

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

## iPhone and iPad

There is no Púca app in the App Store. On an iPhone or iPad you add Púca's web
app to your Home Screen from Safari, and it opens full screen with its own icon.

1. Open your server's web address in **Safari** (the download page has an
   **Open Púca** button, and a QR code you can scan from a computer's screen).
2. Tap **Share**, the square with an arrow pointing up.
3. Tap **Add to Home Screen** (scroll down the list if you do not see it).
4. Tap **Add**. Open **Púca** from your Home Screen and sign in there.

It needs iOS 16 or newer. The Home Screen app keeps its own sign-in, separate
from Safari's, so you sign in once inside it, and **Stay signed in on this
device** starts ticked there (it is clear in a Safari tab).

### Install with one tap instead

The download page's iPhone section also has an **Install with one tap** button
(shown first to an iPhone or iPad). It hands your phone a small configuration
profile, and installing that puts the same Púca icon on your Home Screen without
the Share steps:

1. Tap **Install with one tap**, then **Allow** when Safari asks to download a
   configuration profile.
2. Open **Settings** and tap **Profile Downloaded** near the top (if it is not
   there: **General** → **VPN & Device Management** → **Púca**).
3. Tap **Install**, enter your passcode, tap **Install** again, then **Done**.
4. Open **Púca** from your Home Screen and sign in there.

**What the file contains, and nothing else:** one Home Screen icon named Púca
that opens your server's web app address full screen (Apple's *Web Clip*
payload, with the icon, **FullScreen** and **IsRemovable** on). No certificates,
no restrictions, no VPN, no second payload, nothing that lets anyone manage or
watch your phone. To remove it, press and hold the icon and choose **Remove App**,
or delete the profile under **VPN & Device Management**. The server makes the file
from its own address when the download page is published, so it points at that
server and nowhere else.

**Not Verified.** iPhone shows "Not Verified" for any profile that is not signed
with a certificate Apple trusts. This one is not signed: that needs a paid
certificate, and the operator's web certificate is the wrong kind and is replaced
every couple of months, so a signature on it would expire. Here it only means the
file cannot be vouched for by a third party, and the file can only add this one icon.

**Which to use.** The Share steps stay the recommended route. Apple's documentation
says a Web Clip with FullScreen on launches as a full-screen web app, but it
does not say that such an icon is the same as one added with Share, and it says
nothing about notifications for it. We have not been able to confirm on a real iPhone that the
one-tap icon has its own sign-in and storage, that Púca sees it as a Home Screen
app (the Home Screen behaviours above depend on that), or that it can receive
notifications. If something is off after the one-tap install, remove it and add
Púca with Share.

### Install as an app in Chrome or Edge

On a computer or an Android phone, the download page's **Install Púca as an app**
button (shown in Chrome, Edge and other Chromium browsers) opens Púca and shows a
small **Install Púca** banner at the top. Tap **Install** there and your browser
asks to install Púca as its own window with an icon; nothing is installed before
you tap. The **X** dismisses the banner and it stays away until you press the
download page's button again. It never appears in the Windows or Android app, in a
window that is already an installed app, on an iPhone or iPad, or in a browser that
cannot install web apps (Firefox, Safari).

Púca Notes: inside the Home Screen app there is no **Open in Púca Notes** button
in the Tasks view, because a window with no second window would replace Púca
(and drop a call you are in). Open `/notes/` on your server in Safari, or add Púca
Notes to the Home Screen on its own the same way; Notes then has no **Open Púca**
link either.

What is different from the Android and Windows apps:

- **Notifications while Púca is closed** need iOS 16.4 or newer, and only the
  Home Screen app can have them (Safari tabs cannot): open Púca from its icon and
  turn them on in **Settings → Notifications**. See *Notifications while Púca is
  closed* below. Your server has to have them set up too.
- **Calls.** Safari encrypts a call's sound and video frame by frame through
  the standard browser feature Firefox uses too, so with **Require encryption for
  calls** on (the default) you hear and are heard as on the other apps. Firefox
  runs the same code and has been tested; an iPhone has not been tried yet. If a
  call there shows that this browser cannot encrypt, Púca says so before you join
  and keeps your microphone, camera and screen out of the call rather than send
  them where your server could read them; turning the setting off in
  **Settings → Privacy & Safety** lets you take part with encryption in transit
  only. In channels that use SFU mode the call is encrypted by a different layer
  that Safari may support; that has not been tried on an iPhone either.
- **My Devices.** An iPhone cannot be controlled from elsewhere and cannot share
  its own screen. Controlling a Windows PC from it uses the same code as on
  Android; that has not been tried on an iPhone.
- **Watching a stream.** Turn the phone sideways and the stream fills the
  screen. Tap it to show or hide its buttons and the call's (mute, deafen,
  hang up); they hide by themselves after a few seconds, and any key brings
  them back. While you control a computer from the phone they stay put, above
  and below its screen. **Chat** goes back to the chat with the stream beside
  it. **Fullscreen** hands the stream to the
  iPhone's own video player, which also covers Safari's toolbars; **Done**
  brings it back. The stream's sound keeps playing at the volume you set in
  Púca, whatever that player's own speaker button shows.
- **Photos work.** Safari reads iPhone photos (HEIC) itself, so Púca turns one
  into a JPEG on the phone before sending it, without the location the camera
  saved with it.

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
- **The Android app updates itself** over the air. The account menu's
  **Version** row shows the update it is running and the app you installed,
  e.g. `0.9.830 (app 0.9.827)`. A strip *A new Púca Notes app (X) is
  available* appears only when a newer app changes something an update cannot
  bring; installing it is optional. Close the strip and it stays closed until
  an even newer app comes out — **Check for updates** does not bring it back.
  The menu still says a newer app is optional, with a **Get Púca Notes X**
  button when your server links its own download page.

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
  A new **note** opened that way is **today's note**: it is titled with
  today's date, and if that note already exists it opens instead, with the
  cursor at the end of its text. Closed without writing anything, it saves
  nothing.
- Click a note to open it. Inside, items work exactly as in Tasks: tick,
  edit, add subtasks, drag by the grip (the faint dotted handle at the left
  of the item) to reorder it or drag it to the right to nest it, set a due
  time from the clock, attach pictures from the paperclip.
  On a phone the open note keeps the top of the screen for the note itself:
  **Add to note** (the **+** at the bottom left) holds *Add photo*, *Add
  file*, *Take photo*, *Draw*, *Voice note* and *Show/Hide checkboxes*;
  **Labels** and **Archive** are in the **More** menu at the bottom right, and the **X**
  at the top closes the note. A computer shows them as before.
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

### Online, idle and away
The dot on someone's avatar (member list, Friends, the profile popup, user
search) says whether they are around:

| Dot | Tooltip | Means |
|---|---|---|
| Green | **Online** | Active on at least one device |
| Orange | **Idle** | No activity on any of their devices for 10 minutes |
| Orange "zz" | **Away** | No activity for an hour |

On the Windows desktop app, activity means input **anywhere on the PC** — so
someone playing a game with Púca in the background is not idle. In a browser
or on a phone it means using Púca itself; a phone with Púca in the background
or its screen off counts as inactive. Talking in a voice call counts as
activity on every device. Any activity turns the dot green again within a few
seconds — at once for activity in Púca itself, and within about 15 seconds for
input elsewhere on the PC.
A game controller on its own is not seen as activity on the PC.

**Settings → Privacy & Safety → Show when I'm idle or away** (on by default)
turns this off for you: you then show as plain online while connected.
**Show online status** off hides all of it — you appear offline. Voice
channels' AFK move (**Server Settings**) is separate and unchanged.

### Message notifications on a computer
In the **desktop app** (full and Lite) and in the **web app** while it is
open, a message that arrives while you are not using Púca (another window has
the focus, a game say) shows a notification: **Settings → Notifications →
Enable Desktop Notifications**. It names who wrote and where, never what they
wrote. While you are using Púca nothing shows; the in-app pop-ups do that job.

A conversation is **one notification that keeps count**, not one per message,
for each channel and each DM: *#general · Lads*, *alice and 2 others: 5 new
messages*.

- The first message pops it up. While the conversation goes on, each new
  message changes the same notification where it is, without popping it up
  again and without a sound: Púca's own message sound plays only when the
  notification pops up.
- After a quiet minute, the next message pops the same notification up again,
  still counting. So does the first message after you have been back in Púca
  and left again.
- A DM pops up for its first message and then at most once a minute while it
  goes on. An @mention of you does the same even in the middle of a busy
  channel (at most once a minute), when that channel is the one you have open
  in Púca. In another channel Púca cannot tell: its messages stay encrypted
  until you open it.
- Reading the conversation in Púca (opening it with the window in front)
  takes its notification out of the notification centre, and the count starts
  again. Clicking the notification while it is on screen opens that
  conversation.
- People joining a server are one notification per server in the same way.
- Muted servers and channels (including **Only @mentions**) and people you
  blocked still do not notify. The one exception, while notifications are
  grouped: under **Only @mentions**, a mention of you in the channel you have
  open does.
- **Group notifications by conversation**, under the same setting, is on by
  default. Off, every message has a notification of its own, as before.
- In the web app it is your browser that draws the notification, so how a
  replaced one looks is up to it.

### Notifications while Púca is closed
In the **web app** — Púca on your iPhone or iPad's Home Screen, or Púca in
Chrome, Edge, Firefox or Safari on a computer or an Android phone —
**Settings → Notifications → Notifications while Púca is closed** lets this
device show a notification when a message or a clip approval arrives while
Púca is not open. Tap the switch and allow notifications when the browser asks.
**Send a test** then sends one to this device.

- It names who wrote ("alice sent you a message"), never what they wrote.
  If Púca cannot reach your server at that moment, it says only **New activity
  in Púca**. Tapping a notification opens that conversation.
- Mutes and blocks on this device apply: a muted server (including one set to
  **Only @mentions**), a muted channel, or someone you blocked does not
  notify.
- A device where Púca is open is not sent one: it notifies by itself. Púca
  open somewhere else (the desktop app in the tray, say) does not stop this
  device being notified. A burst of messages is one notification.
- On an iPhone, a message in the first minute or so after you leave Púca may
  not notify; it is there when you open Púca.
- On an **iPhone or iPad** it needs iOS 16.4 or newer and works only in Púca
  added to your Home Screen. In a Safari tab the setting says so.
- The **desktop app** and the **Android app** have their own notifications
  and do not show this setting.
- If your server has not set it up, the setting says so; its operator needs
  a VAPID key (`.env.example`).
- It is your account's choice on this device: someone else signing in on the
  same browser has it off until they turn it on. Signing out turns it off;
  it also stops if your sign-in lapses (a day without **Stay signed in**).
- Your browser's push service (Apple, Google, Mozilla or Microsoft) learns
  that something arrived, when, and from which server, never who wrote or
  what; it may be able to guess that people woken together share a channel.
  `docs/PRIVACY.md` has the details.

---

## Discord in a window of its own (Windows desktop app)

For people you still talk to on Discord, the Windows desktop app can open
Discord's own website in a window of its own, without Discord installed.
[DISCORD.md](DISCORD.md) says how that window is kept apart from Púca, what
Púca can and cannot see, and the risks that remain.

**Turn it on:** **Settings → Advanced → Desktop App → Show Discord in the
server rail**. A **Discord** button appears in the server rail, above **Join a
Server**. It is off by default.

**Use it:** press the button and Discord's own page opens in its own window.
Sign in on Discord's page as you would in a browser (email or phone and
password, the QR code from Discord's phone app, or a passkey). From then on it
is Discord: your DMs, your servers, replying as yourself. It stays signed in.
Pressing the button again brings that window to the front; its size and place
are remembered. The title bar shows which site the window is on, for example
**Discord · discord.com**: there is no address bar.

**What Púca does there: nothing but open it.** Púca's code never runs in that
window, and Púca cannot read the page, your messages or your Discord sign-in.
Your Púca server never sees any of it: the window talks to Discord directly.
Your Discord sign-in is kept in a separate store on this PC.

- Discord's own pages stay in the window. A link to anything else (a YouTube
  link, a picture's **Open in Browser**, a help article) opens in your web
  browser. So does linking an account under Discord's **Connections**
  (Spotify, Xbox, ...): finish that in the browser, signed in to Discord
  there. A link that would start another program on your PC does nothing.
- It has no developer console: "paste this into the console" is how Discord
  accounts are stolen.
- Files you download from Discord go to your Downloads folder, as in Edge, and
  nothing opens by itself.

**Notifications.** The first time Discord asks to show notifications (its own
**Enable** banner, or **User Settings → Notifications** in Discord), Púca asks
whether to allow them, because the window has no question of its own for this.
Press **OK** and Windows shows Discord's notifications, straight from Discord's
page: Púca never sees them. **Cancel** (the default, so Enter allows nothing) is
not remembered, so Discord can ask again later. To stop them, turn them off in
Discord's own notification settings.

**Calls.** A Discord voice or video call works in that window: it asks for your
microphone and camera the usual way, and screen sharing uses the window's own
picker. Push to talk works only while the Discord window is focused (Discord's
own limit for its website), so use Voice Activity if you play with it in the
background. Púca's own streams never carry the Discord window's sound.

**Sign out and clear.** **Settings → Advanced → Desktop App → Sign out of
Discord and clear its data on this PC** closes the Discord window and deletes
what Discord keeps in it on this PC: your sign-in, cookies, cache and settings.
Files you downloaded stay where you saved them, and your Discord account is not
touched; you can sign in again later. To end the sign-in at Discord as well, use
**Log Out** in Discord first. Turning **Show Discord in the server rail** off
offers the same.

**Good to know.**

- Closing the window closes Discord. Quitting Púca does not close it: it is a
  window of its own. Installing a Púca update closes it; open it again
  afterwards.
- It works the same in **Púca Lite**.
- There is no Discord button in the web app or on phones. In a browser, a tab
  of Discord's own site does this better (Discord's page cannot be shown inside
  another site anyway), and on a phone Discord's own app does, with its own
  notifications.
- Púca shows no unread count from Discord: knowing it would mean reading
  Discord's page.

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

An invite link clicked outside Púca — in an email, another chat app, or Púca Notes' own page or Android app — opens the invite page in your browser. On a Windows PC that page can hand it to the desktop app; see below.

### Invite links clicked outside Púca
An invite link clicked somewhere else — an email, a web page, a game launcher, another chat program — opens the invite page in your web browser: Windows only lets a browser open a web link.
- On a Windows PC that page offers **Open in the Púca app** beside **Continue in the browser**. Your browser may ask whether to open Púca first; allow it. The desktop app comes to the front with **Join a Server** open and the invite already looked up. Nothing is joined until you click **Join Server**, and if the app is signed out the invite waits until you sign in
- Tick **Always open invites in the app** and invite links in that browser try the app straight away from then on, with **Continue in the browser** still one click away. Untick it to stop
- If nothing opens, the desktop app is not installed on that computer: install it (the page links **Get the desktop app** when the server publishes a download page), or continue in the browser
- An invite for a different Púca server than the one your desktop app uses is not looked up: the app says *This invite is for …, not the server this app is signed in to*. Accept it in the browser instead
- If the app cannot check which server an invite is for — its server is not answering (offline, or restarting), or does not publish its web address — it says *Could not check this invite* and looks nothing up. When the server was not answering, **Try again** checks again and opens **Join a Server** once it can; otherwise open the invite in the browser
- Some programs open links in a browser of their own — the overlay browser in Steam, for example — and those can refuse to hand a link to another app. Click **Continue in the browser** there, or copy the link into your normal web browser
- The button appears only in browsers on Windows: the Windows installer is the only one that registers Púca's `puca://` links. The Android apps and phone browsers always use the browser flow

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
**Voice & Video** to that mode. Bound to Space or Enter they press nothing in
Púca's window, except in a text box, where the key still types.

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
- Calls are encrypted end to end by default, and a browser that cannot do that (an older version, or a web view inside another app) is muted rather than carried in the clear — the indicator beside the peer names the reason. Update the browser — current Chrome, Edge, Firefox and Safari all encrypt calls — or use the Windows or Android app

### Screen share black screen
- Use the desktop app, or Chrome or Edge
- Try sharing the entire screen instead of a single window

### Send a problem report to the server owner
- When calls or streams misbehave, open **Settings → Advanced → Send diagnostics to the server owner**, or right-click the voice panel and choose **Send diagnostics to the server owner…**. Do it while the problem is happening, or soon after
- Pick the server whose owner should get it (the one you are in is picked first), optionally say what went wrong, and press **Send report**. It takes a few seconds, because it measures your call first
- The owner receives a text file in an encrypted direct message from you: the same measurements **Copy diagnostics** takes, your voice input mode and the keys you bound in **Keybinds** and, in the desktop app, the app's log (call and stream quality over the last hours, the names of programs whose audio you shared, and any program running as administrator that was in front during a call). No messages, passwords, addresses or anything you type are included: the only keys it names are the ones you bound. The Windows account name is removed from any file path
- On a phone or in a browser there is no log file, so the report holds the measurements and the hotkey settings only
