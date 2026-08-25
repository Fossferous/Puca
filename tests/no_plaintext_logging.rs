//! Regression guard: the server must never log user plaintext or key material.
//!
//! E2EE is only as good as the weakest place plaintext appears. Message/DM/task
//! content, wrapped key blobs, identity seeds, SRP verifiers, and session keys
//! are all in scope at various handlers — a stray `tracing::debug!("msg {}",
//! content)` would silently defeat the whole scheme. This test scans the source
//! for logging macros whose arguments name a sensitive value and fails if any
//! appear, so the leak is caught at build time rather than in a prod log dump.
//!
//! It is deliberately conservative (matches specific dangerous identifiers
//! inside logging macros). If a legitimate log genuinely needs one of these
//! tokens, narrow the identifier or add an explicit `// plaintext-logging-ok`
//! marker on the line and extend the allowlist below.

use std::fs;
use std::path::Path;

/// Identifiers that must never be interpolated into a log line.
const FORBIDDEN: &[&str] = &[
    "payload.content",
    "req.content",
    ".sdp",
    ".candidate",
    "wrapped_key",
    "seed_wrapped",
    "identity_seed",
    "session_key",
    "verifier_hex",
    "recovery_code",
    "plaintext",
];

const LOG_MACROS: &[&str] = &[
    "tracing::info!",
    "tracing::debug!",
    "tracing::warn!",
    "tracing::error!",
    "tracing::trace!",
    "println!",
    "eprintln!",
    "print!",
    "eprint!",
];

fn scan_dir(dir: &Path, violations: &mut Vec<String>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            scan_dir(&path, violations);
        } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
            let src = fs::read_to_string(&path).unwrap_or_default();
            for (lineno, line) in src.lines().enumerate() {
                if line.contains("// plaintext-logging-ok") {
                    continue;
                }
                let is_log = LOG_MACROS.iter().any(|m| line.contains(m));
                if !is_log {
                    continue;
                }
                for bad in FORBIDDEN {
                    if line.contains(bad) {
                        violations.push(format!(
                            "{}:{}: log line references `{}`\n    {}",
                            path.display(),
                            lineno + 1,
                            bad,
                            line.trim()
                        ));
                    }
                }
            }
        }
    }
}

#[test]
fn no_sensitive_values_in_log_statements() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut violations = Vec::new();
    scan_dir(&src_dir, &mut violations);
    assert!(
        violations.is_empty(),
        "found {} log statement(s) that may leak plaintext or key material:\n{}",
        violations.len(),
        violations.join("\n")
    );
}
