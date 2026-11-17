### Fixed

- **Jump to latest always ends at the newest message.** When the other side's typing
  indicator came up, or the message box grew a line, while the jump was in its last
  stretch, it stopped up to 31 px short and stayed there. It now goes all the way, and a
  reader who scrolls up during the jump is still left where they scrolled to.
- **Links in messages are readable on every theme.** On Dark, Pink and Purple a link was
  under the contrast words need, at rest and under the pointer (3.5 to 4.2:1); it is now
  the theme's brand colour made for words, as on Light. So are the other words drawn in
  the brand colour (a name with no role colour, who a reply answers, the typing dots, a
  note's links, a search hit's name) and the initials on avatars.
- **White words on filled buttons are readable on the Purple, Green, Orange and Yellow
  themes.** Their brand colour was too bright for the white words on it (2.9 to 4.2:1): it is
  now a deeper shade of the same colour, held to the rule a server mode's accent already
  follows. Settings' and the profile's Save and Upload buttons, which had dark words on the
  brand, have white ones like every other brand button.
- **The device list's red buttons (Revoke, Sign this device out, Reset) are readable.** Their
  white words were 3.7:1 on every theme but Light; the red is now one that carries them.
