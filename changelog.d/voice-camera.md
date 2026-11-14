### Fixed

- **Turning your camera off and on no longer freezes it for the others.** In
  a call without the media server, everyone else's tile of you stayed on your
  last picture, or went black, once you had turned your camera off and on.
  Your camera now goes back out the way it went before, and the camera of
  somebody still on an older version is shown live too, also after they flip
  it.
- **"Voice Connected" waits until you are connected.** On a channel whose
  calls go through the media server, the voice panel said "Voice Connected"
  while it was still connecting, with no sound in or out yet. It now says
  "Connecting…" until the call's sound and pictures can flow.
- **Your speaking ring goes out when you switch voice channel.** Switching
  while you were talking left your green ring lit in the next channel (for
  good if you were muted or in an AFK channel) and kept every stream you
  were watching turned down under it.
- **The camera menu and Full screen are easier to use.** While a camera is
  being switched, the menu's cameras and Flip are greyed out instead of
  doing nothing when pressed; a webcam plugged in during a call appears with
  its Flip and camera menu at once; the keyboard's place is kept when your
  picture goes full screen and back, or the camera is turned off; and in
  Settings > Voice & Video > Camera, a camera chosen before that is not
  listed today can be chosen again instead of falling back to Default.
- **A camera switch that cannot reach a media-server call says so.** If your
  new camera could not be sent to the call, your camera stayed "on" with
  nothing reaching anyone. It is now turned off, with a line saying why;
  turn it on again to send it.
- **Settings no longer opens a microphone you joined without.** In a call
  you joined with no working microphone, saving any setting (choosing a
  camera, a checkbox) tried to open a microphone again whenever Input Volume
  was not at 100%, which could bring back the permission question each
  time. Only picking a microphone does that now.
- **Switching cameras right after turning one on works in Firefox.** Under
  "Require encryption", a switch in the first moments of a camera could fail
  because the old camera was still held open.
