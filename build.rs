//! Build script for the `puca` binary.
//!
//! It exists for exactly one reason: `src/main.rs` calls
//! `sqlx::migrate!("./migrations")`, which reads the migrations directory at
//! COMPILE time and embeds every file in the binary. Cargo cannot see that
//! dependency on its own — a proc macro's file reads are invisible to it — so a
//! rebuild from a warm `target/` would happily reuse an object file whose
//! embedded migration set stops at whatever existed when it was last compiled.
//! The server then boots, `sqlx::migrate` reports success for the set it knows
//! about, and every query naming a column from a missing migration fails at
//! runtime instead of at startup.
//!
//! That is not theoretical: measured on 2026-09-02 in this tree, adding a
//! migration and running `cargo build` with no build script finished in 0.49s
//! and the new file was NOT in the binary. With this script it recompiles and
//! the file is embedded. The convention this replaces was a hand-bumped comment
//! at the top of `src/main.rs`, which had gone three migrations stale.
fn main() {
    // Any change under migrations/ (a new file, or an edit to an existing one)
    // re-runs this script, and a build-script re-run recompiles the crate.
    println!("cargo:rerun-if-changed=migrations");
    // Naming any path at all opts out of Cargo's "rerun on any package change"
    // default, so the script itself must be listed too.
    println!("cargo:rerun-if-changed=build.rs");
}
