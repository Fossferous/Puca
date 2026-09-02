# I lost my recovery code — what now?

When you registered, Púca showed you a **12-word recovery code** exactly once
and would not continue until you confirmed you had saved it. That code is the
only way to reset your password **without losing your message history**, and
it cannot be shown again or recovered by anyone — not by the server owner, not
by the developers — because the server never holds it. This page is the honest
account of what that means, drawn from how the app actually works.

There are three situations.

## 1. You lost the code but still know your password

You are fine day to day: sign in as usual, and change your password from
Settings whenever you like — a password change keeps your keys and history
and does not touch the recovery code.

What you have lost is the safety net. **In the current build there is no way
to mint a new recovery code for an existing account.** The server-side
endpoint for it exists, but no screen in the app calls it yet, so until that
ships the mitigation is simple: do not lose your password. Put it in a
password manager now.

If a future release adds "Generate a new recovery code" under Settings, use it
the day it appears; this paragraph will then be out of date, and the release
notes will say so.

## 2. You lost the code and forgot your password

The account's encryption seed is stored on the server only in two wrapped
forms: one that opens with your password, one that opens with the recovery
code. Without either, the seed — and every message, direct message,
attachment and checklist encrypted under keys derived from it — is
unrecoverable. This is by design (see [`SECURITY_MODEL.md`](SECURITY_MODEL.md)
§2: the server cannot read your content, so it cannot hand it back to you
either).

Your options:

- **Password reset by email**, if the server owner configured email and you
  verified an address. That resets the *login*, and it does **not** preserve
  history: the app will mint a fresh identity and you will not be able to read
  anything from before. Friends will see your safety number change.
- **A fresh account.** Ask the server owner for the invite code again; your
  old username stays taken by the old account unless the owner removes it.

Either way, the old conversations are gone for you (other participants keep
their copies).

## 3. You have the code but it is not accepted

- Enter all twelve words, lowercase, separated by single spaces, in the order
  they were shown. Extra spaces or line breaks are fine; a swapped word is
  not.
- Check the username: the code is tied to the account it was generated for.
- If you changed your password at some point, the same code still works — a
  password change does not rotate it.

If it still fails, the code you have is not the one this account was created
with, and situation 1 or 2 applies.

## For the next account

The moment the code appears, write it down somewhere that is not the device
you are signing up on, or store it in a password manager next to the password.
It is twelve ordinary English words; a photo of the screen is fine as long as
the photo is not your only copy.
