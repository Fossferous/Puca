### Fixed

- **A busy server no longer tells the app that a picture does not exist.**
  When the server's database was slow to answer, asking it for a profile
  picture, server icon, emoji or attachment could be answered "no such file",
  which the app believes, so the picture stayed missing. The server now
  answers "try again in a moment" whenever it could not check, and keeps "no
  such file" for files that are really gone or that you may not see. Deleting
  a file while the server is busy is refused the same way, where before it
  could remove a picture that was still in use. This is a server update.
