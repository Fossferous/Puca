### Fixed

- **Jump to latest always ends at the newest message.** When the other side's typing
  indicator came up, or the message box grew a line, while the jump was in its last
  stretch, it stopped up to 31 px short and stayed there; on the desktop a long jump (a
  few screens) could do the same anywhere after its first 0.8 seconds. It now goes all the
  way, and a reader who scrolls back up during the jump, with the wheel, a finger, the
  scrollbar or the keyboard, is left where they scrolled to.
- **Links in messages are readable on every theme.** On Dark, Pink and Purple a link was
  under the contrast words need, at rest and under the pointer (3.5 to 4.2:1); it is now
  the theme's brand colour made for words, as on Light. So are the other words drawn in
  the brand colour (a name with no role colour, who a reply answers, the typing dots, a
  note's links, a search hit's name) and the initials on avatars. A revealed spoiler's box is
  the theme's deepest surface, so a link in one holds too (it was a blurple wash).
- **A done task's words are readable on every theme.** It was faded, which took its links,
  quotes and code under 4.5:1 on the dark and colour themes (as low as 1.7:1); it is now
  drawn in the muted colour with its line through, as on Light.
- **White words on filled buttons are readable on the colour themes.** On Purple, Green,
  Orange and Yellow the brand colour was too bright for the white words on it (2.9 to 4.2:1):
  filled buttons, selected tabs and badges now take a deeper shade of the same colour,
  held to the rule a server mode's accent already follows, and a mode's accent still
  colours them. The composer's Send and Create Channel no longer fade into a pale lavender
  under their white words (Light keeps its own), and buttons that brightened or faded under
  the pointer darken instead. Settings' and the profile's Save and Upload buttons, which had
  dark words on the brand, have white ones like every other brand button.
- **The device list's red buttons (Revoke, Sign this device out, Reset) are readable.** Their
  white words were 3.7:1 on every theme but Light; the red is now one that carries them.
