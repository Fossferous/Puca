### Fixed

- **Edit no longer shows a file's key, or uncovers a spoilered file when saved.**
  Edit takes out exactly the files the message draws. A file after a stray
  backtick (`` `[file](sovereign-enc:…)``` ``) was left in the edit box, key and
  all, because Edit took that for code; and a spoilered file came back in the
  clear after a save when the words kept a `||` that nothing closed, or when a
  typed file address ran into the code after it, or when the spoilers of the
  message shared their bars. Each file is now drawn again where it was, and
  hidden if it was, and so are the words of each spoiler; nothing drawn as code
  or a link loses a character to Edit. Client only: the web app and a mobile
  update.
- **Previews, search and Quote no longer name a file the message hides.** Where
  a message's spoilers pair up other than the bars count
  (`_||[_](sovereign-enc:…)||[file](sovereign-enc:…)||`), the reply bar, the
  pinned list, search and Quote printed the name of a file the message keeps
  hidden. They now take which files are hidden from the message as it is drawn.
- **Words and emoji at a spoiler's edge beside a quote or code stay hidden.**
  A message whose spoiler ends right before a quote or a code block
  (`||⏎> l||:w8```||⏎````) printed words that 0.9.855 hid, as every version
  since had. Nothing 0.9.857, 0.9.855 or the version before them hid is printed
  now, emoji and symbols included; where no one reading hides all they did,
  everything from the first `||` to the last is one spoiler.

### Changed

- **A message is read once, not on every redraw of the chat.** The message
  list, mentions, link cards, previews and Edit share one reading of each
  recent message.
