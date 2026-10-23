# Púca on the Steam Deck

**Púca for Steam Deck** is a plugin for Decky Loader. With it you can use
Púca in Game Mode, while a game is running:

- **Join a voice channel** from the Quick Access menu (the **···** button).
- **Mute, deafen or leave**, and see who is talking.
- **Push to talk** on one of the back buttons (L4, R4, L5 or R5).
- See **new messages pop up** over your game.
- **Open the whole Púca app** for text chat. Tap to type and the on-screen
  keyboard appears.

Everyone uses their own Púca account on their own Deck.

## What you need

- A Steam Deck, or another SteamOS device, that you can switch to Desktop Mode
  once for the install.
- Decky Loader **3.2.8 or newer**. Older versions do not start on the current
  Steam client, so no Decky plugin appears at all. Step 1 installs the current
  version.
- Your Púca account, and your Púca address: the one you open Púca at in a
  web browser, for example `chat.example.com`.
- A Púca server running version **0.9.846 or newer**. The plugin tells you if
  yours is older. Whoever runs your server can update it.
- Headphones or a headset are best. Without them the people you talk to may
  hear an echo of themselves from your Deck's speakers.

## Install it (once per Deck)

### 1. Install Decky Loader

Skip this step if your Deck already has Decky. Check by pressing **···**:
Decky shows a plug icon at the bottom of the list. If you installed Decky
before but the plug icon is missing, your Decky is too old for the current
Steam: do this step again. Your plugins and their settings are kept.

1. Press the **Steam** button, then **Power** → **Switch to Desktop**.
2. Open a web browser, go to **decky.xyz**, and download the installer.
3. Open the downloaded file. Choose **Release** when it asks, and follow the
   steps.
4. Double-click **Return to Gaming Mode** on the desktop.

### 2. Allow plugins from outside Decky's store

1. Press **···** and choose the plug icon (Decky).
2. Choose the **gear** (Decky's settings) → **General**.
3. Turn on **Developer mode**.

### 3. Install Púca for Steam Deck

The plugin is one file, `puca-decky-<version>.zip`. It comes with each Púca
release, or from whoever runs your server.

1. In Decky's settings, open **Developer**.
2. Choose **Install Plugin from URL**. Type the address of the zip file and
   choose **Install**.
   - If the file is already on the Deck, choose **Install Plugin from ZIP
     File** instead and pick it.
3. Confirm. **Púca** now appears in Decky's list, with an icon of two rings.

### 4. Sign in

1. Press **···** → the plug icon → **Púca**.
2. Type your Púca address and choose **Save**. The keyboard opens when you
   select the field; **Steam + X** opens it too.
3. Choose **Open Púca to sign in**. Sign in with your own account and tick
   **Stay signed in on this device**, so you only do this once.
4. Press **B** to go back.

## Use it

Press **···** → the plug icon → **Púca**.

- **Join a call.** Pick a voice channel under **Voice channels**. Each one
  lists who is in it. If you are in more than one server, choose the server
  first.
- **In a call.** **Mute**, **Deafen** and **Leave** are at the top. Below them
  is everyone in the call; a green dot means they are talking.
- **Push to talk.** In the panel's **Settings**, set **Push to talk** to a back
  button. Hold it to talk, in games too. Set it back to **Off** and Púca listens
  for your voice again. Some games use the back buttons too: pick one your game
  does not. It works with the Deck's own back buttons, not with a controller
  you plug in.
- **Messages.** Choose **Open Púca (messages)** to show the whole app. Tap
  where you want to type and the keyboard appears. Press **B** to go back to
  your game. A call keeps going while the app is hidden.
- **Notifications.** New messages pop up over your game. Tap one to open it.
  Turn them, or their sound, off in the panel's **Settings**. Which messages
  notify you follows your settings in Púca: muted servers and channels stay
  quiet.

## Good to know

- **The microphone** is on only while you are in a call. The panel shows
  **Microphone on** then. Steam itself does not let web pages use the
  microphone, so the plugin opens it in Steam and hands it to Púca inside the
  Deck. Púca encrypts your voice before it leaves the Deck, exactly as it does
  on a computer.
- **Push to talk reads the Deck's button itself.** Steam does not reliably
  tell plugins about the back buttons, least of all while a game is in front.
  So the plugin reads the one you picked straight from the Deck's controller,
  on the Deck, and only while you are in a call. Nothing about your controller
  leaves the Deck.
- **Nothing is opened to your network.** The plugin talks to Steam through a
  connection that exists only inside the Deck. Decky Loader turns that
  connection on, and the plugin needs nothing else.
- **Where the app comes from.** Like Púca in any web browser, the plugin loads
  Púca from your server each time it starts, so it is always the server's
  current version. The [security model](SECURITY_MODEL.md) explains what that
  means for trust. Your messages and calls are end-to-end encrypted as usual.

## If something is wrong

| You see | What to do |
|---|---|
| No plug icon under **···** | Decky Loader is missing, or older than 3.2.8 and unable to start on the current Steam. Do step 1 of the install again; your plugins and their settings are kept. |
| **This Púca server needs an update** | Your server's Púca is older than 0.9.846. Ask whoever runs it to update. You can still open Púca from the panel. |
| **Could not reach …** | Check the address under **Settings → Change Púca address**, and that the Deck is online. |
| **Waiting for Game Mode** | The plugin runs in Game Mode only. Switch back to Game Mode. |
| Nobody hears you | Check that **Push to talk** is set the way you want, and that the call does not say **Muted**. In Steam's **Settings → Audio**, check the microphone: with its volume at zero the Deck's microphone is muted, and Púca can only send silence. |
| Push to talk does nothing | While you are in a call, the line under **Push to talk** in the panel's **Settings** says if the plugin cannot read the Deck's controller. It works with the Deck's own back buttons, not with a controller you plug in. |
| Asked to sign in again | Steam sometimes clears the data of web pages it hosts. Sign in again, with **Stay signed in** ticked. |
| Anything else | **Settings → Reload Púca** in the panel starts Púca again. |

**To remove it:** Decky's settings → **Plugins** → **Púca** → **Uninstall**.

## Installing for someone else, over SSH

This is for whoever looks after the Decks. It is the same as step 3, done from
a computer. It needs the Deck's `sudo` password, and Decky Loader 3.2.8 or
newer already installed (steps 1 and 2 still happen on the Deck).

```bash
scp puca-decky-<version>.zip deck@<deck-address>:/tmp/
ssh -t deck@<deck-address> 'sudo rm -rf ~/homebrew/plugins/puca && sudo unzip -q /tmp/puca-decky-<version>.zip -d ~/homebrew/plugins/ && sudo systemctl restart plugin_loader && rm /tmp/puca-decky-<version>.zip'
```

Then do step 4 on the Deck. The plugin's own source and notes are in
`integrations/decky/`; [EMBEDDING.md](EMBEDDING.md) describes how it drives
the web client.
