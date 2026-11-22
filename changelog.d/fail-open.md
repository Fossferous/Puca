### Fixed

- **A busy database no longer answers "not found" or waves a request through.**
  When the server could not look something up for a moment, many
  routes answered as if the answer were "no": "Channel not found" for a
  channel that is there, a clip prompt dropped as "no longer waiting", a
  sign-in that refused your own encryption identity as "not the one this
  server publishes for you", and an edit to a Púca Notes note thrown away as
  "did not save" after "List not found". Some answered with an empty list
  instead: a channel or DM shown with no messages (and marked read), a
  search that stopped early, and a reminder feed with a channel's reminders
  left out, which made Púca Notes cancel their alarms until the next
  refresh. Others let the request past a check they could
  not make: an upload past your storage quota, a moderator's kick, ban,
  timeout or role change reaching the server owner, a blocked person's
  reaction to a DM, a message through slowmode. Each now answers "try again
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
  failed OPEN when their lookup failed. They fail closed now
  (docs/SECURITY_MODEL.md, section 12). Server update only.
