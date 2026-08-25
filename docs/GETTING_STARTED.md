# Getting Started with Púca Chat

Welcome! This guide will help you set up and start using Púca.

---

## Quick Start

### 1. Create an Account

1. Open the application at `http://localhost:5173`
2. Click **"Don't have an account? Register"**
3. Enter a username and password
4. Click **Register**

You'll be automatically logged in after registration.

### 2. Explore the Interface

After logging in, you'll see:

- **Left sidebar**: Server list (server icons)
- **Second column**: Channels in current server
- **Center**: Chat messages
- **Right sidebar**: Member list

### 3. Send Your First Message

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
- Check that the backend is running (`cargo run`)
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

Check `.agent/HANDOFF.md` for technical details and API documentation.
