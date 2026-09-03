<!--
Security fixes do NOT go in a public PR. See SECURITY.md — private reporting
first, so a fix and its disclosure land together.
-->

## What this changes, and why

<!-- The problem first. A diff explains what; only you can explain why. -->

## How you know it works

<!--
Not "it builds". What did you actually observe, and what would have to break
for your test to go red? This project has repeatedly contained tests that
could not fail — assertions on emptiness that pass when the request errored,
`status < 500` passing on a 401. If you added a test, saying that you watched
it fail before the fix is the most useful sentence in this PR.
-->

## Gates

<!-- CI runs these too; ticking them locally just saves a round-trip. -->

- [ ] `cd frontend && npm run typecheck` — **not** `npx tsc --noEmit`, which
      checks nothing here (solution-style tsconfig)
- [ ] `cd frontend && npx vitest run`
- [ ] `cd frontend && npm run build`
- [ ] `cd frontend && npm run lint` — must exit 0
- [ ] `cargo test` at the repo root
- [ ] If you touched anything under `crates/`, `frontend/src-tauri/` or
      `frontend/android/`, the suite for that component too — `CLAUDE.md` lists
      them

## Checklist

- [ ] I have read [CLA.md](../CLA.md) and am happy with §2, which lets the
      maintainer license the project under other terms in future
- [ ] No secret, key, `.env`, server address, SSH target or personal path is in
      this diff
- [ ] If this adds a setting, it also adds the control that changes it — a
      stored value with no UI is a feature nobody can use
- [ ] If this changes behaviour that a document describes, the document is
      updated in the same commit
- [ ] Any new user-facing string says something true when the thing it
      describes fails

## Anything you are unsure about

<!--
Genuinely useful. "I could not work out whether X was deliberate" saves the
reviewer the same hour you just spent, and is not a weakness in the PR.
-->
