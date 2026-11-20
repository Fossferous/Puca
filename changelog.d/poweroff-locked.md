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
- **A locked computer asks for the right passphrase.** When a computer was
  locked or at its sign-in screen, the box asking for its passphrase said
  "Unattended passphrase", though what it needs then is the passphrase set
  for its sign-in screen. If you had chosen different words for the two, you
  typed the wrong one, and Power off said the unattended-access passphrase
  was not accepted. The box now asks for the **Passphrase for the sign-in
  screen** by that name and names the computer, and Power off says which
  passphrase was not accepted. This comes with the update; no new install is
  needed.
