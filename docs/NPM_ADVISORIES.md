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

## Snapshot — 2026-09-16, from `frontend/package-lock.json`

Nothing here reaches a Púca user. Every entry is either a build/lint-time
dependency that never ships in a bundle, or a runtime dependency whose
vulnerable code path this app does not enter.

| Advisory | Package | Path | Ships to users? | Why it is not reachable | Re-evaluate when |
|---|---|---|---|---|---|
| [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6) and twelve siblings against the same 0.8.x line ([GHSA-27p8-2357-5qqv](https://github.com/advisories/GHSA-27p8-2357-5qqv), [GHSA-3px3-54cx-rmw9](https://github.com/advisories/GHSA-3px3-54cx-rmw9), [GHSA-4w3w-2rp5-g8jm](https://github.com/advisories/GHSA-4w3w-2rp5-g8jm), [GHSA-6h8r-xr42-gp59](https://github.com/advisories/GHSA-6h8r-xr42-gp59), [GHSA-6mj3-qw4j-hgrw](https://github.com/advisories/GHSA-6mj3-qw4j-hgrw), [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6), [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9), [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g), [GHSA-c7q8-3ch8-vqpv](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv), [GHSA-g53g-w8rj-fmg7](https://github.com/advisories/GHSA-g53g-w8rj-fmg7), [GHSA-vr34-hp96-76pp](https://github.com/advisories/GHSA-vr34-hp96-76pp), [GHSA-w2rr-34g9-rvrj](https://github.com/advisories/GHSA-w2rr-34g9-rvrj)) | `@xmldom/xmldom` | `@capacitor/cli → plist → @xmldom/xmldom` | no | XML fragment injection during serialization. `@capacitor/cli` uses `plist` to read and write the iOS project's own plists; the input is this repository's files. | a build step ever feeds Capacitor a plist from an untrusted source |
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895), [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v) | `brace-expansion` | `eslint → minimatch`, `typescript-eslint → …`, `@capacitor/cli → rimraf → glob → minimatch` | no | All DoS-by-expansion in glob patterns. The patterns come from `eslint.config.js`, `tsconfig`, and the tools' own defaults — all in-tree, none user-supplied. A hang here stops a build, it does not reach a user. | a glob pattern is ever built from input the repo does not control |
| [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx), [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) | `browserslist` | `@vitejs/plugin-react → @babel/core → …` | no | Unbounded cache growth, and a crash on a hostile `browserslist-stats.json`. Both are build-time, in a process that exits when `vite build` finishes; there is no custom stats file in this repo. | a `browserslist-stats.json` is added, or one arrives with a dependency |
| [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj), [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) | `js-yaml` | `eslint → @eslint/eslintrc → js-yaml` | no | Quadratic CPU in `!!omap`. eslint parses YAML config from this repo. No YAML from any other source reaches it. | eslint config is ever generated from untrusted YAML |
| [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | `nanoid` | `vite → postcss → nanoid` | no | Infinite loop for a negative or zero `size`. postcss calls it with its own constant for source-map identifiers; nothing in this app calls `nanoid` at all (`grep -r nanoid frontend/src` is empty). | the app takes a direct dependency on `nanoid` |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | `postcss` | `vite → postcss` | no | `sourceMappingURL` path traversal reading arbitrary `.map` files. It runs at build time on this repo's own CSS, on the machine doing the build, which already has those files. | CSS from an untrusted source is ever processed by the build |
| [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) | `tar` | `@capacitor/cli → tar` | no | Stack-overflow DoS from a crafted long-path tar. `@capacitor/cli` untars its own downloaded platform assets during `cap sync`. | Capacitor is ever pointed at a tarball from an untrusted source |

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
