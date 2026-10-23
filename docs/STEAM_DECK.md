# Púca on the Steam Deck

**Púca for Steam Deck** is a plugin for Decky Loader. With it you can use
Púca in Game Mode, while a game is running:

- **Join a voice channel** from the Quick Access menu (the **···** button).
- **Mute, deafen or leave**, and see who is talking.
- **Push to talk, mute and deafen** on the back buttons (L4, R4, L5, R5).
- **Share your screen** into the call: everyone in it sees your game.
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

Your Púca server's download page has it, under **Púca for Steam Deck**,
with the address to type. It ends in `/steam-deck/puca-decky.zip`.

1. In Decky's settings, open **Developer**.
2. Choose **Install Plugin from URL**. Type the address from the download
   page, for example `https://download.example.com/steam-deck/puca-decky.zip`,
   and choose **Install**.
   - If the file is already on the Deck, choose **Install Plugin from ZIP
     File** instead and pick it.
3. Confirm. **Púca** now appears in Decky's list, with an icon of two rings.

You do this once. After that the plugin keeps itself up to date.

### 4. Sign in

1. Press **···** → the plug icon → **Púca**.
2. Type your Púca address and choose **Save**. The keyboard opens when you
   select the field; **Steam + X** opens it too.
3. Type your username and password under **Sign in to Púca** and choose
   **Sign in**. Leave **Stay signed in** on, so you only do this once.
   - To create an account or reset a forgotten password, choose **New
     account or forgotten password: open Púca** instead, and press **B** to
     come back.
   - If the panel shows **Open Púca to sign in** instead, your server's Púca
     is older: sign in there, with **Stay signed in on this device** ticked.

## Use it

Press **···** → the plug icon → **Púca**.

- **Join a call.** **Live now** lists the voice channels with people in
  them, on every server you are in: pick one to join them. **Voice channels**
  lists all of a server's channels, with who is in each; if you are in more
  than one server, choose the server first.
- **In a call.** **Mute**, **Deafen** and **Leave** are at the top. Below them
  is everyone in the call; a green dot means they are talking.
- **Share your screen.** In a call, choose **Share screen**: everyone in the
  call sees your game, end-to-end encrypted like the rest of the call. Choose
  **Stop sharing** to end it. While this menu is open they see **Paused**;
  close it and your game is back within a second or two. The picture is
  1280x800 at 30 frames a second, without sound.
  - If you press **Share** in the full Púca app instead, the plugin asks you
    first: a notice pops up, and **Share screen** in this panel answers it.
  - The panel shows **Share screen** only when your server's Púca can share
    from the Deck (version 0.9.848 or newer).
- **Back buttons.** Under **Settings**, each of these can have a back
  button. Choose **Choose** (or **Change**) next to one, then press the back
  button you want:
  - **Push to talk**: hold it to talk. Off, Púca listens for your voice.
  - **Mute**: press it to mute or unmute.
  - **Deafen**: press it to deafen or undeafen.

  They work in games too, and a small notice over the game says "Muted",
  "Unmuted" and so on. A back button does one thing: give it to another one
  and the panel says which lost it. To take a button away, choose **Change**,
  then **Turn … off**. Some games use the back buttons too: pick ones your
  game does not. They work with the Deck's own back buttons, not with a
  controller you plug in.
- **Messages.** Choose **Open Púca (messages)** to show the whole app. Tap
  where you want to type and the keyboard appears. Press **B** to go back to
  your game. A call keeps going while the app is hidden.
- **Notifications.** New messages pop up over your game. Tap one to open it.
  Turn them, or their sound, off in the panel's **Settings**. Which messages
  notify you follows your settings in Púca: muted servers and channels stay
  quiet.
- **Updates.** When a new version is out, **Update** appears at the top of the
  panel. Choose it and confirm, and Púca restarts on the new version. It waits
  until you are out of a call. The bottom of **Settings** shows the version
  you have.

## Good to know

- **The microphone** is on only while you are in a call. The panel shows
  **Microphone on** then. Steam itself does not let web pages use the
  microphone, so the plugin opens it in Steam and hands it to Púca inside the
  Deck. Púca encrypts your voice before it leaves the Deck, exactly as it does
  on a computer.
- **A muted microphone is switched on for calls.** If the Deck's microphone
  is muted in Steam's settings when a call starts, Púca switches it on for the
  call (and turns it up if it was all the way down), says so over your game,
  and mutes it again when you leave. Anything you change during the call
  stays as you left it. Turn this off under **Settings → Turn the microphone
  on for calls**.
- **A silent microphone is noticed.** If the microphone still sends only
  silence, the panel says so and a notification pops up over your game,
  instead of you talking to nobody.
- **The plugin reads the Deck's controls itself, during calls.** Steam does
  not reliably tell plugins about them, least of all while a game is in front.
  The plugin uses two things:
  - the back buttons you gave a job, held or not;
  - whether any control is being touched or pressed, never which. Púca uses
    that to keep you in the call while you play without talking. Otherwise it
    would move you to the AFK channel, as it does with anyone idle.

  This happens on the Deck only. Nothing about your controller leaves it.
- **Others see you as active while you play.** During a call, the Deck's
  controls count as you being there, for your idle and away status as well
  as for the AFK channel. Outside a call the plugin does not read the
  controls, so while Púca is hidden you show as idle.
- **Signing in from the panel.** Your password goes from the panel to Púca
  inside the Deck, through the plugin, once. It is never stored or written to
  a log, and it is handed to Púca as a value, never as part of a script. Púca's
  own sign-in then works as it always does: it sends the server a proof of
  the password, never the password itself.
- **A shared screen shows your game, and nothing of Steam's or Púca's.** The
  share starts only when you choose **Share screen** in the panel. While any
  of these is on screen, the picture pauses and the call sees **Paused**
  instead:
  - the Quick Access menu or the Steam menu;
  - the on-screen keyboard, so a password typed on it never shows;
  - a notification, such as a message popping up;
  - Púca's own full view;
  - Steam itself: the library, the store, or Steam's pages over your game.
    With no game running there is nothing to share, so it stays paused.

  If the plugin cannot tell whether one of these is on screen (after a Steam
  update, say), it pauses rather than guess. The Deck's own video engine
  encodes the screen, as Steam's game recording does; Púca then sends it like
  any shared screen. Nothing is recorded: the picture exists only on its way
  into the call.
- **If your encryption keys did not unlock.** The panel says so at the top,
  as the full app's banner does: messages can't be read on the Deck, and calls
  may not be end-to-end encrypted, until you put it right in Púca. Choose
  **Open Púca** to do that.
- **Nothing is opened to your network.** The plugin talks to Steam through a
  connection that exists only inside the Deck. Decky Loader turns that
  connection on, and the plugin needs nothing else.
- **Where the app comes from.** Like Púca in any web browser, the plugin loads
  Púca from your server each time it starts, so it is always the server's
  current version. The [security model](SECURITY_MODEL.md) explains what that
  means for trust. Your messages and calls are end-to-end encrypted as usual.
- **Where updates come from.** The plugin itself runs inside Steam, with more
  reach than a web page, so it is held to more. It looks for new versions on
  your Púca server's download site, and installs one only when it is signed
  with the release key of whoever runs your server, which is kept off the
  server. Someone who broke into the server could change the web page it
  serves, but could not hand your Deck a plugin update.

## If something is wrong

| You see | What to do |
|---|---|
| No plug icon under **···** | Decky Loader is missing, or older than 3.2.8 and unable to start on the current Steam. Do step 1 of the install again; your plugins and their settings are kept. |
| **This Púca server needs an update** | Your server's Púca is older than 0.9.846. Ask whoever runs it to update. You can still open Púca from the panel. |
| **Could not reach …** | Check the address under **Settings → Change Púca address**, and that the Deck is online. |
| **Waiting for Game Mode** | The plugin runs in Game Mode only. Switch back to Game Mode. |
| Nobody hears you | Check that **Push to talk** is set the way you want, and that the call does not say **Muted**. In Steam's **Settings → Audio**, check the microphone: with its volume at zero the Deck's microphone is muted, and Púca can only send silence. **Turn the microphone on for calls** in the panel's **Settings** does that for you. |
| A back button does nothing | Choose the button again in the panel's **Settings**, by pressing it. While you are in a call, the line under each back button says if the plugin cannot read the Deck's controller. They work with the Deck's own back buttons, not with a controller you plug in. |
| Moved to the AFK channel while playing | Your server's Púca may be too old to know about the Deck's controls: ask whoever runs it to update. The plugin reads only the Deck's own controls, so playing with a controller plugged in does not count. |
| No **Share screen** in a call | Your server's Púca is older than 0.9.848, or your Steam is too old to show a shared picture. Ask whoever runs the server to update. |
| The call sees **Paused** while you play | Something besides your game is on screen: a menu, the keyboard, a notification, Púca, or Steam's own pages. Go back to the game; the picture returns within a second or two. |
| **Your screen share stopped** | The message says why. The Deck must be in Game Mode, with its screen on. Choose **Share screen** to start again. |
| No **Update**, though the download page has a newer version | The plugin looks a little after Púca starts and then every six hours. Your server's Púca may be too old to tell it where the download page is: ask whoever runs it to update. Meanwhile, installing from the address again (step 3) updates it too. |
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
