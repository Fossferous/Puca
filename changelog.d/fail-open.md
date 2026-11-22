### Fixed

- **A busy database no longer answers "not found" or waves a request through.**
  When the server could not look something up for a moment, many
  routes answered as if the answer were "no": "Channel not found" for a
  channel that is there, a clip prompt dropped as "no longer waiting", a
  sign-in that refused your own encryption identity as "not the one this
  server publishes for you", and an edit to a Púca Notes note thrown away as
  "did not save" after "List not found", and a server's channel list refused
  as "Not a member of this server". Some answered with an empty list
  instead: a server shown with no channels until the next refresh (and its
  owner shown only what a plain member sees), its unread marks and who is in
  voice left out, a collection's feed with nothing in it, a channel or DM
  shown with no messages (and marked read), a
  search that stopped early, and a reminder feed with a channel's reminders
  left out, which made Púca Notes cancel their alarms until the next
  refresh, or a channel's encryption keys served as none, so its messages
  showed as unreadable and a send was refused as "can't send securely".
  Deleting a collection was refused as "also holds channels you cannot see",
  reordering channels or calling everyone back answered as done having done
  nothing, a mode's channels were refused as "not on this server", and Manage
  Channels read as "missing".
  Others let the request past a check they could
  not make: an upload past your storage quota, a moderator's kick, ban,
  timeout or role change reaching the server owner, a blocked person's
  reaction to a DM, a message through slowmode, and a voice channel switched
  between its two kinds of call without ending the call in it, which left the
  people in it in two halves that could not hear each other. Each now answers "try again
  shortly" (503 with `Retry-After`) and changes nothing, and trying again
  gets the real answer; the apps already take it as a passing error, not a
  "no". Comes with the server update; no app update is needed.

### Security

- **A check the server cannot make now refuses the request.** Owner and rank
  protection for kick, ban, timeouts, custom sounds and role changes, the
  storage quota and clip-part cap, slowmode, the report, verification-mail
  and password-reset limits, the reaction and checklist caps, the DM block on
  reactions, the write-once identity key, the "you still own servers" check
  on account deletion and the history-key check on a new recovery code all
  failed OPEN when their lookup failed. And a channel whose keys could not be
  read was served as a channel with no keys yet, which could lead a device
  that had not opened the channel before back to an old channel key that
  someone removed from the channel still holds. They fail closed now
  (docs/SECURITY_MODEL.md, section 12). Server update only.
