### Fixed

- **Fullscreen in the Android app is the picture and nothing else.** A stream
  or a camera put in fullscreen in the Android app could keep parts of Púca
  around or over the picture (the voice bar and the stream header), the
  phone's status and navigation bars stayed, and in some cases its button
  never turned into an exit, while Android's Back closed the app and the
  call with it. Now fullscreen fills the whole screen with only that picture
  and its own buttons, hides Android's bars (a swipe from the edge shows
  them), and its Exit fullscreen button or Android's Back gives the layout
  back with the call still going. That holds in Focus view with several
  streams too, where the picture used to stop short of the bottom of the
  screen, and for a stream from the row of small ones under it put in
  fullscreen from its menu, which was dimmed and had no Exit fullscreen
  button. Controlling a shared screen while it is
  fullscreen, on any phone, puts Stop controlling above the picture and the
  call's buttons below it, never over the top or the bottom of the other
  screen. This comes with the update; no new install is needed.
