### Changed

- **Auto Gain Control is off by default in the web app.** In a browser, auto
  gain can turn down your system microphone level (on Windows, the input level
  in Sound settings), and the level stays low after the call; it once took
  three microphones down to 7.8 %. A web page cannot stop the browser doing
  that, so in the web app (any browser, and the iPhone and iPad Home Screen
  app) **Settings › Voice & Video › Auto Gain Control** now starts off, with
  the reason beside it, and Manual Gain sets your level. A web profile that
  still had the old default is switched off once, with Manual Gain at 100 %;
  switch it on again if you want it, and that choice is kept. The desktop app and the Android app keep
  it on, as before: there it never changes your microphone's own level.
  Arrives as an ordinary update.
- **Back from a game, you turn green again within about 3 seconds.** While the
  desktop app has you down as idle it now checks for input anywhere on the PC
  every 3 seconds instead of every 15, so the dot others see turns green again
  about 3 seconds after you touch the mouse or keyboard. Arrives as an ordinary
  update.
- **A tablet is called your tablet.** "You're in Lounge on your tablet", "You
  moved the call to your tablet": a touch screen whose shorter side is 600
  pixels or more is now named a tablet, held either way, and anything smaller
  is still your phone. Needs the new server and the new app on both devices;
  until then a tablet is called your phone, as before.
