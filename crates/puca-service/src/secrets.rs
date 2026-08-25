//! Where the service keeps things no other account may read.
//!
//! WHY THE INSTALL DIRECTORY IS NOT THIS PLACE. `provision.rs` creates
//! `%ProgramFiles%\Puca\service` with
//! `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)`. That is correct
//! for BINARIES — `BUILTIN\Users` needs read+execute to run them — but `OICI`
//! propagates that read to every file placed inside. A device private key
//! dropped there would be readable by every local account on the machine,
//! including the two non-administrator ones this project already knows about.
//!
//! So secrets live in a CHILD directory with the `BU` entry removed entirely.
//! Same protected marker, same inheritance, one fewer trustee.
//!
//! WHY NOT %ProgramData%. Because `launch_id.rs` already records what happened
//! last time: the agent's launch token was published to
//! `%ProgramData%\Puca` under a comment asserting it was SYSTEM-writable,
//! and that directory in fact grants `BUILTIN\Users:(WD,AD,WEA,WA)` on this
//! machine. That mistake is not worth making twice, and the service log still
//! lives there precisely because a log is not a secret.
//!
//! WHY DPAPI IS NOT THE CONTROL. Machine-scope DPAPI binds ciphertext to the
//! machine, not to an account — so any local process that can READ the file can
//! also unprotect it. Against a local attacker the ACL is the entire control;
//! DPAPI adds value only for a disk removed from the machine. It is applied on
//! top for that case, and its absence would not be the thing that saves you.

#![cfg(windows)]

use std::path::PathBuf;

/// SYSTEM and Administrators only. NO `BU` — that difference is the whole
/// reason this directory exists separately from its parent.
const SECRETS_SDDL: &str = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

pub fn secrets_dir() -> Result<PathBuf, String> {
    Ok(crate::path_guard::install_dir()?.join("secrets"))
}

/// Create or repair the secrets directory.
pub fn ensure_secrets_dir() -> Result<PathBuf, String> {
    let dir = secrets_dir()?;
    crate::provision::apply_sddl(&dir, SECRETS_SDDL)?;
    Ok(dir)
}

/// This machine's own device identity.
///
/// UNLIKE THE WAKER, THE X25519 PRIVATE KEY IS KEPT. `puca-waker`
/// deliberately drops it — its comment says "the wake path never seals or opens
/// anything", which is true of a process whose whole job is a UDP broadcast.
/// Copying that here verbatim, as the plan originally said to, would destroy the
/// exact key the agent needs for the static half of the control-key derivation,
/// and no session could ever be opened. The two crates look similar and differ
/// on precisely this point.
pub struct MachineIdentity {
    pub device_id: String,
    pub device_pub: String,
    pub sign_pub: String,
    /// X25519 private key. Needed for the static DH that proves WHICH MACHINE
    /// is at this end of a session.
    pub device_priv: [u8; 32],
    /// Ed25519 seed, for attesting the WebSocket.
    pub sign_seed: [u8; 32],
}

impl MachineIdentity {
    pub fn generate() -> Result<Self, String> {
        let mut material = [0u8; 64];
        getrandom::getrandom(&mut material).map_err(|e| format!("system RNG unavailable: {e}"))?;
        let mut device_priv = [0u8; 32];
        device_priv.copy_from_slice(&material[..32]);
        let mut sign_seed = [0u8; 32];
        sign_seed.copy_from_slice(&material[32..]);

        let device_pub = {
            let sk = x25519_dalek::StaticSecret::from(device_priv);
            format!("x25519:{}", b64(x25519_dalek::PublicKey::from(&sk).as_bytes()))
        };
        let sign_pub = {
            let sk = ed25519_dalek::SigningKey::from_bytes(&sign_seed);
            format!("ed25519:{}", b64(sk.verifying_key().as_bytes()))
        };
        Ok(Self {
            device_id: derive_device_id(&device_pub, &sign_pub),
            device_pub,
            sign_pub,
            device_priv,
            sign_seed,
        })
    }

    /// X25519(this machine's private key, the peer device's public key).
    ///
    /// The static half of the control-key derivation. Returns None for a
    /// malformed peer key rather than a zero shared secret — silently deriving
    /// from garbage would produce a session key both ends could compute only if
    /// the attacker chose the garbage.
    pub fn static_shared(&self, peer_device_pub: &str) -> Option<[u8; 32]> {
        let raw = peer_device_pub.strip_prefix("x25519:")?;
        let bytes: [u8; 32] = unb64(raw)?.try_into().ok()?;
        let sk = x25519_dalek::StaticSecret::from(self.device_priv);
        Some(*sk.diffie_hellman(&x25519_dalek::PublicKey::from(bytes)).as_bytes())
    }
}

/// The device id the SERVER independently derives. Must match
/// `src/device_handlers.rs` and the client, or enrolment returns an id this
/// machine will never attest under.
pub fn derive_device_id(device_pub: &str, sign_pub: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"sovereign-device-v1");
    h.update(device_pub.as_bytes());
    h.update(sign_pub.as_bytes());
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, h.finalize())
        .chars()
        .take(21)
        .collect()
}

fn b64(bytes: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s).ok()
}

/// Write a secret, replacing any previous one atomically.
///
/// Write-then-rename inside the same directory, so a crash or a full disk
/// mid-write cannot leave a half-written key that the service would then fail
/// to use with no way to say why. The temporary file is created inside the
/// already-protected directory, so it is never briefly readable elsewhere.
pub fn write_secret(name: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = ensure_secrets_dir()?;
    let final_path = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| format!("cannot replace {}: {e}", final_path.display()))
}

pub fn read_secret(name: &str) -> Result<Vec<u8>, String> {
    let path = secrets_dir()?.join(name);
    std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

pub fn secret_exists(name: &str) -> bool {
    secrets_dir().map(|d| d.join(name).exists()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_secrets_acl_removes_users_entirely() {
        // THE ONE DIFFERENCE FROM THE PARENT, and the reason this module
        // exists. The install directory grants BUILTIN\Users read+execute and
        // propagates it with OICI to every file inside — correct for binaries
        // people must run, fatal for a device private key.
        assert!(SECRETS_SDDL.starts_with("D:P"), "inheritance must be severed");
        assert!(SECRETS_SDDL.contains("(A;OICI;FA;;;SY)"));
        assert!(SECRETS_SDDL.contains("(A;OICI;FA;;;BA)"));
        assert!(!SECRETS_SDDL.contains(";BU)"), "Users must not appear at all");
        assert!(!SECRETS_SDDL.contains(";WD)"));
        assert!(!SECRETS_SDDL.contains(";AU)"));
        assert!(!SECRETS_SDDL.contains(";IU)"));
        // Exactly two trustees. A third would have to justify itself here.
        assert_eq!(SECRETS_SDDL.matches("(A;").count(), 2, "{SECRETS_SDDL}");
    }

    #[test]
    fn windows_accepts_the_secrets_acl() {
        use windows::core::HSTRING;
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows::Win32::Security::PSECURITY_DESCRIPTOR;
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(SECRETS_SDDL),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        };
        assert!(ok.is_ok(), "Windows rejected the secrets ACL: {ok:?}");
        if !sd.0.is_null() {
            unsafe {
                let _ = windows::Win32::Foundation::LocalFree(
                    windows::Win32::Foundation::HLOCAL(sd.0),
                );
            }
        }
    }

    #[test]
    fn the_device_private_key_survives_generation() {
        // THE BUG THE PLAN WOULD HAVE SHIPPED. puca-waker drops its X25519
        // private key immediately after computing the public half, and the plan
        // said to copy that "verbatim". Here the key is the static half of every
        // session-key derivation — dropped, no session could ever be opened, and
        // the failure would present as "the sign-in screen never connects".
        let id = MachineIdentity::generate().expect("RNG");
        assert_ne!(id.device_priv, [0u8; 32], "the private key must be retained");

        // And it must actually agree with the published public key.
        let sk = x25519_dalek::StaticSecret::from(id.device_priv);
        let derived = format!("x25519:{}", b64(x25519_dalek::PublicKey::from(&sk).as_bytes()));
        assert_eq!(derived, id.device_pub);
    }

    #[test]
    fn the_static_dh_agrees_with_the_peer() {
        // Both ends must compute the same secret from opposite halves, or the
        // control key differs and every frame fails to open.
        let host = MachineIdentity::generate().expect("RNG");
        let peer = MachineIdentity::generate().expect("RNG");

        let a = host.static_shared(&peer.device_pub).expect("host side");
        let b = peer.static_shared(&host.device_pub).expect("peer side");
        assert_eq!(a, b, "X25519 must be symmetric across the two devices");

        // A malformed peer key is refused rather than silently producing a
        // shared secret from garbage.
        assert!(host.static_shared("ed25519:AAAA").is_none());
        assert!(host.static_shared("not-a-key").is_none());
        assert!(host.static_shared("x25519:!!!").is_none());
    }

    #[test]
    fn the_device_id_matches_the_servers_derivation() {
        let id = MachineIdentity::generate().expect("RNG");
        assert_eq!(id.device_id.len(), 21, "the server compares 21 chars");
        assert_eq!(id.device_id, derive_device_id(&id.device_pub, &id.sign_pub));
        // URL-safe, unpadded — the server's alphabet.
        assert!(!id.device_id.contains('+') && !id.device_id.contains('/'));
        assert!(!id.device_id.contains('='));
        // Two machines must not collide.
        assert_ne!(id.device_id, MachineIdentity::generate().unwrap().device_id);
    }
}
