### Fixed

- **Pictures that failed to load once come back by themselves.** A profile
  picture, server icon or custom emoji that could not be fetched once (the
  server busy for a moment, a dropped connection) stayed as initials or a
  blank until the app was restarted, while everyone else saw it. Now the app
  tries again after a short wait, and if the server or the network is still
  away, again when you are back online, return to the app or it reconnects.
  The app also asks for fewer pictures at once, so a busy server is less
  likely to turn them away in the first place. This comes with the update; no
  new install is needed.
