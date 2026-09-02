# Púca User Guide

Welcome to Púca! This guide covers all features.

---

## Getting Started

### Creating an Account
1. Open `http://localhost:5173` in your browser
2. Click **"Don't have an account? Register"**
3. Enter username and password (and the invite code, if the server owner set one)
4. Click **Register**
5. **Save the 12-word recovery code** the app now shows. It appears exactly
   once and cannot be recovered by anyone; it is the only way to reset a
   forgotten password *without losing your encrypted messages*. Write it down
   or store it in a password manager, then confirm — and you're logged in.

### Forgot your password?
On the sign-in screen, choose **"Forgot your password? Use your recovery
code"**: enter your username, the twelve words, and a new password. Your keys
and history are kept. Without the code, see
[`LOST_RECOVERY_CODE.md`](LOST_RECOVERY_CODE.md) — an email reset (if the
server has email set up) gets you back in but does not recover old messages.

### Interface Overview
```
┌─────────┬──────────────┬─────────────────────┬──────────────┐
│ Servers │  Channels    │    Chat Area        │   Members    │
│         │              │                     │              │
│   🏠    │  # general   │  Messages appear    │  👑 Owner    │
│   🎮    │  # random    │  here...            │  • User1     │
│   ➕    │  🔊 Voice    │                     │  • User2     │
│         │              │  [Type message...]  │              │
└─────────┴──────────────┴─────────────────────┴──────────────┘
```

---

## Servers

### Create a Server
1. Click **➕** at bottom of server list
2. Choose "Create Server"
3. Enter server name
4. Click **Create**

### Join a Server
1. Click **➕** at bottom of server list
2. Choose "Join Server"
3. Enter invite code
4. Click **Join**

### Server Settings
1. Click **⚙️** in server header
2. Change name, upload icon
3. Click **Save**

---

## Messaging

### Send a Message
- Type in the input box and press **Enter**
- For multi-line: **Shift+Enter** for new line

### Format Text
| Syntax | Result |
|--------|--------|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `~~strike~~` | ~~strike~~ |
| `` `code` `` | `code` |
| `\|\|spoiler\|\|` | Blurred until clicked |

### Mention Users
- Type `@username` to mention someone
- Type `@everyone` to ping all members

### Edit/Delete Messages
- Hover over your message
- Click ✏️ to edit, 🗑️ to delete

### Attach Files
1. Click **📎** next to input
2. Select file
3. Send message

### Paste Images
1. Copy image to clipboard
2. **Ctrl+V** in chat
3. Preview appears, click **Send**

---

## Reactions

### Add a Reaction
1. Hover over any message
2. Click **➕** button
3. Select emoji from picker

### React with Custom Emojis
- Custom server emojis appear in "Server Emojis" tab
- Click to add as reaction

### Remove Reaction
- Click your existing reaction to toggle it off

---

## Voice Chat

### Join Voice
1. Click on a voice channel (🔊)
2. Allow microphone access
3. You're connected!

### Voice Controls
| Button | Action |
|--------|--------|
| 🎤 | Mute/unmute mic |
| 🔊 | Deafen (mute all audio) |
| 🖥️ | Share screen |
| 📴 | Leave voice |

### Mute vs Deafen
- **Mute**: Others can hear you, but you're silent
- **Deafen**: You hear nothing AND are muted

---

## Screen Sharing

### Start Sharing
1. Join a voice channel
2. Click **🖥️** button
3. Select screen/window/tab
4. Check **"Share audio"** for game/app sound

### Viewing Streams
When others share:
1. Checkboxes appear for each streamer
2. Toggle which streams to watch
3. Multiple streams display in grid

### Stream Controls (Right-Click)
| Option | Action |
|--------|--------|
| 🔇 Mute | Mute that stream's audio |
| 🔳 Fullscreen | Expand to full screen |
| ❌ Hide | Remove from your view |

---

## Roles & Permissions

### View Roles (Everyone)
1. Click on a member's name
2. See their role badges in popup

### Manage Roles (Owner/Admin)
1. Click **🛡️** in server header
2. Click **"+ Create Role"**
3. Set name, color, permissions
4. Click **Save**

### Assign Roles
1. Click on member name
2. Toggle role checkboxes in popup

### Permission List
- View Channels
- Send Messages
- Manage Channels (create/delete)
- Manage Roles
- Kick/Ban Members
- Administrator (all permissions)

---

## Direct Messages

### Start a DM
1. Click on any user in member list
2. Click **"Send Message"** in popup
3. DM channel opens

### DM Conversations
- Active DMs appear in sidebar
- Click to open conversation

---

## Friends

### Open Friends Panel
- Click **👥** in server header

### Add Friend
1. Click on user in member list
2. Click **"Add Friend"** in popup
3. Wait for them to accept

### Manage Requests
1. Open Friends Panel (👥)
2. See pending requests
3. Click ✓ to accept, ✕ to reject

---

## Profile & Settings

### Upload Avatar
1. Click **👤** in server header
2. Click **Choose file**
3. Select image
4. Click **Upload Avatar**

Your avatar appears in:
- Your messages
- Member list
- Profile popups

---

## Custom Emojis

### Upload Emoji (Owner)
1. Click **😎** in server header
2. Click **Choose file**
3. Enter emoji name (e.g., `pepehype`)
4. Click **Upload**

### Use Custom Emojis
- Available in reaction picker
- Appear under "Server Emojis" tab

---

## Invites

### Create Invite
1. Click **📩** in server header
2. Set expiry (optional)
3. Set max uses (optional)
4. Click **Create**
5. Copy and share the code

### Use Invite
1. Click ➕ in server list
2. Enter invite code
3. Click **Join**

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Escape` | Close modals |
| `Ctrl+V` | Paste image |

---

## Troubleshooting

### Can't connect to server
- Check backend is running (`cargo run`)
- Click **Logout** and login again
- Clear browser cache

### Voice not working
- Check microphone permissions
- Try a different browser
- Refresh the page

### Screen share black screen
- Use Chrome or Edge
- Try sharing "Entire Screen" instead of window
