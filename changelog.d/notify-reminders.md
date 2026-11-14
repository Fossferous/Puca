### Fixed

- **A task reminder in the desktop app makes a sound, and clicking it opens Reminders.** It used to
  come up silent, and a click on it did nothing. Now it plays Windows' notification sound, and a
  click on it while it is on screen opens the Tasks view on its **Reminders** tab (from the
  notification centre afterwards, a click may only bring Púca's window up). Needs the new desktop
  app (full and Lite). In the web app, a reminder that comes while the last one is still listed now
  pops up and sounds again in Chrome and Edge, where it used to replace the old one in silence.
- **With Púca's notifications turned off in Windows, you still hear every message.** While a
  conversation went on, Púca played its message sound only for the first message, as if the
  notification was showing, when Windows was showing nothing at all. Now every message plays it
  then, and, while **Group notifications by conversation** is on (the default), **Settings →
  Notifications → Send test** says Windows has Púca's notifications turned off, or refused the
  test, instead of reporting success. Needs the new desktop app.
- **In Firefox and Safari a busy conversation no longer pops a notification for every message.**
  Those browsers show a replaced notification as a new one, popping it up again, so the web app's
  quiet updates were not quiet there. Now the notification keeps its words until the conversation
  pops it again.
- **A conversation with more than 50 people writing says "more than 49 others".** It used to stop
  at "49 others" however many more wrote.
