# Contributing to Púca

Thanks for considering it. A few things that'll save you time.

## Before you open a PR

- **Sign the CLA.** The first PR from any GitHub account gets a bot comment
  asking you to confirm you've read [CLA.md](CLA.md). It's a one-time thing
  per account, not per contribution. Read §2 of that document in particular —
  it's the part that matters (it lets the maintainer relicense the project in
  the future, including commercially; your own rights to your own contribution
  are unaffected).
- **Run the gates locally first.** CI runs the same ones; failing them on a
  PR just costs you a round-trip.
  ```bash
  cd frontend && npm run typecheck && npx vitest run && npm run build && npm run lint
  cargo test                                   # repo root package only
  ```
  `CLAUDE.md` has the full gate list, including the crates and Android suites,
  and — importantly — some traps that have bitten before (a solution-style
  `tsconfig.json` means a bare `tsc --noEmit` checks nothing here; use
  `npm run typecheck`).
- **Security issues do not go in a public PR or issue.** See
  [SECURITY.md](SECURITY.md) for private reporting.

## What kind of PRs land easily

- Bug fixes with a test that fails before the fix and passes after.
- Documentation corrections — including "this doc says X, the code does Y."
- Small, scoped features discussed in an issue first. This is currently a
  single-maintainer project; a large unsolicited PR is more likely to sit
  than a conversation that establishes the approach first.

## Code style

Match what's already there rather than introducing a new convention —
`CLAUDE.md` documents the project's working agreement (branching, gates,
standing rules) in detail; skim it before your first PR.

## Reporting bugs

Open an issue with: what you expected, what happened, and — for anything
crypto/security-adjacent — which adversary the bug needs (an honest server
operator? a malicious one? another user? physical access?). Severity here
depends almost entirely on that.
