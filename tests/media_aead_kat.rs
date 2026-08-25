//! S4 — the Rust half of the media frame AEAD cross-language contract.
//!
//! WHY: the native host agent (Phase 6 of the "My Devices" plan) must produce
//! and consume frames byte-identically to `frontend/src/api/rtc/mediaCrypto.ts`.
//! If the two drift, it presents as "video is broken", not "the crypto
//! disagrees" — a genuinely awful debugging session. This test pins the format
//! against the SAME fixture vitest asserts, so a change to either side that
//! isn't mirrored turns one of them red.
//!
//! The server itself never encrypts media (it relays opaque frames), so
//! `aes-gcm` is a dev-dependency here. The agent will take it as a real one and
//! should lift `clear_header_len` / `seal` / `open` below more or less verbatim.
//!
//! Wire format:
//!   [ clear header (AAD) | AES-256-GCM ciphertext+tag | iv(12) | magic "SVRN"(4) ]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::Deserialize;

const MAGIC: &[u8; 4] = b"SVRN";
const IV_LEN: usize = 12;
const TRAILER: usize = IV_LEN + MAGIC.len();
const GCM_TAG_LEN: usize = 16;
const MIN_ENCRYPTED_LEN: usize = GCM_TAG_LEN + TRAILER;

/// Mirrors CLEAR_HEADER in mediaCrypto.ts: video keyframe=10, delta=3, audio=1.
fn clear_header_len(frame_type: Option<&str>) -> usize {
    match frame_type {
        Some("key") => 10,
        Some("delta") => 3,
        _ => 1, // audio frames carry no `type`
    }
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    #[serde(rename = "frameType")]
    frame_type: Option<String>,
    #[serde(rename = "keyHex")]
    key_hex: String,
    #[serde(rename = "ivHex")]
    iv_hex: String,
    #[serde(rename = "plaintextHex")]
    plaintext_hex: String,
    #[serde(rename = "ciphertextHex")]
    ciphertext_hex: String,
    #[allow(dead_code)]
    note: String,
}

#[derive(Deserialize)]
struct Fixture {
    version: u32,
    vectors: Vec<Vector>,
}

fn load() -> Fixture {
    // Path is relative to CARGO_MANIFEST_DIR so `cargo test` works from anywhere.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/frontend/src/tests/fixtures/media-aead-kat.json"
    );
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!("cannot read KAT fixture at {path}: {e}\nRegenerate with: cd frontend && WRITE_KAT=1 npx vitest run src/tests/mediaCryptoKat.test.ts")
    });
    serde_json::from_str(&raw).expect("KAT fixture is not valid JSON")
}

fn cipher(key_hex: &str) -> Aes256Gcm {
    let raw = hex::decode(key_hex).expect("bad key hex");
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&raw))
}

/// Encrypt one frame exactly as `encryptFrame` does.
///
/// The header length is clamped by the PLAINTEXT length — a frame shorter than
/// its own clear header keeps a shorter header and an empty body. Getting this
/// wrong is the single easiest way for a port to diverge.
fn seal(plaintext: &[u8], frame_type: Option<&str>, key_hex: &str, iv: &[u8]) -> Vec<u8> {
    let n = clear_header_len(frame_type).min(plaintext.len());
    let (header, body) = plaintext.split_at(n);
    let ct = cipher(key_hex)
        .encrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: body,
                aad: header,
            },
        )
        .expect("encrypt");

    let mut out = Vec::with_capacity(n + ct.len() + TRAILER);
    out.extend_from_slice(header);
    out.extend_from_slice(&ct);
    out.extend_from_slice(iv);
    out.extend_from_slice(MAGIC);
    out
}

/// Decrypt one frame exactly as `decryptFrame` does. `None` == drop the frame.
fn open(data: &[u8], frame_type: Option<&str>, key_hex: &str) -> Option<Vec<u8>> {
    if data.len() < TRAILER || &data[data.len() - MAGIC.len()..] != MAGIC {
        return None; // not one of ours
    }
    if data.len() < MIN_ENCRYPTED_LEN {
        return None; // too short to be ours
    }
    // Recover the header length the SENDER used — clamped by the PLAINTEXT
    // length, which is exactly `len - GCM_TAG_LEN - TRAILER`. Clamping by the
    // ciphertext length here instead mis-splits header/ciphertext and fails
    // authentication on any frame shorter than its clear header.
    let plaintext_len = data.len() - GCM_TAG_LEN - TRAILER;
    let n = clear_header_len(frame_type).min(plaintext_len);

    let header = &data[..n];
    let iv_start = data.len() - TRAILER;
    let iv = &data[iv_start..iv_start + IV_LEN];
    let ct = &data[n..iv_start];

    let body = cipher(key_hex)
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: ct,
                aad: header,
            },
        )
        .ok()?;

    let mut out = Vec::with_capacity(n + body.len());
    out.extend_from_slice(header);
    out.extend_from_slice(&body);
    Some(out)
}

#[test]
fn fixture_is_present_and_current() {
    let f = load();
    assert_eq!(
        f.version, 1,
        "KAT fixture version changed — review the wire format"
    );
    assert!(!f.vectors.is_empty(), "fixture has no vectors");
}

/// Proves Rust WRITES the format identically to the TypeScript sender.
#[test]
fn rust_encrypt_matches_typescript_bytes() {
    for v in load().vectors {
        let plaintext = hex::decode(&v.plaintext_hex).expect("bad plaintext hex");
        let iv = hex::decode(&v.iv_hex).expect("bad iv hex");
        let got = seal(&plaintext, v.frame_type.as_deref(), &v.key_hex, &iv);
        assert_eq!(
            hex::encode(&got),
            v.ciphertext_hex,
            "vector `{}`: Rust encrypt diverged from mediaCrypto.ts",
            v.name
        );
    }
}

/// Proves Rust READS frames produced by the TypeScript sender.
#[test]
fn rust_decrypt_recovers_typescript_frames() {
    for v in load().vectors {
        let ciphertext = hex::decode(&v.ciphertext_hex).expect("bad ciphertext hex");
        let got = open(&ciphertext, v.frame_type.as_deref(), &v.key_hex)
            .unwrap_or_else(|| panic!("vector `{}`: Rust failed to decrypt", v.name));
        assert_eq!(
            hex::encode(&got),
            v.plaintext_hex,
            "vector `{}`: Rust decrypt produced the wrong plaintext",
            v.name
        );
    }
}

/// The clear header is bound as AAD; tampering with it must drop the frame.
/// If this ever passes, the header is not actually authenticated.
#[test]
fn tampered_clear_header_is_rejected() {
    let f = load();
    let v = f
        .vectors
        .iter()
        .find(|v| v.name == "video-key-10-byte-header")
        .expect("missing base vector");
    let mut bytes = hex::decode(&v.ciphertext_hex).unwrap();
    bytes[0] ^= 0xff;
    assert!(
        open(&bytes, v.frame_type.as_deref(), &v.key_hex).is_none(),
        "tampering with the AAD-bound header must fail authentication"
    );
}

/// A frame shorter than its own clear header round-trips. This is the exact
/// asymmetry the KAT caught in mediaCrypto.ts: such frames encrypted fine and
/// could never be decrypted, because decrypt clamped by ciphertext length.
#[test]
fn frame_shorter_than_its_clear_header_round_trips() {
    let key = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";
    let iv = hex::decode("000102030405060708090a0b").unwrap();
    for (plaintext_hex, ty) in [
        ("00010203", Some("key")), // 4 bytes, header wants 10
        ("7f", None),              // 1 byte audio, body empty
        ("ddeeff", Some("delta")), // exactly the header length
        ("", Some("key")),         // degenerate: nothing at all
    ] {
        let plaintext = hex::decode(plaintext_hex).unwrap();
        let sealed = seal(&plaintext, ty, key, &iv);
        let opened = open(&sealed, ty, key)
            .unwrap_or_else(|| panic!("{plaintext_hex:?} ({ty:?}) failed to round-trip"));
        assert_eq!(hex::encode(&opened), plaintext_hex);
    }
}
