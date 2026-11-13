### Security

- **Two of Púca's building blocks are updated to their patched releases.** The Rust libraries `tokio` (1.53.3) and `rustix` (1.1.6) had each been flagged for a function that can misbehave in a way Rust is meant to rule out (RUSTSEC-2026-0386 and RUSTSEC-2026-0486). Both functions exist only on Linux and other Unix systems, and Púca's own code calls neither, so this is a precaution. It comes with the server update and with the desktop app's installer.
