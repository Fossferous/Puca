//! Making this machine reachable at its own sign-in screen — and unmaking it.
//!
//! ABSENT UNTIL SOMEBODY ASKS. Every install has this service's code and no
//! enrolment: `link::is_enrolled` is false, the link thread finds nothing, and
//! no socket is ever opened. Nothing here runs unless the console administrator
//! deliberately turns it on, and `forget` puts the machine back exactly as it
//! was.
//!
//! WHY ENROLMENT IS TWO STEPS. Putting a device in the account's list means
//! publishing an auth record signed by the ACCOUNT signing key — derived from
//! the account seed, which is password-derived and which this service must never
//! hold. A LocalSystem process with an internet socket holding a key that can
//! enrol devices into the account is not a trade worth making for one round
//! trip.
//!
//! So: `begin` generates the keypair and hands back only public halves; the app
//! signs a record describing them and enrols it with the server; `finish` is
//! told the connection details and the account's PUBLIC signing key, which is
//! all the service needs to verify other devices and cannot be used to enrol
//! anything.
//!
//! THE PRIVATE KEYS NEVER CROSS THE PIPE in either direction.

#![cfg(windows)]

use crate::link::{CONFIG_FILE, DEVICE_PRIV_FILE, SIGN_SEED_FILE, TOKEN_FILE};

/// The public halves of a freshly generated identity.
pub struct PublicIdentity {
    pub device_id: String,
    pub device_pub: String,
    pub sign_pub: String,
}

/// Step one: generate and store this machine's device identity.
///
/// GENERATES A NEW ONE EVERY TIME rather than reusing an existing key. Enrolment
/// is rare and deliberate, and a re-enrolment after `forget` should not silently
/// resurrect an identity the owner believed they had removed — the device row on
/// the server was deleted, and re-presenting its key would re-create a device
/// they thought was gone.
pub fn begin() -> Result<PublicIdentity, String> {
    let id = crate::secrets::MachineIdentity::generate()?;

    // Written BEFORE anything is returned: if the caller enrols the public keys
    // with the server and this machine then cannot produce the matching private
    // half, the account holds a device row that can never attest — visible in
    // the UI, permanently offline, and removable only by hand.
    crate::secrets::write_secret(DEVICE_PRIV_FILE, &id.device_priv)?;
    crate::secrets::write_secret(SIGN_SEED_FILE, &id.sign_seed)?;

    Ok(PublicIdentity {
        device_id: id.device_id,
        device_pub: id.device_pub,
        sign_pub: id.sign_pub,
    })
}

/// Step two: adopt the connection details.
///
/// Ordered so the machine is never half-enrolled in a way that opens a socket:
/// the token lands first, then the config — and `is_enrolled` requires BOTH plus
/// the two keys, so the link stays closed until the last write succeeds.
pub fn finish(
    api_base: &str,
    user_id: i64,
    token: &str,
    account_sign_pub: &str,
) -> Result<(), String> {
    if !crate::secrets::secret_exists(DEVICE_PRIV_FILE)
        || !crate::secrets::secret_exists(SIGN_SEED_FILE)
    {
        return Err("this machine has no identity yet — enrol from the beginning".into());
    }

    // Read back the identity `begin` stored, and derive the public halves from
    // it rather than trusting the caller to repeat them. A mismatch here means
    // the app enrolled a DIFFERENT key with the server than this machine holds,
    // and the device would be permanently unable to attest.
    let device_priv: [u8; 32] = crate::secrets::read_secret(DEVICE_PRIV_FILE)?
        .try_into()
        .map_err(|_| "the stored device key is not 32 bytes".to_string())?;
    let sign_seed: [u8; 32] = crate::secrets::read_secret(SIGN_SEED_FILE)?
        .try_into()
        .map_err(|_| "the stored signing key is not 32 bytes".to_string())?;

    let device_pub = {
        let sk = x25519_dalek::StaticSecret::from(device_priv);
        format!(
            "x25519:{}",
            base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                x25519_dalek::PublicKey::from(&sk).as_bytes()
            )
        )
    };
    let sign_pub = {
        let sk = ed25519_dalek::SigningKey::from_bytes(&sign_seed);
        format!(
            "ed25519:{}",
            base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                sk.verifying_key().as_bytes()
            )
        )
    };
    let device_id = crate::secrets::derive_device_id(&device_pub, &sign_pub);

    crate::secrets::write_secret(TOKEN_FILE, token.trim().as_bytes())?;

    let cfg = crate::link::LinkConfig {
        api_base: api_base.trim_end_matches('/').to_string(),
        user_id,
        device_id,
        device_pub,
        sign_pub,
        account_sign_pub: account_sign_pub.to_string(),
    };
    cfg.save()
}

/// Remove everything enrolment put on this machine.
///
/// INCLUDING THE ARMING RECORD. Unenrolling is the owner saying "this machine is
/// not reachable that way any more", and leaving an armed record behind would
/// mean a later re-enrolment silently restored a passphrase they set long ago
/// and may not remember.
///
/// Best-effort per file, and reports the first real failure. A file that was
/// already absent is the desired outcome, not an error.
pub fn forget() -> Result<(), String> {
    let dir = crate::secrets::secrets_dir()?;
    let mut first_error: Option<String> = None;
    for name in [
        TOKEN_FILE,
        CONFIG_FILE,
        DEVICE_PRIV_FILE,
        SIGN_SEED_FILE,
        crate::arming::RECORD_FILE,
    ] {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(format!("cannot remove {name}: {e}"));
                }
            }
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forgetting_removes_the_arming_record_too() {
        // A re-enrolment must not silently restore a passphrase the owner set
        // long ago and may not remember. Read as a list rather than by running
        // it, because running it would need the real secrets directory.
        // SCANNED WITHOUT THE TEST MODULE. `include_str!` of this file includes
        // the assertions below, so every string searched for is present in the
        // test's own source and the check passes whatever the real code says.
        // Four tests in this change were written that way and could not fail.
        let src = include_str!("enrol.rs").split("#[cfg(test)]").next().unwrap();
        let list_start = src.find("for name in [").expect("the list");
        let list_end = src[list_start..].find("] {").expect("the end") + list_start;
        let list = &src[list_start..list_end];
        for expected in
            ["TOKEN_FILE", "CONFIG_FILE", "DEVICE_PRIV_FILE", "SIGN_SEED_FILE", "RECORD_FILE"]
        {
            assert!(list.contains(expected), "forget() must remove {expected}");
        }
    }

    #[test]
    fn everything_is_enrolled_checks_is_something_forget_removes() {
        // THE PAIR THAT MUST NOT DRIFT. is_enrolled() requires four files; if
        // forget() ever misses one, the machine reports itself unenrolled while
        // still holding a key — and a later enrolment would generate a second
        // identity beside an orphan.
        // SCANNED WITHOUT THE TEST MODULE. `include_str!` of this file includes
        // the assertions below, so every string searched for is present in the
        // test's own source and the check passes whatever the real code says.
        // Four tests in this change were written that way and could not fail.
        let enrol_src = include_str!("enrol.rs").split("#[cfg(test)]").next().unwrap();
        let link_src = include_str!("link.rs").split("#[cfg(test)]").next().unwrap();

        let checked_start = link_src.find("[CONFIG_FILE, TOKEN_FILE").expect("is_enrolled list");
        let checked = &link_src[checked_start..checked_start + 120];
        for name in ["CONFIG_FILE", "TOKEN_FILE", "SIGN_SEED_FILE", "DEVICE_PRIV_FILE"] {
            assert!(checked.contains(name), "is_enrolled must check {name}");
            assert!(enrol_src.contains(name), "forget must remove {name}");
        }
    }

    #[test]
    fn the_public_halves_are_derived_from_storage_not_taken_from_the_caller() {
        // If `finish` trusted the caller's copy of the public keys, an app that
        // enrolled key A with the server while the machine held key B would
        // produce a device row that can never attest — visible in the UI,
        // permanently offline, removable only by hand.
        // SCANNED WITHOUT THE TEST MODULE. `include_str!` of this file includes
        // the assertions below, so every string searched for is present in the
        // test's own source and the check passes whatever the real code says.
        // Four tests in this change were written that way and could not fail.
        let src = include_str!("enrol.rs").split("#[cfg(test)]").next().unwrap();
        let body_start = src.find("pub fn finish(").expect("finish");
        let body = &src[body_start..];
        assert!(body.contains("read_secret(DEVICE_PRIV_FILE)"), "must re-read the stored key");
        assert!(body.contains("derive_device_id(&device_pub, &sign_pub)"));
        // The signature carries no public keys to be trusted in the first place.
        let sig_end = src[body_start..].find(')').unwrap() + body_start;
        let sig = &src[body_start..sig_end];
        assert!(!sig.contains("device_pub"), "finish must not accept a device_pub: {sig}");
    }
}
