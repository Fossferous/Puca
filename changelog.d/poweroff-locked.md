### Fixed

- **A locked computer stops asking for its passphrase every time.** Power
  off, Control or Files on a computer that was locked, at its sign-in screen,
  or had just restarted or been woken asked for the sign-in screen's
  passphrase again, even though the app had remembered it, while the same
  computer signed in did not ask. The app forgot it after a week without a
  connection to the sign-in screen itself, however often you used that
  computer otherwise. Now using the computer either way keeps both of its
  passphrases remembered; only a week of not reaching it at all, a
  passphrase the computer refuses, or a new one set on it makes the app ask
  again. The sign-in screen's passphrase is still its own, so the first time
  it is needed it is still asked for, once. This comes with the update; no
  new install is needed.
