# Dependency updates: what is held back, and why

Dependabot opened a pull request per group while its version updates were on
(`.github/dependabot.yml` now turns them off with `open-pull-requests-limit: 0`,
so a bump is a deliberate batch). Several of them cannot be taken as a
bump, and the reason is not "risky" in the abstract — each was tried on
2026-09-08 and the failure recorded here. Re-check before dismissing one again;
a blocker that has been fixed upstream should be taken.

## Blocked on a toolchain, not on us

**sqlx 0.8 -> 0.9 (#23, and inside #21).** `sqlx@0.9.0 requires rustc 1.94.0`;
this tree and the deploy host build with 1.91.1. It needs the Rust toolchain
raised on the build host first — the same host that compiles the production
backend — which is its own change with its own rollback, not a step inside a
dependency bump.

**Gradle 8.14.3 -> 9.7.1 (in #27).** Fails before compiling: AGP 8.x uses
`org.gradle.api.problems.internal.InternalProblems`, removed in Gradle 9.6.
Needs AGP raised first.

**okhttp 4.12.0 -> 5.5.0 (in #27).** Requires compileSdk 37; AGP 8.13 supports
at most 36. Same prerequisite as above, and okhttp is the socket
`NativeDelivery` holds open for push, so it also wants a real device before it
ships.

## Blocked on a source migration

**windows 0.58 -> 0.62 (in #22).** 22 compile errors in `frontend/src-tauri`:
`Win32::Foundation::BOOL` no longer exists and the signatures around the hooks,
the priority calls and the display code have moved. A day's work across the
Win32 layer, verifiable only by building and running the desktop app.

**hkdf 0.12 -> 0.13 (#24, and inside #21).** Pulls the RustCrypto trait stack
forward (`digest`, `crypto-common`), and the current `sha2`/`hmac` no longer
satisfy it: 5 trait-bound errors at the HKDF construction. It has to move as
one piece with sha2 0.11, hmac 0.13 and aes-gcm 0.11 — and then be proved to
derive byte-identical keys, because everything already encrypted depends on it.

**ndarray 0.15 -> 0.17 (#2).** `deep_filter` is pinned at tag v0.5.6 and brings
its own ndarray; two incompatible `ArrayView2` types then meet in
`df-wasm/src/lib.rs`. Moves only when deep_filter's does.

## Held on judgement rather than a build failure

**The cargo group (#21)** bundles 27 updates including axum 0.7 -> 0.8,
sqlx 0.9, rand 0.8 -> 0.10, x25519-dalek 2 -> 3, ed25519-dalek 2 -> 3, sha2,
hmac, hkdf, aes-gcm and base64. That is every cryptographic primitive in a
product whose premise is end-to-end encryption, plus the web framework and the
database layer, under one heading. The identity and session keys of every
existing account depend on those primitives producing exactly what they produce
today — and a test suite passes happily while only EXISTING data breaks. Split
it: framework, database, and crypto each as their own change, each with a
fixture proving old material still opens.

**@noble/curves 1 -> 2 and @scure/bip39 1 -> 2 (in #26).** Same argument on the
client: these are the identity primitives and the recovery-code words.

**The frontend toolchain in #26** — typescript 5 -> 7, vite 7 -> 8, vitest
4 -> 5, eslint 9 -> 10, jsdom 27 -> 30, @vitejs/plugin-react 5 -> 6 — is a
migration, and worth doing, but not inside a bump.

**eslint-plugin-react-hooks 7.0.1 -> 7.1.1** reports 209 errors (refs read
during render, setState inside effects, use-before-declare) and
**eslint-plugin-react-refresh 0.4.24 -> 0.5.6** reports 137 more. Real
findings, and a real piece of work; both are pinned EXACTLY in package.json,
because a caret let them straight back in and the lint gate went red again.

## Not cleared by the 2026-11-17 advisory batch

The batch cleared every open Dependabot alert it could reach with a bump (the
frontend lock, and the Steam Deck plugin's). Three could not be:

**tract 0.19 -> 0.21 (df-wasm: GHSA-x5mv-8wgw-29hg, RUSTSEC-2026-0217, in
tract-nnef; GHSA-h668-6x6g-f8r5 in tract-onnx).** No release older than 0.21
is fixed (the fixes are 0.21.16 and 0.21.17, and in the 0.22 and 0.23 lines).
`deep_filter` v0.5.6, still DeepFilterNet's newest release (2023-08-31), asks
for `tract-* ^0.19.4`; only its unreleased main branch (0.5.7-pre) asks for
^0.21.4. Taking it means pinning df-wasm to an unreleased upstream commit,
rebuilding the committed 14 MB wasm and proving the DeepFilter (Max) tier
again: a migration, not a bump. Neither advisory is reachable meanwhile;
`.cargo/audit.toml` says why.

**glib 0.18 -> 0.20 (frontend/src-tauri: GHSA-wrw7-89jp-8q8g,
RUSTSEC-2024-0429, an unsound iterator).** glib comes through gtk 0.18 from
tauri, tao, wry, webkit2gtk, muda and tray-icon, and each of them at its
newest release (tauri 2.12.6, wry 0.57.2 with webkit2gtk =2.0.2, tao 0.37.2,
checked 2026-11-17) still asks for gtk ^0.18. It moves when Tauri's Linux
stack does. It is compiled only for Linux (`cargo tree -i glib --target
x86_64-pc-windows-msvc` prints nothing) and no Linux desktop build is
published; `cargo audit` lists it as a warning.

**deepmerge (integrations/decky: GHSA-gcqx-w48m-w2h4).** The advisory was
withdrawn on 2026-11-16 and names no fixed version; 4.3.1, from
`@rollup/plugin-node-resolve`, is deepmerge's newest.

## The Steam Deck plugin's pins, and when they go

`integrations/decky/package.json` pins every version exactly. Two entries exist
only because of that batch:

- **`vite` 7.3.7 as a devDependency.** vitest 4.1.12 accepts vite ^6, ^7 or
  ^8, and npm resolves a fresh vitest to vite 8, the major held back above.
  Listing it keeps the plugin's test runner on the frontend's vite. It goes
  with the vite 8 migration.
- **`overrides` of `@rollup/plugin-commonjs` to 29.0.3.** `@decky/rollup`
  1.0.2, the newest, asks for ^26, whose glob 10 brings minimatch 9
  (GHSA-g3hv-75wg-m249, fixed only in 11.0.1), and glob 10 is itself inside
  GHSA-3g3m-2fjr-6pw4. 28.0.0 replaced glob with fdir. The preset calls
  `commonjs()` with no options, and `dist/index.js`, its map and
  `dist/page-shim.js` built byte-identical across the change. Drop the
  override when `@decky/rollup` asks for ^28 or newer, and compare the bundle
  again if the plugin ever bundles a CommonJS module (27 made
  `strictRequires: true` the default).

npm 11.1.0 cannot make the step to vitest 4.1.12 in either tree: it stops with
`Cannot read properties of null (reading 'edgesOut')` in its peer-set code.
`npx -y npm@11.21.2 install ...` makes it with the same ranges, and once the
lock holds vitest 4.1.12, npm 11.1.0 installs, updates and `npm ci`s it.
