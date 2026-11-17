# npm advisories — triage

The Rust side has had this discipline since `.cargo/audit.toml`: an advisory is
either fixed or listed here with a written reason and a trigger that would make
it matter again. Nothing is dismissed silently, and "it's only a dev dependency"
is not a reason on its own — it is the beginning of one.

**This file is a snapshot, not a live count.** `npm audit` resolves against a
registry that changes daily, so the set below is what a `npm audit` in
`frontend/` returned on the date at the top of the table, from that day's
`package-lock.json`. A number frozen into a document is stale the moment it is
written, which is why the README stopped quoting one for Semgrep. What is
durable is the reachability reasoning: each row says what would have to be true
for the advisory to reach a user, and you can check every claim by reading the
code and the dependency path it names.

CI runs `frontend/scripts/check-npm-advisories.mjs` in the frontend job, and it
**blocks** on exactly one thing: a high or critical advisory against a package
with no row in the table below. It used to be `npm audit || true`, non-blocking
so the registry's daily churn could not fail a merge, with the log meant to make
drift visible; the log drifted from this table for two weeks and nobody looked,
because a step that cannot fail is a step nobody reads. Drift within a triaged
package (new identifiers on the same dependency path) and rows for packages no
longer reported are printed as warnings — refresh or delete the row in the next
change that touches this file. A registry that cannot be reached warns rather
than fails.

Reproduce with:

```bash
cd frontend
npm audit --json          # the raw set
npm ls <package> --all    # the path that pulls it in
```

## Snapshot — 2026-11-17, from `frontend/package-lock.json`

`npm audit` in `frontend/` reports nothing, at any severity, so the table has
no rows. Every row of the previous snapshot (2026-09-16, `zod` added
2026-10-24) was cleared by an update inside its parent's range, with no
`overrides` entry: `@xmldom/xmldom` 0.9.12, `browserslist` 4.29.6, `js-yaml`
4.3.2, `nanoid` 3.3.20, `postcss` 8.5.33, `tar` 7.5.23 and `zod` 4.6.7. The
main and Notes web bundles built from that lock are byte for byte the ones
built from the lock before it. The rows' reachability reasoning is in this
file's history.

| Advisory | Package | Path | Ships to users? | Why it is not reachable | Re-evaluate when |
|---|---|---|---|---|---|

## Standing recommendation

Everything above is development-time only and clears itself whenever eslint,
vite or `@capacitor/cli` are next bumped. Do not pin transitive dependencies to
chase them — an override that outlives its advisory becomes its own liability.

The one entry that shipped to users — `react-router-dom` in RSC mode
(GHSA-qwww-vcr4-c8h2) — is gone: the app is on 7.18.3, past the fixed 7.18.2.

## How to add a row

State the dependency path (`npm ls <pkg> --all`), whether the package ends up in
a shipped bundle, and the specific reason the vulnerable path is not entered —
then name the change that would make it reachable. "Dev dependency" alone is not
a reason: a compromised build tool ships whatever it likes inside the artifact
the users install.
