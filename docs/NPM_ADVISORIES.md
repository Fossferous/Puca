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

CI runs `npm audit --audit-level=high` **non-blocking** (`|| true`) in the
frontend job, so drift is visible in the log without gating merges on a
third-party registry. When the log and this table disagree, this table is out of
date — update it in the same change that notices.

Reproduce with:

```bash
cd frontend
npm audit --json          # the raw set
npm ls <package> --all    # the path that pulls it in
```

## Snapshot — 2026-09-02, from `frontend/package-lock.json`

Nothing here reaches a Púca user. Every entry is either a build/lint-time
dependency that never ships in a bundle, or a runtime dependency whose
vulnerable code path this app does not enter.

| Advisory | Package | Path | Ships to users? | Why it is not reachable | Re-evaluate when |
|---|---|---|---|---|---|
| [GHSA-p498-v437-472g](https://github.com/advisories/GHSA-p498-v437-472g) | `@humanfs/node` | `eslint → @humanfs/node` | no | Recursive copy following symlinks, inside eslint's own filesystem helper. Runs on a developer's or CI's checkout, over files that are already in the repository. There is no untrusted tree for it to copy. | eslint is ever pointed at a tree from outside the repo |
| [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6) | `@xmldom/xmldom` | `@capacitor/cli → plist → @xmldom/xmldom` | no | XML fragment injection during serialization. `@capacitor/cli` uses `plist` to read and write the iOS project's own plists; the input is this repository's files. | a build step ever feeds Capacitor a plist from an untrusted source |
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp), [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895), [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v) | `brace-expansion` | `eslint → minimatch`, `typescript-eslint → …`, `@capacitor/cli → rimraf → glob → minimatch` | no | All DoS-by-expansion in glob patterns. The patterns come from `eslint.config.js`, `tsconfig`, and the tools' own defaults — all in-tree, none user-supplied. A hang here stops a build, it does not reach a user. | a glob pattern is ever built from input the repo does not control |
| [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx), [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) | `browserslist` | `@vitejs/plugin-react → @babel/core → …` | no | Unbounded cache growth, and a crash on a hostile `browserslist-stats.json`. Both are build-time, in a process that exits when `vite build` finishes; there is no custom stats file in this repo. | a `browserslist-stats.json` is added, or one arrives with a dependency |
| [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | `js-yaml` | `eslint → @eslint/eslintrc → js-yaml` | no | Quadratic CPU in `!!omap`. eslint parses YAML config from this repo. No YAML from any other source reaches it. | eslint config is ever generated from untrusted YAML |
| [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv), [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | `nanoid` | `vite → postcss → nanoid` | no | Infinite loop for a negative or zero `size`. postcss calls it with its own constant for source-map identifiers; nothing in this app calls `nanoid` at all (`grep -r nanoid frontend/src` is empty). | the app takes a direct dependency on `nanoid` |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | `postcss` | `vite → postcss` | no | `sourceMappingURL` path traversal reading arbitrary `.map` files. It runs at build time on this repo's own CSS, on the machine doing the build, which already has those files. | CSS from an untrusted source is ever processed by the build |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) | `react-router` (via `react-router-dom`) | direct dependency | **yes — it is in the bundle** | The advisory is specific to **RSC mode**: a server executing a router action before returning 400. This app uses `react-router-dom` as a pure client-side router — `BrowserRouter` in `frontend/src/main.tsx`, `Routes`/`Route` in `App.tsx`, `useNavigate`/`useLocation` elsewhere. There is no React Router server, no framework mode, no `action`/`loader` on any route, and no RSC anywhere in the tree. The vulnerable code path is not shipped. | any route gains an `action`/`loader`, or the app adopts React Router framework/RSC mode — at which point this stops being unreachable and must be fixed, not re-triaged |
| [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) | `tar` | `@capacitor/cli → tar` | no | Stack-overflow DoS from a crafted long-path tar. `@capacitor/cli` untars its own downloaded platform assets during `cap sync`. | Capacitor is ever pointed at a tarball from an untrusted source |

## Standing recommendation

`react-router-dom` has a fixed release inside the declared `^7.11.0` range
(7.18.2), so a plain `npm update react-router-dom` clears the only entry above
that ships to users. It is deliberately **not** bundled into this triage change:
a lockfile bump belongs in its own commit where it can be gated and reverted on
its own. Do it, and delete that row.

The rest are development-time only and clear themselves whenever eslint, vite or
`@capacitor/cli` are next bumped. Do not pin transitive dependencies to chase
them — an override that outlives its advisory becomes its own liability.

## How to add a row

State the dependency path (`npm ls <pkg> --all`), whether the package ends up in
a shipped bundle, and the specific reason the vulnerable path is not entered —
then name the change that would make it reachable. "Dev dependency" alone is not
a reason: a compromised build tool ships whatever it likes inside the artifact
the users install.
