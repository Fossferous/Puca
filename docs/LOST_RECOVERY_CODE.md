# I lost my recovery code — what now?

When you registered, Púca showed you a **12-word recovery code** exactly once
and would not continue until you confirmed you had saved it. That code is the
only way to reset your password **without losing your message history**, and
it cannot be shown again or recovered by anyone — not by the server owner, not
by the developers — because the server never holds it. This page is the honest
account of what that means, drawn from how the app actually works.

There are three situations.

## 1. You lost the code but still know your password

Make a new one now: **Settings › My Account › Recovery code**. You prove
your current password, the app mints a fresh 12-word code, re-wraps the same
keys under it and shows it to you once — nothing about your history changes.
The old code stops working the instant the new one is created, so if you
suspect the old one leaked this is also the fix. Save the new code the way
you should have saved the first.

Until you do that you are fine day to day (signing in and changing your
password both keep your keys), but you have no spare key: a forgotten
password would put you in situation 2. Put the password in a password
manager, then make the new code.

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
