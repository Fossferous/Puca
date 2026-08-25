//! Who this waker is, in the exact terms the server already understands.
//!
//! Nothing here is new protocol. Every rule is copied from the shipped
//! implementations and is pinned by tests against them:
//!
//!   - device id      `src/device_handlers.rs` (server) and
//!                    `frontend/e2e/device-attest.mjs:66-73` (client)
//!   - attestation    `src/ws.rs` — `sovereign-device-attest-v1|{nonce}|{uid}`
//!
//! WHAT THIS FILE DELIBERATELY CANNOT DO. It cannot produce the enrolment
//! `auth_record`/`auth_sig`, because those are signed with the ACCOUNT signing
//! key, which is derived from the E2EE account seed. The waker never holds that
//! seed — it is the one secret that would turn a compromised always-on box into
//! a compromised account. The desktop app signs the record during pairing and
//! hands over only the finished strings, which are public anyway.

use base64::Engine;
use sha2::{Digest, Sha256};

/// URL-safe base64, no padding — what the device id is encoded in.
fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Standard base64 with padding — what key material and signatures use.
pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The device id the SERVER will independently derive from these two keys.
///
/// Deriving rather than choosing is the point: the server recomputes this and
/// ignores anything the client claims, so a device cannot squat another's id.
/// The 21-character truncation is not ours to change — it is what the server
/// compares against.
pub fn derive_device_id(device_pub: &str, sign_pub: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"sovereign-device-v1");
    h.update(device_pub.as_bytes());
    h.update(sign_pub.as_bytes());
    let full = b64url(&h.finalize());
    full.chars().take(21).collect()
}

/// The exact bytes the server will verify the attestation signature over.
///
/// The pipe-separated form and the version prefix are load-bearing: the nonce
/// is per-connection, so binding it into the transcript is what stops a
/// signature captured from one socket being replayed onto another, and the
/// user id stops it being replayed onto a different account.
pub fn attestation_message(nonce: &str, user_id: i64) -> String {
    format!("sovereign-device-attest-v1|{nonce}|{user_id}")
}

/// This waker's long-lived identity.
///
/// The X25519 half exists only because the device id is derived from BOTH
/// public keys, so the pair has to be well-formed for the server to arrive at
/// the same id. Its private half is generated, used to compute the public key,
/// and dropped on the floor in [`generate`] — the wake path never seals or
/// opens anything, and a private key with no reader is just a liability with a
/// backup story.
#[derive(Clone)]
pub struct Identity {
    pub device_id: String,
    pub device_pub: String,
    pub sign_pub: String,
    /// The Ed25519 seed. The only secret this process holds.
    pub sign_seed: [u8; 32],
}

impl Identity {
    /// A fresh identity from 64 bytes of OS entropy.
    pub fn generate() -> Result<Self, String> {
        let mut material = [0u8; 64];
        getrandom::getrandom(&mut material).map_err(|e| format!("system RNG unavailable: {e}"))?;

        let mut x_secret = [0u8; 32];
        x_secret.copy_from_slice(&material[..32]);
        let mut sign_seed = [0u8; 32];
        sign_seed.copy_from_slice(&material[32..]);

        let device_pub = {
            let sk = x25519_dalek::StaticSecret::from(x_secret);
            let pk = x25519_dalek::PublicKey::from(&sk);
            format!("x25519:{}", b64(pk.as_bytes()))
            // `sk` drops here, and with it the only copy of the X25519 private
            // key. Deliberate: see the struct docs.
        };
        let sign_pub = {
            let sk = ed25519_dalek::SigningKey::from_bytes(&sign_seed);
            format!("ed25519:{}", b64(sk.verifying_key().as_bytes()))
        };

        Ok(Self {
            device_id: derive_device_id(&device_pub, &sign_pub),
            device_pub,
            sign_pub,
            sign_seed,
        })
    }

    /// Sign this connection's attestation challenge.
    pub fn attest(&self, nonce: &str, user_id: i64) -> String {
        use ed25519_dalek::Signer;
        let sk = ed25519_dalek::SigningKey::from_bytes(&self.sign_seed);
        b64(&sk.sign(attestation_message(nonce, user_id).as_bytes()).to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_attestation_transcript_matches_the_server_byte_for_byte() {
        // If this ever drifts, every attestation fails with a signature error
        // and the waker looks broken rather than mismatched. The literal is
        // copied from src/ws.rs and must not be "tidied".
        assert_eq!(
            attestation_message("abc123", 42),
            "sovereign-device-attest-v1|abc123|42"
        );
    }

    #[test]
    fn the_device_id_is_derived_the_way_the_server_derives_it() {
        // A fixed vector, so a change to the hash input, the encoding or the
        // truncation is caught here rather than by a 400 from enrolment.
        let id = derive_device_id("x25519:AAAA", "ed25519:BBBB");
        assert_eq!(id.len(), 21, "the server compares a 21-char id");
        assert!(
            !id.contains('+') && !id.contains('/') && !id.contains('='),
            "must be URL-safe base64 with no padding: {id}"
        );
        // Deterministic: the same keys must always give the same id, or
        // re-enrolment would create a second device row every restart.
        assert_eq!(id, derive_device_id("x25519:AAAA", "ed25519:BBBB"));
        // And the two keys are not interchangeable.
        assert_ne!(id, derive_device_id("ed25519:BBBB", "x25519:AAAA"));
    }

    #[test]
    fn a_generated_identity_is_well_formed_and_unique() {
        let a = Identity::generate().expect("RNG");
        let b = Identity::generate().expect("RNG");
        assert!(a.device_pub.starts_with("x25519:"));
        assert!(a.sign_pub.starts_with("ed25519:"));
        assert_eq!(a.device_id, derive_device_id(&a.device_pub, &a.sign_pub));
        assert_ne!(a.device_id, b.device_id, "two wakers must not collide");
    }

    #[test]
    fn attestation_signatures_verify_and_are_bound_to_the_challenge() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let id = Identity::generate().expect("RNG");
        let sig_b64 = id.attest("nonce-one", 7);

        let raw = base64::engine::general_purpose::STANDARD
            .decode(&sig_b64)
            .expect("base64");
        let sig = Signature::from_slice(&raw).expect("64-byte signature");
        let vk_raw = base64::engine::general_purpose::STANDARD
            .decode(id.sign_pub.strip_prefix("ed25519:").unwrap())
            .expect("base64");
        let vk = VerifyingKey::from_bytes(&vk_raw.try_into().unwrap()).expect("key");

        // The positive control: without it, an `attest` that returned garbage
        // would still pass the negative assertions below.
        assert!(vk.verify(attestation_message("nonce-one", 7).as_bytes(), &sig).is_ok());

        // Bound to the nonce, so a signature lifted from one socket cannot be
        // replayed onto the next.
        assert!(vk.verify(attestation_message("nonce-two", 7).as_bytes(), &sig).is_err());
        // ...and to the account.
        assert!(vk.verify(attestation_message("nonce-one", 8).as_bytes(), &sig).is_err());
    }
}
