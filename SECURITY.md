# Security policy

Púca is self-hosted chat with end-to-end encrypted messages, attachments
and media, and it ships a remote-desktop agent. The blast radius of a bug here
is somebody's private conversations or somebody's computer, so reports are
genuinely welcome — including ones that say the design is wrong rather than
that a line of code is.

## Reporting a vulnerability

**Please use GitHub's private reporting** — the *Security* tab → *Report a
vulnerability*. That opens a private advisory only you and the maintainer can
read, which is the right venue for anything exploitable.

Please do **not** open a public issue for an exploitable bug until there is a
fix available.

What helps, roughly in order of usefulness:

- The commit you looked at (`git rev-parse HEAD`), since line numbers move.
- Which adversary the bug needs — a malicious server operator, an ordinary
  authenticated user, someone on the network path, a stolen session token, an
  already-compromised machine. Severity here depends almost entirely on this,
  and a bug that requires "attacker already has root on the victim's box" is a
  different animal from one an ordinary member can trigger.
- What you actually observed, versus what you inferred.

There is no bounty. This is a one-person project.

### Response

Expect an initial reply within a week. If a report is confirmed you will be
credited in the fix commit unless you would rather not be. If it is refuted you
will get the reasoning, because a well-argued "not exploitable" is worth as
much as a confirmation and you should be able to check the argument.

## Supported versions

The latest release only. There are no maintenance branches — the desktop app
auto-updates and the mobile client takes signed OTA bundles, so the fix path is
forward.

## What is already known

Read these before reporting; they will tell you whether something is a finding
or a documented trade-off:

- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) — the honest
  version, written for someone who does not trust the project. It states the
  weaknesses as plainly as the strengths, including which parts of the test
  suite CI never runs.
- [`docs/E2EE.md`](docs/E2EE.md) and
  [`docs/E2EE_RECOVERY.md`](docs/E2EE_RECOVERY.md) — the design and its limits.
- The `docs/AUDIT_*.md` files — prior audits with their findings, and the ones
  that were refuted.

Several properties are **known limits, deliberately accepted**, and are
documented rather than hidden: trust-on-first-use for identity keys (so first
contact is substitutable), no forward secrecy for message history, an SRP
verifier that is offline-crackable from a database dump, and metadata — who
talks to whom, and when — that the server necessarily sees. Reports of these
are welcome as *design* discussion, but they are not news.

## Scope

**In scope:** the backend, the web and desktop clients, the Android client, the
remote-desktop agent and the native crates, the E2EE and key-custody design,
and the update/OTA signature paths.

**Out of scope:** the maintainer's own deployment and its infrastructure.
Please do not test against a server you do not run — stand up your own, or use
the throwaway-database harnesses in `tests/` and `frontend/e2e/`. Findings
against your own instance are exactly as valid and nobody gets hurt.

Denial of service via simply sending a lot of traffic is also out of scope; a
DoS that a single cheap request can trigger is not.
