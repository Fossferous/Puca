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

### Mention Users and Channels
- Type `@` and pick from the **MEMBERS** list that appears
- Type `#` and pick from the **CHANNELS** list
- `@everyone` and `@here` are highlighted as mentions

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

### Voice Controls
The voice panel's buttons, by tooltip:

| Tooltip | Action |
|---------|--------|
| **Mute** / **Unmute** | Stop or resume sending your microphone. Reads **Push to talk — hold your key to speak** in push-to-talk mode, and **No microphone detected — listen-only mode** if there is none |
| **Deafen** / **Undeafen** | Stop hearing everyone, which also mutes you |
| **Noise suppression** | A picker, not a button: choose the microphone filter — **No suppression**, **Standard** or **RNNoise (ML)**. **DeepFilter (Max)** is listed too once **DeepFilterNet noise suppression** is ticked under **Settings → Advanced** |
| **Turn On Camera** / **Turn Off Camera** | Share your webcam |
| **Share Screen** / **Stop Sharing** | See [Screen Sharing](#screen-sharing) |
| **Disconnect** | Leave voice |

On a phone the less-used buttons sit behind **More voice controls**.

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

1. Join a voice channel
2. Click **Share Screen** in the voice panel. A **Screen Share** dialog asks for **Resolution**, **Frame Rate** and, in the desktop app, **Audio to share**
3. Click **Select Screen & Go Live →** and pick a window, screen or tab in the picker that opens
4. Sound: in the desktop app, choose **Selected apps** under **Audio to share** before step 3; after the picker, tick the apps whose audio the stream should carry, then click **Go Live →** — closing the dialog instead shares nothing. In a browser, tick **Share audio** in the browser's own picker — the app cannot tick it for you

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

Your own stream has **Stop sharing your screen** and, in the menu, **Stop Sharing**.

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
1. Click **Join a Server** at the bottom of the server rail
2. Paste the link or code and click **Look Up Invite**
3. Click **Join Server**

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

### Voice not working
- Check the microphone permission for the app or site
- Open **Settings → Voice & Video** and check the input device
- Calls are encrypted end to end by default, and a browser that cannot do that (Firefox, Safari, iOS) is muted rather than carried in the clear — the indicator beside the peer names the reason. Use the desktop app, or Chrome or Edge

### Screen share black screen
- Use the desktop app, or Chrome or Edge
- Try sharing the entire screen instead of a single window
