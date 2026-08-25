//! Machine-scope unattended access: the record that says a session may be
//! authorised when nobody is at the keyboard.
//!
//! WHY THE APP'S RECORD CANNOT BE REUSED. `frontend/src-tauri/src/unattended_store.rs`
//! writes `%LOCALAPPDATA%\com.sovereign.chat\device\unattended.json` — inside
//! the signed-in user's profile. At a cold-boot sign-in screen that profile is
//! not loaded, `%LOCALAPPDATA%` does not resolve for SYSTEM, and the file is
//! unreadable even if it did. A machine-scope copy is not a convenience; it is
//! the only place the answer can live.
//!
//! WHAT IS IN IT, AND WHY IT STILL NEEDS PROTECTING. A `UaRecord` is a version,
//! an Argon2id salt and an Ed25519 public key — none of it secret, and none of
//! it revealing the passphrase. The reason it lives in the secrets directory is
//! not confidentiality but INTEGRITY: whoever can write this file chooses the
//! keypair that unlocks the machine, so a user-writable copy would let any local
//! account arm the sign-in screen with a passphrase of its own and then walk in
//! remotely. `secrets.rs`'s directory is SYSTEM + Administrators, no `BU`.
//!
//! ARMING IS NOT ENROLMENT. This says "a remote session MAY be authorised by
//! proving this passphrase". Whether the machine is reachable at all is
//! `link::is_enrolled`. Both are required, and they are separate on purpose:
//! disarming must be able to shut the door without also tearing down the
//! connection that lets you re-arm it.

#![cfg(windows)]

pub const RECORD_FILE: &str = "unattended.json";

/// Is this machine armed for sign-in-screen access?
///
/// Read from the file rather than a cached flag: the answer changes when
/// somebody disarms, and a stale `true` here is the difference between a door
/// that is shut and one that looks shut.
pub fn is_armed() -> bool {
    load().is_some()
}

pub fn load() -> Option<puca_ua::UaRecord> {
    let raw = crate::secrets::read_secret(RECORD_FILE).ok()?;
    let rec: puca_ua::UaRecord = serde_json::from_slice(&raw).ok()?;
    // A record from a future version is not "close enough" — the salt and key
    // could mean something else. Refusing is the fail-closed answer.
    if rec.version != puca_ua::UaRecord::VERSION {
        return None;
    }
    Some(rec)
}

/// Arm (or re-arm) this machine.
///
/// Re-arming REPLACES: there is exactly one machine-scope passphrase, and
/// letting two accumulate would mean revoking one while the other still opened
/// the door.
pub fn arm(record: &puca_ua::UaRecord) -> Result<(), String> {
    if record.version != puca_ua::UaRecord::VERSION {
        return Err("that record is not a version this machine understands".into());
    }
    // An all-zero verifying key is not a key; it is an uninitialised buffer that
    // reached here. Refusing costs nothing and catches a caller that thought it
    // was arming while sending nothing.
    if record.verifying_key == [0u8; 32] {
        return Err("that record carries no verifying key".into());
    }
    let raw = serde_json::to_vec_pretty(record).map_err(|e| format!("cannot encode: {e}"))?;
    crate::secrets::write_secret(RECORD_FILE, &raw)
}

/// Disarm. Succeeds when already disarmed — the caller wants the door shut, and
/// "it was already shut" is that outcome, not an error.
pub fn disarm() -> Result<(), String> {
    let path = crate::secrets::secrets_dir()?.join(RECORD_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
    }
}

/// The path the agent is pointed at with `--ua-record`.
pub fn record_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::secrets::secrets_dir()?.join(RECORD_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(k: u8) -> puca_ua::UaRecord {
        puca_ua::UaRecord::new([3u8; 16], [k; 32])
    }

    #[test]
    fn a_record_survives_the_round_trip_as_json() {
        // The agent parses these bytes from a file the service wrote. If the
        // shape drifts the agent simply comes up unarmed, which presents as
        // "the sign-in screen refuses every session" with nothing pointing here.
        let r = rec(9);
        let raw = serde_json::to_vec_pretty(&r).expect("encode");
        let back: puca_ua::UaRecord = serde_json::from_slice(&raw).expect("decode");
        assert_eq!(back, r);
        assert_eq!(back.version, puca_ua::UaRecord::VERSION);
    }

    #[test]
    fn a_record_from_another_version_is_refused_rather_than_guessed() {
        let mut r = rec(9);
        r.version = 99;
        assert!(arm(&r).is_err(), "a future version must not be written");

        // And on the way back in: a file that somehow holds one is treated as
        // unarmed, not as an armed record whose fields might mean something else.
        let raw = serde_json::to_vec(&r).unwrap();
        let parsed: puca_ua::UaRecord = serde_json::from_slice(&raw).unwrap();
        assert_ne!(parsed.version, puca_ua::UaRecord::VERSION);
    }

    #[test]
    fn an_empty_verifying_key_is_refused() {
        // An uninitialised buffer that reached here would otherwise arm the
        // machine with a key nobody holds — permanently shut, with the UI
        // reporting it as armed.
        assert!(arm(&puca_ua::UaRecord::new([3u8; 16], [0u8; 32])).is_err());
    }

    #[test]
    fn the_record_lives_beside_the_other_secrets_and_not_in_a_user_profile() {
        // THE WHOLE REASON THIS MODULE EXISTS. The app's copy is under
        // %LOCALAPPDATA%, which does not resolve for SYSTEM at a sign-in screen.
        // If this path ever moves into a profile, the feature silently stops
        // working on exactly the machines it is for.
        let p = record_path().expect("path");
        let s = p.to_string_lossy().to_lowercase();
        assert!(s.ends_with("secrets\\unattended.json"), "{s}");
        assert!(!s.contains("appdata"), "must not be in a user profile: {s}");
        assert!(!s.contains("users\\"), "must not be under a user directory: {s}");
    }
}
