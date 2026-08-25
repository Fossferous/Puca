//! The device-control session key, derived in the agent instead of above it.
//!
//! WHY THIS MOVED HERE, AND WHAT IT COSTS. `protocol.rs` says of `Inject`: "The
//! agent does no crypto: two owners for one secret is worse than one." That was
//! right while the desktop app was the only thing that ever held the key — it
//! owned the socket, the session, and the authorisation decision, and the agent
//! was a mechanism it drove.
//!
//! The sign-in screen breaks that. With nobody signed in there is no app, so the
//! SYSTEM service has to hold the socket — and if the key stays above the agent,
//! the process decrypting the owner's Windows password is a LocalSystem service
//! that also holds a public internet socket. Moving the key down does not add a
//! second owner; it MOVES the single owner to the process that already had to be
//! trusted with the keystrokes, because it is the one calling SendInput. The
//! comment's rule is satisfied, not broken.
//!
//! Today three host processes see plaintext keystrokes — the webview, the Tauri
//! process, and the agent. After this, one does.
//!
//! EVERY CONSTANT HERE IS A WIRE FORMAT, copied from `frontend/src/api/e2ee.ts`
//! and pinned by a known-answer test. A mismatch does not fail loudly: the
//! controller seals, the agent cannot open, and every keystroke is silently
//! dropped while both ends believe they are connected.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use sha2::Sha256;

/// `e2ee.ts` — `DEVICE_CONTROL_KDF_LABEL`.
const KDF_LABEL: &str = "sovereign-device-control-v1";
/// `e2ee.ts` — `PUBKEY_PREFIX`. Part of the KDF info, because the label is built
/// from the ENCODED keys, so the prefix is inside the hash.
const PUBKEY_PREFIX: &str = "x25519:";

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

pub fn encode_public_key(raw: &[u8]) -> String {
    format!("{PUBKEY_PREFIX}{}", b64().encode(raw))
}

pub fn decode_public_key(encoded: &str) -> Option<[u8; 32]> {
    let rest = encoded.strip_prefix(PUBKEY_PREFIX)?;
    b64().decode(rest).ok()?.try_into().ok()
}

/// Derive the session key both ends will use.
///
/// `static_shared` is X25519(this machine's device private key, the peer's
/// device public key) — the half that proves WHICH MACHINE is at the other end.
/// Identity keys would not do: between two devices of one account they are
/// identical, so a static DH over them degenerates into self-DH and
/// authenticates nothing.
///
/// The two ephemeral public keys are sorted as ENCODED STRINGS before going into
/// the info label, which is what makes both ends derive the same key without
/// agreeing who is "first". Sorting the raw bytes instead would agree only by
/// luck — base64 of the same bytes does not order the same way.
pub fn derive(
    static_shared: &[u8; 32],
    my_eph_priv: &[u8; 32],
    peer_eph_pub_encoded: &str,
) -> Option<[u8; 32]> {
    let peer_eph = decode_public_key(peer_eph_pub_encoded)?;

    let sk = x25519_dalek::StaticSecret::from(*my_eph_priv);
    let eph_shared = sk.diffie_hellman(&x25519_dalek::PublicKey::from(peer_eph));
    let my_eph_pub = encode_public_key(x25519_dalek::PublicKey::from(&sk).as_bytes());

    let (a, b) = if my_eph_pub <= peer_eph_pub_encoded.to_string() {
        (my_eph_pub.clone(), peer_eph_pub_encoded.to_string())
    } else {
        (peer_eph_pub_encoded.to_string(), my_eph_pub.clone())
    };
    let info = format!("{KDF_LABEL}|{a}|{b}");

    // ikm = ephemeral shared || static shared, in that order. Salt is absent,
    // matching `hkdf(sha256, ikm, undefined, info, 32)`.
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(eph_shared.as_bytes());
    ikm.extend_from_slice(static_shared);

    let hk = Hkdf::<Sha256>::new(None, &ikm);
    let mut out = [0u8; 32];
    hk.expand(info.as_bytes(), &mut out).ok()?;
    Some(out)
}

/// Open `base64(nonce(12) || ciphertext)`.
///
/// Returns None on ANY failure — bad base64, short blob, failed tag. A forged or
/// replayed frame and a corrupt one are the same answer here on purpose: the
/// caller has nothing useful to do differently, and distinguishing them in a log
/// is a decryption oracle.
pub fn open(key: &[u8; 32], blob_b64: &str) -> Option<String> {
    let blob = b64().decode(blob_b64).ok()?;
    if blob.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &[] })
        .ok()?;
    String::from_utf8(pt).ok()
}

/// Seal, for the answers the agent sends back.
pub fn seal(key: &[u8; 32], plaintext: &str) -> Option<String> {
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).ok()?;
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: &[] })
        .ok()?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Some(b64().encode(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE CROSS-LANGUAGE KNOWN-ANSWER TEST, and the only one here that can
    /// catch the failure that matters.
    ///
    /// Every other test in this file compares Rust to Rust: they would all pass
    /// happily while the agent derived a key the shipping controller never
    /// produces, and the symptom would be every keystroke silently dropped with
    /// both ends believing they were connected.
    ///
    /// This vector was produced by RUNNING frontend/src/api/e2ee.ts's own
    /// primitives — @noble/curves x25519 and @noble/hashes hkdf/sha256 — under
    /// node against the frontend's real node_modules. Regenerate it the same
    /// way if the derivation ever legitimately changes. NEVER paste whatever
    /// this code currently produces: that pins the bug instead of the contract.
    #[test]
    fn the_key_matches_the_javascript_byte_for_byte() {
        let static_shared = [7u8; 32];
        let a_priv = [1u8; 32];
        let b_pub = "x25519:zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=";

        // The encoded ephemeral public key the JS computed for the same private
        // key. Checked separately because if THIS disagrees, the sort order in
        // the KDF info differs and the key mismatch below would be explained by
        // encoding rather than by the derivation.
        let a_pub = encode_public_key(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(a_priv)).as_bytes(),
        );
        assert_eq!(a_pub, "x25519:pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=");

        let key = derive(&static_shared, &a_priv, b_pub).expect("derive");
        assert_eq!(
            hex(&key),
            "7edf227b446297e55de1318380afcd76a9a258ba581e7125deb17fba4ae7521a",
            "the agent and the shipping controller must derive the SAME key"
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn the_derivation_is_deterministic_and_order_independent() {
        let static_shared = [7u8; 32];
        let a_priv = [1u8; 32];
        let b_priv = [2u8; 32];
        let a_pub = encode_public_key(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(a_priv)).as_bytes(),
        );
        let b_pub = encode_public_key(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(b_priv)).as_bytes(),
        );

        let from_a = derive(&static_shared, &a_priv, &b_pub).expect("a derives");
        let from_b = derive(&static_shared, &b_priv, &a_pub).expect("b derives");

        // THE PROPERTY THE SORT EXISTS FOR. Without it each end hashes its own
        // key first, they derive different keys, and every frame fails to open
        // with no error anywhere.
        assert_eq!(from_a, from_b, "both ends must derive the same key");

        // Deterministic across runs, or a reconnect would need a fresh
        // handshake for no reason.
        assert_eq!(from_a, derive(&static_shared, &a_priv, &b_pub).unwrap());
    }

    #[test]
    fn a_different_static_half_gives_a_different_key() {
        // The static DH is what proves WHICH MACHINE is at the other end. If it
        // did not contribute, any device of the account could open the session —
        // which is exactly the self-DH degeneracy the derivation was designed
        // to avoid.
        let a_priv = [1u8; 32];
        let b_pub = encode_public_key(
            x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from([2u8; 32])).as_bytes(),
        );
        let k1 = derive(&[7u8; 32], &a_priv, &b_pub).unwrap();
        let k2 = derive(&[8u8; 32], &a_priv, &b_pub).unwrap();
        assert_ne!(k1, k2, "the static half must reach the output");
    }

    #[test]
    fn a_malformed_peer_key_is_refused_rather_than_guessed() {
        let a_priv = [1u8; 32];
        for bad in ["", "not-a-key", "ed25519:AAAA", "x25519:!!!", "x25519:AAAA"] {
            assert!(derive(&[7u8; 32], &a_priv, bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_sealed_round_trip_survives_and_a_tampered_one_does_not() {
        let key = [9u8; 32];
        let sealed = seal(&key, r#"{"s":1,"e":{"t":"move"}}"#).expect("seal");
        assert_eq!(open(&key, &sealed).as_deref(), Some(r#"{"s":1,"e":{"t":"move"}}"#));

        // Wrong key: no.
        assert!(open(&[8u8; 32], &sealed).is_none());

        // Flipped byte in the ciphertext: the tag must catch it. Without this
        // an attacker could corrupt injected input rather than merely replay it.
        let mut raw = b64().decode(&sealed).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert!(open(&key, &b64().encode(raw)).is_none(), "GCM must reject a tampered frame");

        // Truncated to nothing useful.
        assert!(open(&key, "AAAA").is_none());
        assert!(open(&key, "not base64!!").is_none());
    }

    #[test]
    fn the_wire_format_is_nonce_then_ciphertext() {
        // Pinned because the JS slices at exactly 12 bytes. A 16-byte nonce
        // here would produce blobs the shipping controller cannot open, and the
        // failure would look like a key mismatch rather than a framing bug.
        let sealed = seal(&[9u8; 32], "hi").expect("seal");
        let raw = b64().decode(sealed).unwrap();
        assert!(raw.len() >= 12 + 16, "nonce + tag at minimum");
        // 2 bytes of plaintext, 12 of nonce, 16 of tag.
        assert_eq!(raw.len(), 12 + 2 + 16);
    }
}
