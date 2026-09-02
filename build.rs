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
    // The commit this binary was built from, for GET /source (AGPL §13). A
    // release tarball has no .git, so the ship step writes SOURCE_COMMIT beside
    // Cargo.toml; a checkout asks git; anything else is "unknown".
    let commit = std::env::var("PUCA_GIT_COMMIT")
        .ok()
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::fs::read_to_string("SOURCE_COMMIT").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=PUCA_GIT_COMMIT={commit}");
    println!("cargo:rerun-if-changed=SOURCE_COMMIT");
    println!("cargo:rerun-if-changed=.git/HEAD");
    // A commit on a branch changes the branch's ref file, not .git/HEAD (which
    // holds "ref: refs/heads/<branch>"), so name that file too — or the
    // embedded commit goes stale until an unrelated rebuild.
    if let Ok(head) = std::fs::read_to_string(".git/HEAD") {
        if let Some(r) = head.trim().strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=.git/{r}");
        }
    }
    println!("cargo:rerun-if-changed=.git/packed-refs");
    println!("cargo:rerun-if-env-changed=PUCA_GIT_COMMIT");
    // Any change under migrations/ (a new file, or an edit to an existing one)
    // re-runs this script, and a build-script re-run recompiles the crate.
    println!("cargo:rerun-if-changed=migrations");
    // Naming any path at all opts out of Cargo's "rerun on any package change"
    // default, so the script itself must be listed too.
    println!("cargo:rerun-if-changed=build.rs");
}
