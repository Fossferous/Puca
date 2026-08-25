//! Per-device keypairs for the "My Devices" feature.
//!
//! THE ONE RULE: the private keys never leave this file. JS asks for the public
//! halves and asks for signatures; it never sees a secret. Two things follow
//! from that, and both are the reason it is written this way:
//!
//!   1. A webview XSS cannot walk off with a machine's identity. The account
//!      E2EE seed already lives in localStorage (documented, accepted), but a
//!      device key is what says "this physical machine", and it is the thing a
//!      host device signs remote-control grants with. Leaking it would let an
//!      attacker authorise themselves against a host they are not at.
//!   2. The future native host agent can take ownership of the same key file
//!      without any of this being rewritten — it already lives outside the
//!      webview.
//!
//! At rest the file is DPAPI-protected (user scope) on Windows and 0600 on
//! unix. DPAPI binds it to the Windows account, so copying the file to another
//! machine or another user yields ciphertext they cannot unwrap. On unix the
//! file mode is doing the work; we do not pretend otherwise (see the note on
//! keyrings below).

use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;

/// Layout: `SOVDK1` || 32-byte X25519 secret || 32-byte Ed25519 seed.
/// The magic lets a future format change be detected rather than silently
/// misparsed into a different (and therefore wrong) identity.
const MAGIC: &[u8; 6] = b"SOVDK1";
const KEY_BLOB_LEN: usize = MAGIC.len() + 32 + 32;

#[derive(Debug, Serialize, Clone)]
pub struct DevicePublicIdentity {
    /// `x25519:<base64>` — key agreement (used from Phase 2 onward).
    pub device_pub: String,
    /// `ed25519:<base64>` — signing; proves which device a connection is.
    pub sign_pub: String,
}

fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `%LOCALAPPDATA%\com.sovereign.chat\device\device.key` on Windows,
/// `~/.local/share/puca/device.key` on unix.
///
/// Deliberately NOT under the webview's data directory: clearing site data (an
/// existing user-facing action — see `clear_webview_permissions`) must not
/// silently destroy the machine's identity and un-enrol it.
fn key_path() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map_err(|_| "LOCALAPPDATA is not set".to_string())?
        .join("com.sovereign.chat")
        .join("device");

    #[cfg(not(windows))]
    let base = {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        PathBuf::from(home).join(".local").join("share").join("puca")
    };

    Ok(base.join("device.key"))
}

// --- At-rest protection ------------------------------------------------------

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&mut input, None, None, None, None, 0, &mut out)
            .map_err(|e| format!("CryptProtectData failed: {e}"))?;
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out.pbData as *mut _));
        Ok(slice)
    }
}

#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut out)
            .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
        let slice = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out.pbData as *mut _));
        Ok(slice)
    }
}

// On unix the file mode is the protection. A Secret Service keyring is
// deliberately NOT used: an unattended host usually has no unlocked keyring, so
// depending on one would make the device unable to start itself — and claiming
// keyring protection we do not have would be worse than stating the real
// boundary.
#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    Ok(sealed.to_vec())
}

fn write_key_file(path: &PathBuf, blob: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create key dir: {e}"))?;
    }
    let sealed = protect(blob)?;
    std::fs::write(path, &sealed).map_err(|e| format!("cannot write device key: {e}"))?;

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot chmod device key: {e}"))?;
        if let Some(dir) = path.parent() {
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(())
}

/// Load the raw key material, or `None` if there is no usable key yet.
///
/// A corrupt or undecryptable file returns None rather than an error so the
/// caller regenerates. That costs a re-enrolment (the user sees a new device in
/// their list), which is recoverable; refusing to start is not.
fn load_blob() -> Option<[u8; 64]> {
    let path = key_path().ok()?;
    let sealed = std::fs::read(&path).ok()?;
    let plain = unprotect(&sealed).ok()?;
    if plain.len() != KEY_BLOB_LEN || &plain[..MAGIC.len()] != MAGIC {
        return None;
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&plain[MAGIC.len()..]);
    Some(out)
}

fn generate_blob() -> Result<[u8; 64], String> {
    use rand::RngCore;
    let mut material = [0u8; 64];
    // OsRng, not thread_rng: this key is long-lived machine identity.
    rand::rngs::OsRng.fill_bytes(&mut material);

    let mut file_blob = Vec::with_capacity(KEY_BLOB_LEN);
    file_blob.extend_from_slice(MAGIC);
    file_blob.extend_from_slice(&material);
    write_key_file(&key_path()?, &file_blob)?;
    Ok(material)
}

fn ensure_blob() -> Result<[u8; 64], String> {
    match load_blob() {
        Some(b) => Ok(b),
        None => generate_blob(),
    }
}

fn public_identity(blob: &[u8; 64]) -> DevicePublicIdentity {
    use ed25519_dalek::SigningKey;
    use x25519_dalek::{PublicKey, StaticSecret};

    let mut x_secret = [0u8; 32];
    x_secret.copy_from_slice(&blob[..32]);
    let mut ed_seed = [0u8; 32];
    ed_seed.copy_from_slice(&blob[32..]);

    let x_pub = PublicKey::from(&StaticSecret::from(x_secret));
    let ed_pub = SigningKey::from_bytes(&ed_seed).verifying_key();

    DevicePublicIdentity {
        device_pub: format!("x25519:{}", b64_encode(x_pub.as_bytes())),
        sign_pub: format!("ed25519:{}", b64_encode(ed_pub.as_bytes())),
    }
}

/// Return this device's public identity, creating the keypair on first call.
pub fn ensure() -> Result<DevicePublicIdentity, String> {
    Ok(public_identity(&ensure_blob()?))
}

/// Longest message the device key will sign. Both real transcripts are well
/// under this; the bound stops the command being used to sign bulk data.
const MAX_SIGNABLE_LEN: usize = 4096;

/// Domain prefix of the connection-attestation transcript (`identity.ts`
/// `attestationMessage`, mirrored by `device_attest_message` in `src/ws.rs`).
const ATTEST_PREFIX: &str = "sovereign-device-attest-v1|";
/// `typ` value of the device-grant record (`grants.ts` `DEVICE_GRANT_TYPE`).
const GRANT_TYPE: &str = "sovereign-device-grant-v1";

/// Whether the device key may sign `message`.
///
/// The device key is the root of the device-grant trust chain, so the signing
/// command must not be a general-purpose oracle: anything running in the
/// webview could otherwise have it sign another protocol's challenge — an OTA
/// manifest, a login transcript, a token — and present the result as this
/// machine's authenticated statement. Only the two transcripts this app
/// actually defines are signable:
///
///  1. the connection attestation, a `|`-separated string with a fixed prefix;
///  2. the device-grant record, canonical JSON carrying `typ` = GRANT_TYPE.
///
/// NOTE the grant is matched by PARSING, not by a prefix: `canonicalJson`
/// sorts keys, so the record serialises as `{"ctl":…,"typ":…}` — a `{"typ"`
/// prefix test would reject every real grant.
///
/// This does not (and cannot) stop a compromised webview from requesting a
/// well-formed grant of its own; that needs a human confirmation step, which is
/// a separate control. It confines the key to this app's own protocols.
pub fn is_signable(message: &str) -> bool {
    if message.is_empty() || message.len() > MAX_SIGNABLE_LEN {
        return false;
    }
    if message.starts_with(ATTEST_PREFIX) {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(message)
        .ok()
        .and_then(|v| v.get("typ")?.as_str().map(|t| t == GRANT_TYPE))
        .unwrap_or(false)
}

/// Sign one of this app's device transcripts. Returns base64.
///
/// The caller supplies the full transcript (see `attestationMessage` on the JS
/// side); this deliberately does no framing of its own, so there is exactly ONE
/// place that defines what a device signature covers. What it will not do is
/// sign anything else — see [`is_signable`].
pub fn sign(message: &str) -> Result<String, String> {
    use ed25519_dalek::{Signer, SigningKey};

    if !is_signable(message) {
        return Err("refusing to sign: not a device attestation or grant record".to_string());
    }

    let blob = ensure_blob()?;
    let mut ed_seed = [0u8; 32];
    ed_seed.copy_from_slice(&blob[32..]);
    let sk = SigningKey::from_bytes(&ed_seed);
    Ok(b64_encode(&sk.sign(message.as_bytes()).to_bytes()))
}

/// X25519 shared secret between this device and `peer_pub` (`x25519:<base64>`).
///
/// The SECRET is returned, not the private key. That is the compromise this
/// design makes: JS needs the static half to derive a device-control session
/// key, but it must never hold the long-lived key itself. A leaked shared
/// secret compromises one peer pairing; a leaked private key compromises the
/// machine's identity permanently.
///
/// Returns Err on a low-order/zero peer point rather than a zero secret, so
/// callers fail closed instead of deriving a key an attacker can predict.
pub fn dh(peer_pub: &str) -> Result<String, String> {
    use x25519_dalek::{PublicKey, StaticSecret};

    let b64 = peer_pub
        .strip_prefix("x25519:")
        .ok_or_else(|| "peer key must be x25519:-prefixed".to_string())?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| "peer key is not valid base64".to_string())?;
    let arr: [u8; 32] = raw.try_into().map_err(|_| "peer key must be 32 bytes".to_string())?;

    let blob = ensure_blob()?;
    let mut x_secret = [0u8; 32];
    x_secret.copy_from_slice(&blob[..32]);

    let shared = StaticSecret::from(x_secret).diffie_hellman(&PublicKey::from(arr));
    // An all-zero output means a low-order peer point: the "shared" secret is
    // then a constant the peer chose, so treat it as a failure.
    if !shared.was_contributory() {
        return Err("peer key is low-order — refusing to derive a key".to_string());
    }
    Ok(b64_encode(shared.as_bytes()))
}

/// Forget this device's identity (used when the user revokes THIS device, so a
/// later re-enrolment is genuinely a new device rather than a resurrection).
pub fn forget() -> Result<(), String> {
    let path = key_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove device key: {e}")),
    }
}

#[cfg(test)]
mod signable_tests {
    use super::*;

    /// Byte-for-byte what `attestationMessage(nonce, userId)` produces
    /// (identity.ts, pinned by deviceIdentity.test.ts).
    const REAL_ATTEST: &str = "sovereign-device-attest-v1|bm9uY2U=|42";
    /// Byte-for-byte what `canonicalJson(buildGrantRecord(...))` produces —
    /// note the SORTED keys, which is why `typ` is not first.
    const REAL_GRANT: &str = r#"{"ctl":"ctl-dev","exp":null,"host":"host-dev","ts":1786000000,"typ":"sovereign-device-grant-v1","v":1}"#;

    #[test]
    fn the_two_real_transcripts_are_signable() {
        // If either of these ever fails, device attestation or device grants
        // are BROKEN — the guard must accept exactly what the client sends.
        assert!(is_signable(REAL_ATTEST));
        assert!(is_signable(REAL_GRANT));
    }

    #[test]
    fn arbitrary_messages_are_refused() {
        // The oracle cases: another protocol's challenge, a token, bulk data.
        assert!(!is_signable("hello"));
        assert!(!is_signable(""));
        assert!(!is_signable("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9"));
        assert!(!is_signable(r#"{"typ":"some-other-protocol","v":1}"#));
        assert!(!is_signable(&"a".repeat(MAX_SIGNABLE_LEN + 1)));
        // Valid JSON without a `typ`, and a non-string `typ`.
        assert!(!is_signable(r#"{"host":"h","ctl":"c"}"#));
        assert!(!is_signable(r#"{"typ":123}"#));
    }

    #[test]
    fn a_near_miss_prefix_is_refused() {
        // Domain separation must be exact: a different version or a lookalike
        // prefix is a different protocol.
        assert!(!is_signable("sovereign-device-attest-v2|n|1"));
        assert!(!is_signable("xsovereign-device-attest-v1|n|1"));
        assert!(!is_signable(r#"{"typ":"sovereign-device-grant-v2"}"#));
    }

    #[test]
    fn sign_refuses_before_touching_the_key() {
        // Must return the refusal, not a key-load error — proving the guard
        // runs first (this test environment has no device key blob).
        let err = sign("not a transcript").unwrap_err();
        assert!(err.contains("refusing to sign"), "unexpected error: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_identity_is_deterministic_and_prefixed() {
        let blob = [7u8; 64];
        let a = public_identity(&blob);
        let b = public_identity(&blob);
        assert_eq!(a.device_pub, b.device_pub);
        assert_eq!(a.sign_pub, b.sign_pub);
        assert!(a.device_pub.starts_with("x25519:"));
        assert!(a.sign_pub.starts_with("ed25519:"));
    }

    #[test]
    fn the_two_halves_are_independent() {
        // The X25519 secret and the Ed25519 seed must come from different bytes.
        // If a refactor ever pointed both at the same 32 bytes this would still
        // "work" — same public keys every time — while silently reusing one
        // secret across two algorithms.
        let mut blob = [0u8; 64];
        blob[..32].copy_from_slice(&[1u8; 32]);
        blob[32..].copy_from_slice(&[2u8; 32]);
        let with_both = public_identity(&blob);

        blob[32..].copy_from_slice(&[3u8; 32]);
        let changed_ed = public_identity(&blob);
        assert_eq!(with_both.device_pub, changed_ed.device_pub, "x half must not depend on ed seed");
        assert_ne!(with_both.sign_pub, changed_ed.sign_pub, "ed half must depend on ed seed");
    }

    #[test]
    fn blob_layout_is_exactly_as_documented() {
        assert_eq!(KEY_BLOB_LEN, 70, "magic(6) + x25519(32) + ed25519(32)");
    }
}
