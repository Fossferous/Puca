# Getting Started with Púca Chat

> **The canonical setup path is [`deploy/README.md`](../deploy/README.md)**
> (quick local try: the README's Quick start). This page is older prose;
> where they disagree, those win. Notably: the app now ships as TWO builds,
> Full and Lite (no remote-control code) — see the README's "Getting the
> app" section.
Welcome! This guide will help you set up and start using Púca.

---

## Quick Start

### 1. Create an Account

1. Open the application at `http://localhost:5173`
2. Click **"Don't have an account? Register"**
3. Enter a username and password (and the server's invite code, if the owner
   set one)
4. Click **Register**

You'll be logged in after registration — as soon as you have dealt with the
next step.

### 2. Save your recovery code

Right after registering, the app shows a **12-word recovery code** and will
not continue until you confirm you have saved it. Take that seriously:

- It is shown **once**. It is not stored anywhere, and nobody — not the
  server owner, not the developers — can look it up or generate it again for
  you.
- It is the **only** way to reset a forgotten password without losing your
  message history. Your messages are encrypted with keys only your devices
  hold; the code is the spare key.
- Write it down somewhere that is not the device you are signing up on, or put
  it in a password manager next to your password.

If you skipped past it: as long as you still know your password you are fine
day to day, but you have no spare key — [`LOST_RECOVERY_CODE.md`](LOST_RECOVERY_CODE.md)
explains exactly what that means and what to do.

### 3. Explore the Interface

After logging in, you'll see:

- **Left sidebar**: Server list (server icons)
- **Second column**: Channels in current server
- **Center**: Chat messages
- **Right sidebar**: Member list

### 4. Send Your First Message

1. Click on a text channel (e.g., `# general`)
2. Type in the message box at the bottom
3. Press **Enter** to send

---

## First Steps

### Join a Server

If someone gave you an invite code:

1. Click the **+** button at the bottom of the server list
2. Select "Join Server"
3. Enter the invite code
4. Click **Join**

### Create Your Own Server

1. Click the **+** button in server list
2. Select "Create Server"
3. Enter a server name
4. Choose a template (or start fresh)
5. Click **Create**

You are now the **owner** with full permissions!

---

## Customizing Your Profile

### Upload an Avatar

1. Click **👤** in the server header
2. Click **"Choose file"**
3. Select an image
4. Click **Upload Avatar**

Your avatar now appears in:
- Messages you send
- Member list
- User popups

---

## Chatting

### Send Messages
- Type and press **Enter**

### Multi-line Messages
- Press **Shift+Enter** for new line

### Format Your Text
```
**bold** → bold
*italic* → italic
||spoiler|| → hidden text (click to reveal)
`code` → monospace
```

### Mention Users
- Type `@username` to notify someone

### Add Reactions
1. Hover over a message
2. Click the **➕** button
3. Select an emoji

### Attach Files
1. Click **📎** next to message input
2. Select a file
3. Send the message

---

## Voice Chat

### Join a Voice Channel
1. Click on a voice channel (🔊 icon)
2. Allow microphone access if prompted
3. You're now connected!

### Controls
- **Mute**: Click the microphone icon
- **Leave**: Click the disconnect button

---

## Managing Your Server (Owners)

### Create Channels
1. Click **+** next to "Text Channels" or "Voice Channels"
2. Enter channel name
3. Click **Create**

### Create Roles
1. Click **🛡️** in server header
2. Click **"+ Create Role"**
3. Set name, color, and permissions
4. Click **Save**

### Assign Roles
1. Click on a member in the member list
2. Toggle role checkboxes in the popup

### Invite Members
1. Click **📩** in server header
2. Click **Create Invite**
3. Copy and share the code

### Upload Custom Emojis
1. Click **😎** in server header
2. Upload an image
3. Enter a name (e.g., `pepe`)
4. Click **Upload**

---

## Tips

- **Owner badge**: 👑 appears next to server owner
- **Online status**: Green dot = online
- **Role colors**: Member names show their highest role color
- **DMs**: Click a user → "Send Message" for private chat

---

## Troubleshooting

### "Failed to connect to server"
- Check that the backend is running (`cargo run --release`)
- Try refreshing the page
- Click "Logout" and login again

### Can't create channels/roles
- Only server owners or users with permissions can do this
- Check if you have the required role permissions

### Voice not working
- Allow microphone permissions in browser
- Check your system audio settings

---

## Need Help?

- **Lost your recovery code or your password:** [`docs/LOST_RECOVERY_CODE.md`](LOST_RECOVERY_CODE.md)
- **What is collected and who can see what:** [`docs/PRIVACY.md`](PRIVACY.md)
- **Endpoints and wire formats:** [`docs/API_REFERENCE.md`](API_REFERENCE.md)
- **Setting up a server (canonical):** [`deploy/README.md`](../deploy/README.md)
- **What the encryption does and does not protect:**
  [`docs/SECURITY_MODEL.md`](SECURITY_MODEL.md)
- **Reporting a vulnerability:** [`SECURITY.md`](../SECURITY.md)
