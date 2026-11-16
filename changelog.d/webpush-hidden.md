### Fixed

- **The web app on a phone notifies as soon as you switch away from it.** With
  **Notifications while Púca is closed** on, a message that arrived in about the
  first minute after you left Púca on an iPhone, iPad or Android phone showed no
  notification at all: the phone had already paused Púca, but its connection
  stayed up for another minute or so, so your server took Púca to be open and sent
  no push. Púca now tells your server the moment it goes to the background, so that
  message notifies, and it shows no second notification of its own; back on screen
  it says so again, and the open app shows what arrives. Needs this release of both
  the web app and your server; a desktop browser's hidden tab keeps notifying by
  itself as before.
