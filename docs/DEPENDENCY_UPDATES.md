# Dependency updates: what is held back, and why

Dependabot opens a pull request per group. Several of them cannot be taken as a
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
