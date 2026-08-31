//! Where the unattended-access passphrase record lives on the host.
//!
//! The record is `salt + Ed25519 public key` — never the passphrase, never the
//! private key, never anything the passphrase can be recovered from. See
//! `crates/puca-ua` for why the split is that way: the controller derives
//! and signs; the host only ever verifies.
//!
//! STORED DEVICE-LOCALLY, like the tunnel policy and the device key, and for the
//! sharpest version of the same reason. This record is what decides whether a
//! machine will accept unattended SYSTEM-level control. If the server held it,
//! anyone who compromised the account could arm a machine they have never
//! touched; if a webview held it, an XSS could. It has to be set AT the machine.
//!
//! Losing it is a deliberate, stated cost: there is no remote recovery for the
//! unattended passphrase. Forget it and you walk to the machine and disarm
//! locally. The UI must say so BEFORE arming, not after.

use serde::{Deserialize, Serialize};

/// Exactly what `puca_ua::UaRecord` holds, mirrored here so this crate does
/// not take a dependency on the gate just to read a file. The gate itself
/// validates the contents.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredUaRecord {
    pub version: u8,
    pub salt: Vec<u8>,
    pub verifying_key: Vec<u8>,
}

impl StoredUaRecord {
    /// Structurally valid? Checked on load AND on save: a truncated file must
    /// read as "not armed" rather than as a record that fails every challenge,
    /// which would present as "my passphrase stopped working" with no cause.
    pub fn is_well_formed(&self) -> bool {
        self.version == 1 && self.salt.len() == 16 && self.verifying_key.len() == 32
    }
}

fn record_path() -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| format!("{h}/.local/share"))
        .map_err(|_| "HOME is not set".to_string())?;
    let dir = std::path::Path::new(&base).join(env!("PUCA_IDENTIFIER")).join("device");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("unattended.json"))
}

/// Is this machine armed for unattended access, and with what salt?
///
/// Returns the SALT only — the controller needs it to reproduce the Argon2id
/// derivation. The verifying key stays here; handing it out would let anyone who
/// can call this command take the public key away and grind passphrases against
/// it offline, at their leisure, with no rate limit.
#[derive(Serialize)]
pub struct UaState {
    pub armed: bool,
    /// Base64 salt, present only when armed.
    pub salt: Option<String>,
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .map_err(|e| format!("not valid base64: {e}"))
}

/// Load the stored record, or `None` if absent/unreadable/malformed.
pub fn load() -> Option<StoredUaRecord> {
    let path = record_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let rec: StoredUaRecord = serde_json::from_str(&raw).ok()?;
    rec.is_well_formed().then_some(rec)
}

#[tauri::command]
pub fn unattended_state() -> UaState {
    match load() {
        Some(rec) => UaState { armed: true, salt: Some(b64(&rec.salt)) },
        None => UaState { armed: false, salt: None },
    }
}

/// Arm (or re-arm) this machine with a record the controller just derived.
///
/// Re-arming REPLACES: changing the passphrase must actually revoke the old one,
/// not leave two working.
#[tauri::command]
pub fn unattended_arm(salt_b64: String, verifying_key_b64: String) -> Result<(), String> {
    let rec = StoredUaRecord {
        version: 1,
        salt: unb64(&salt_b64)?,
        verifying_key: unb64(&verifying_key_b64)?,
    };
    if !rec.is_well_formed() {
        return Err(format!(
            "malformed record: salt {} bytes (want 16), key {} bytes (want 32)",
            rec.salt.len(),
            rec.verifying_key.len()
        ));
    }
    let path = record_path()?;
    let json =
        serde_json::to_string_pretty(&rec).map_err(|e| format!("could not serialise: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("could not write {path:?}: {e}"))?;
    Ok(())
}

/// Disarm — unattended access off. Removing the file IS the revocation.
#[tauri::command]
pub fn unattended_disarm() -> Result<(), String> {
    let path = record_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone is the desired end state, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {path:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> StoredUaRecord {
        StoredUaRecord { version: 1, salt: vec![7u8; 16], verifying_key: vec![9u8; 32] }
    }

    #[test]
    fn a_well_formed_record_is_accepted() {
        assert!(good().is_well_formed());
    }

    #[test]
    fn wrong_field_lengths_are_rejected() {
        // A truncated file must read as NOT ARMED rather than as a record that
        // fails every challenge — the latter presents as "my passphrase stopped
        // working" with nothing to point at.
        let mut short_salt = good();
        short_salt.salt = vec![7u8; 15];
        assert!(!short_salt.is_well_formed());

        let mut short_key = good();
        short_key.verifying_key = vec![9u8; 31];
        assert!(!short_key.is_well_formed());

        let mut long_key = good();
        long_key.verifying_key = vec![9u8; 33];
        assert!(!long_key.is_well_formed());
    }

    #[test]
    fn an_unknown_version_is_rejected() {
        // Refusing an unknown version is what lets the format change later
        // without a future record being half-read by today's code.
        let mut v = good();
        v.version = 2;
        assert!(!v.is_well_formed());
    }

    #[test]
    fn the_record_round_trips_through_json() {
        let rec = good();
        let back: StoredUaRecord =
            serde_json::from_str(&serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(rec, back);
        assert!(back.is_well_formed());
    }

    #[test]
    fn the_state_never_carries_the_verifying_key() {
        // The salt is public; the KEY is not handed out. Anyone who could take
        // the public key away could grind passphrases against it offline with no
        // rate limit, which is exactly what an on-machine gate is meant to deny.
        let state = UaState { armed: true, salt: Some(b64(&[1u8; 16])) };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("salt"));
        assert!(!json.contains("verifying"), "the verifying key must never leave the host");
    }
}

// ---------------------------------------------------------------------------
// The live gate: challenge and verify at connect time.
// ---------------------------------------------------------------------------

/// The host's challenge state for the current process.
///
/// One gate for the whole app rather than one per session: nonces are single-use
/// and unguessable, so sharing the pool is safe, and it means a session that dies
/// mid-handshake leaves nothing behind but an entry that ages out.
pub struct UaGateState(pub std::sync::Mutex<puca_ua::UaGate>);

impl Default for UaGateState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(puca_ua::UaGate::default()))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the host sends a controller that must prove the passphrase.
#[derive(Serialize)]
pub struct UaChallenge {
    pub nonce: String,
    /// The salt, so the controller can reproduce the Argon2id derivation.
    pub salt: String,
}

/// Issue a challenge, or `None` when this machine is not armed.
///
/// `None` means "no proof required" — the caller proceeds with the session. That
/// is the correct reading: a machine nobody armed does not demand a passphrase.
#[tauri::command]
pub fn unattended_challenge(gate: tauri::State<'_, UaGateState>) -> Result<Option<UaChallenge>, String> {
    let Some(rec) = load() else {
        return Ok(None);
    };
    let salt: [u8; 16] = rec.salt.clone().try_into().map_err(|_| "stored salt is not 16 bytes")?;
    let key: [u8; 32] =
        rec.verifying_key.clone().try_into().map_err(|_| "stored key is not 32 bytes")?;

    let mut g = gate.0.lock().map_err(|_| "gate poisoned")?;
    // Arm from disk on every challenge rather than caching: the record can be
    // changed or removed while the app runs, and a cached gate would keep
    // honouring a passphrase the user has just revoked.
    g.arm(puca_ua::UaRecord::new(salt, key));
    let nonce = g.issue_challenge(now_ms()).map_err(|e| format!("{e:?}"))?;
    Ok(Some(UaChallenge { nonce: b64(&nonce), salt: b64(&salt) }))
}

/// Verify a controller's response. Returns Ok(()) only on a good signature.
///
/// Every failure is an Err with a reason for the LOCAL log; the caller must not
/// hand the reason to the peer, which would turn this into an oracle telling an
/// attacker whether a nonce was valid, expired, or merely mis-signed.
#[tauri::command]
pub fn unattended_verify(
    gate: tauri::State<'_, UaGateState>,
    nonce: String,
    context: String,
    signature: String,
) -> Result<(), String> {
    let nonce_bytes: [u8; 32] =
        unb64(&nonce)?.try_into().map_err(|_| "nonce is not 32 bytes".to_string())?;
    let sig = unb64(&signature)?;
    let mut g = gate.0.lock().map_err(|_| "gate poisoned")?;
    g.verify(&nonce_bytes, &context, &sig, now_ms())
        .map_err(|e| format!("{e:?}"))
}
