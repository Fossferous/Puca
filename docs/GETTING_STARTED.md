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

1. Open the Púca app, or your server's web address in a browser
2. Click **"Don't have an account? Register"**
3. Enter a username and password (and the server's invite code, if the owner
   set one)
4. Click **Create Account**

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

If you skipped past it: as long as you still know your password you can make
a new one under **Settings › My Account › Recovery code** (the old one stops
working at that moment). [`LOST_RECOVERY_CODE.md`](LOST_RECOVERY_CODE.md)
explains the other cases.

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

1. Click **Join a Server** at the bottom of the server list
2. Paste the invite link or code and click **Look Up Invite**
3. Check the server it names, then click **Join Server**

### Create Your Own Server

1. Click **Create a Server** at the bottom of the server list
2. Enter a server name (and upload an icon if you like)
3. Click **Create**

You are now the **owner** with full permissions!

---

## Customizing Your Profile

### Upload an Avatar

1. Click your name in the bar at the bottom of the channel list (tooltip **Edit Profile**)
2. Under **Avatar**, click **Upload Avatar**
3. Select an image
4. Adjust the crop, then click **Save Avatar**

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
2. Click **Add Reaction** in the hover toolbar
3. Select an emoji

### Attach Files
1. Click **Attach file** (the paperclip beside the message box)
2. Select a file
3. Send the message

---

## Voice Chat

### Join a Voice Channel
1. Click a voice channel (listed under **Voice Channels**)
2. Allow microphone access if prompted
3. You're now connected!

### Controls
- **Mute**: Click the microphone icon
- **Leave**: Click the disconnect button

---

## Managing Your Server (Owners)

### Create Channels
1. Hover the **Text Channels** or **Voice Channels** heading and click its **Create Text Channel** / **Create Voice Channel** button
2. Enter a channel name
3. Click **Create**

### Create Roles
1. Open **Server Settings → Roles**
2. Click **+ Create Role**
3. Set **Role Name**, **Role Color** and **Permissions**
4. Click **Save Changes**

### Assign Roles
1. Click on a member in the member list
2. Toggle role checkboxes in the popup

### Invite Members
1. Right-click the server in the rail and choose **Invite People**
2. Click **Generate Invite Link**
3. Click **Copy** on the new entry and share the link

### Upload Custom Emojis
1. Open **Server Settings → Emoji**
2. Under **Add Emoji**, click **Choose Image** and select a picture
3. Enter a name (e.g., `pepe`)
4. Click **Add**

---

## Tips

- **Owner badge**: a crown (tooltip **Server Owner**) marks the owner in the member list
- **Online status**: Green dot = online
- **Role colors**: Member names show their highest role color
- **DMs**: Click a user, then **Message** in their profile popup, for a private chat

---

## Troubleshooting

### "Failed to connect to server"
- Check that the backend is running (`cargo run --release`)
- Try refreshing the page
- Click **Sign out** and sign in again

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
