//! Unattended-access passphrase gate — host side.
//!
//! WHY THIS EXISTS. Once a machine is armed for SYSTEM-level unattended access,
//! the compromise chain becomes "Puca account password -> SYSTEM on this
//! box, remotely, silently". A device grant alone is not enough of a barrier for
//! that: the account password can enrol a device from anywhere. So arming SYSTEM
//! requires a SECOND secret the server never sees and that is checked HERE, on
//! the host, at every connect — the unattended passphrase.
//!
//! THE SPLIT THAT KEEPS THE PASSPHRASE OFF THE HOST. The controller holds the
//! passphrase, runs `ua_seed = Argon2id(passphrase, salt)`, derives an Ed25519
//! keypair, and SIGNS the host's challenge. The host stores only `salt` (so the
//! controller can reproduce the derivation) and the Ed25519 PUBLIC key, and only
//! ever VERIFIES. The passphrase, the seed and the private key never touch the
//! host's disk or memory — so seizing an armed machine does not reveal the
//! passphrase, and there is no password KDF in this crate at all.
//!
//! WHAT THIS CRATE IS NOT. It does no I/O. Persisting a `UaRecord` at rest
//! (DPAPI machine-scope for the SYSTEM service; an ACL'd file) belongs to the
//! host app, exactly like `device_key.rs`. Keeping this pure is what makes the
//! gate exhaustively testable.
//!
//! THE WIRE CONTRACT (must match the controller's signer byte-for-byte):
//!
//! ```text
//! message = DOMAIN
//!         || len(context) as u32 LE || context bytes
//!         || nonce (32 bytes)
//! ```
//!
//! `DOMAIN` is a fixed ASCII tag with no interior NUL, and `context` is
//! length-prefixed, so no context value can be confused for the nonce or forge a
//! different framing. The controller signs exactly these bytes with the derived
//! key; the host verifies with `verify_strict`.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Domain-separation tag. Bump the suffix if the derivation or framing changes,
/// so an old signature can never validate under a new scheme.
pub const DOMAIN: &[u8] = b"sovereign-unattended-v1";

/// How long an issued challenge stays valid, in the caller's clock units (ms).
/// Short: a challenge is answered within one round-trip. A long window only
/// widens the interval in which a captured nonce could be replayed against a
/// stolen signature.
pub const DEFAULT_TTL_MS: u64 = 180_000;

/// Cap on outstanding challenges, so a peer that requests challenges without
/// answering cannot grow the pending map without bound.
const MAX_PENDING: usize = 64;

/// What the host persists to recognise the passphrase WITHOUT knowing it.
///
/// `salt` is the Argon2id salt the controller needs to reproduce the derivation;
/// `verifying_key` is the Ed25519 public key of the derived UA keypair. Neither
/// reveals the passphrase, and the private key exists only on the controller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UaRecord {
    /// Format version, so the record can evolve without misreading old bytes.
    pub version: u8,
    /// Argon2id salt (opaque to the host; handed back to the controller).
    pub salt: [u8; 16],
    /// Ed25519 public key of the unattended keypair.
    pub verifying_key: [u8; 32],
}

impl UaRecord {
    pub const VERSION: u8 = 1;

    /// Build a record from the pieces the controller produced during arming.
    pub fn new(salt: [u8; 16], verifying_key: [u8; 32]) -> Self {
        Self { version: Self::VERSION, salt, verifying_key }
    }
}

/// Why a verification did not pass. Distinct variants because the UI must be
/// able to tell "you were never armed" from "wrong passphrase" from "too slow".
#[derive(Debug, PartialEq, Eq)]
pub enum UaError {
    /// Unattended access is not armed on this host — no record.
    NotArmed,
    /// The nonce was never issued, was already consumed, or aged out. All three
    /// collapse to one answer on purpose: the caller learns nothing about which.
    UnknownChallenge,
    /// The challenge was issued but its TTL elapsed before the response arrived.
    Expired,
    /// The signature did not verify against the armed public key — the usual
    /// cause is a wrong passphrase.
    BadSignature,
    /// The stored key or the supplied signature was structurally invalid.
    Malformed(&'static str),
}

/// The bytes the controller signs and the host verifies. See the module doc.
///
/// Public because it IS the cross-language contract: the `unattended.ts`
/// controller must produce these exact bytes, and the shared KAT asserts both
/// sides against one fixture.
pub fn challenge_message(context: &str, nonce: &[u8; 32]) -> Vec<u8> {
    let ctx = context.as_bytes();
    let mut m = Vec::with_capacity(DOMAIN.len() + 4 + ctx.len() + 32);
    m.extend_from_slice(DOMAIN);
    m.extend_from_slice(&(ctx.len() as u32).to_le_bytes());
    m.extend_from_slice(ctx);
    m.extend_from_slice(nonce);
    m
}

/// The host-side gate: holds the armed record and the outstanding challenges.
///
/// Time is passed IN as `now_ms` on every call rather than read from a clock, so
/// expiry and single-use are deterministic under test. The host wraps it with a
/// real monotonic clock.
pub struct UaGate {
    record: Option<UaRecord>,
    /// nonce -> the `now_ms` at which it was issued.
    pending: HashMap<[u8; 32], u64>,
    ttl_ms: u64,
}

impl Default for UaGate {
    fn default() -> Self {
        Self::new(DEFAULT_TTL_MS)
    }
}

impl UaGate {
    pub fn new(ttl_ms: u64) -> Self {
        Self { record: None, pending: HashMap::new(), ttl_ms }
    }

    /// Arm (or re-arm) the gate with a record the host loaded from disk or the
    /// user just set up. Re-arming with a new record invalidates every
    /// outstanding challenge — a passphrase change must not leave a challenge
    /// answerable under the old key.
    pub fn arm(&mut self, record: UaRecord) {
        self.record = Some(record);
        self.pending.clear();
    }

    /// Disarm — unattended access turned off. Clears the record and every
    /// pending challenge, so nothing issued while armed remains answerable.
    pub fn disarm(&mut self) {
        self.record = None;
        self.pending.clear();
    }

    pub fn is_armed(&self) -> bool {
        self.record.is_some()
    }

    /// The salt to send the controller so it can reproduce the derivation, or
    /// `None` if not armed. The salt is not a secret; the passphrase is.
    pub fn salt(&self) -> Option<[u8; 16]> {
        self.record.as_ref().map(|r| r.salt)
    }

    /// Issue a fresh single-use challenge nonce, or `NotArmed`.
    ///
    /// Expired challenges are swept first; if the pending map is still at its
    /// cap, the oldest is evicted so a peer cannot pin the map full to deny
    /// service. The nonce is 32 random bytes — unguessable, so its mere presence
    /// in `pending` is what a valid response proves knowledge of.
    pub fn issue_challenge(&mut self, now_ms: u64) -> Result<[u8; 32], UaError> {
        if self.record.is_none() {
            return Err(UaError::NotArmed);
        }
        self.sweep_expired(now_ms);
        if self.pending.len() >= MAX_PENDING {
            if let Some(oldest) = self
                .pending
                .iter()
                .min_by_key(|(_, &t)| t)
                .map(|(k, _)| *k)
            {
                self.pending.remove(&oldest);
            }
        }
        let mut nonce = [0u8; 32];
        getrandom::getrandom(&mut nonce)
            .map_err(|_| UaError::Malformed("system RNG unavailable"))?;
        // A 32-byte collision is not a real risk, but if one ever occurred we
        // would reuse an issue time; insert unconditionally and move on.
        self.pending.insert(nonce, now_ms);
        Ok(nonce)
    }

    /// Verify a controller's response and CONSUME the nonce.
    ///
    /// The nonce is removed whether the signature passes OR fails: each issued
    /// challenge grants exactly one attempt, so a captured nonce cannot be used
    /// to grind signatures, and a genuine wrong-passphrase forces a fresh
    /// challenge round-trip (which the UI drives). `context` must be the same
    /// value the controller signed — bind it to this specific connection (host
    /// device id, controller device id, session id) so a signature captured on
    /// one connection cannot authorise another.
    pub fn verify(
        &mut self,
        nonce: &[u8; 32],
        context: &str,
        signature: &[u8],
        now_ms: u64,
    ) -> Result<(), UaError> {
        let record = self.record.as_ref().ok_or(UaError::NotArmed)?;

        // Look up and REMOVE atomically: one attempt per nonce, no matter the
        // outcome below.
        let issued_at = self.pending.remove(nonce).ok_or(UaError::UnknownChallenge)?;
        if now_ms.saturating_sub(issued_at) > self.ttl_ms {
            return Err(UaError::Expired);
        }

        let vk = VerifyingKey::from_bytes(&record.verifying_key)
            .map_err(|_| UaError::Malformed("stored key is not a valid Ed25519 point"))?;
        let sig_arr: [u8; 64] =
            signature.try_into().map_err(|_| UaError::Malformed("signature is not 64 bytes"))?;
        let sig = Signature::from_bytes(&sig_arr);

        vk.verify_strict(&challenge_message(context, nonce), &sig)
            .map_err(|_| UaError::BadSignature)
    }

    /// Drop challenges whose TTL has elapsed. Called before issuing; also safe
    /// to call periodically.
    fn sweep_expired(&mut self, now_ms: u64) {
        let ttl = self.ttl_ms;
        self.pending.retain(|_, &mut issued| now_ms.saturating_sub(issued) <= ttl);
    }

    /// Outstanding challenge count — for tests and diagnostics.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// A deterministic controller keypair from a fixed seed — no RNG, so tests
    /// are reproducible. Mirrors what Argon2id would hand the real controller.
    fn controller(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn armed_gate(sk: &SigningKey) -> UaGate {
        let mut gate = UaGate::new(DEFAULT_TTL_MS);
        gate.arm(UaRecord::new([7u8; 16], sk.verifying_key().to_bytes()));
        gate
    }

    /// Sign exactly what the host will verify — the controller's half of the
    /// contract, kept here so a framing change breaks the test loudly.
    fn respond(sk: &SigningKey, context: &str, nonce: &[u8; 32]) -> Vec<u8> {
        sk.sign(&challenge_message(context, nonce)).to_bytes().to_vec()
    }

    #[test]
    fn a_correct_response_passes_and_the_nonce_is_consumed() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        assert_eq!(gate.pending_len(), 1);

        let sig = respond(&sk, "host:ctrl:sess", &nonce);
        assert_eq!(gate.verify(&nonce, "host:ctrl:sess", &sig, 1100), Ok(()));
        // Single-use: the very same valid response must not work twice.
        assert_eq!(
            gate.verify(&nonce, "host:ctrl:sess", &sig, 1200),
            Err(UaError::UnknownChallenge),
            "a consumed nonce must not be replayable",
        );
        assert_eq!(gate.pending_len(), 0);
    }

    #[test]
    fn the_wrong_passphrase_is_rejected() {
        // A different signing key stands in for a wrong passphrase: Argon2id of
        // the wrong pass yields a different keypair.
        let armed = controller(1);
        let attacker = controller(2);
        let mut gate = armed_gate(&armed);
        let nonce = gate.issue_challenge(1000).unwrap();
        let sig = respond(&attacker, "ctx", &nonce);
        assert_eq!(gate.verify(&nonce, "ctx", &sig, 1000), Err(UaError::BadSignature));
    }

    #[test]
    fn a_signature_for_a_different_context_does_not_authorise_this_one() {
        // The core replay defence: a signature captured on connection A must not
        // authorise connection B. Context is bound into the signed bytes.
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        let sig_for_a = respond(&sk, "host:ctrl:SESSION-A", &nonce);
        assert_eq!(
            gate.verify(&nonce, "host:ctrl:SESSION-B", &sig_for_a, 1000),
            Err(UaError::BadSignature),
            "a response signed for one context must not verify under another",
        );
    }

    #[test]
    fn a_tampered_nonce_is_unknown() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        let sig = respond(&sk, "ctx", &nonce);
        let mut forged = nonce;
        forged[0] ^= 0xFF;
        // A nonce we never issued is indistinguishable from consumed/expired.
        assert_eq!(gate.verify(&forged, "ctx", &sig, 1000), Err(UaError::UnknownChallenge));
        // ...and the real nonce is still answerable (the forged attempt must not
        // have consumed it).
        assert_eq!(gate.verify(&nonce, "ctx", &sig, 1000), Ok(()));
    }

    #[test]
    fn an_expired_challenge_is_refused() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        let sig = respond(&sk, "ctx", &nonce);
        // One millisecond past the TTL.
        let too_late = 1000 + DEFAULT_TTL_MS + 1;
        assert_eq!(gate.verify(&nonce, "ctx", &sig, too_late), Err(UaError::Expired));
    }

    #[test]
    fn a_response_exactly_at_the_ttl_boundary_still_passes() {
        // Off-by-one guard: the boundary is inclusive, so a response that lands
        // exactly on the TTL is honoured rather than rejected as a race.
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        let sig = respond(&sk, "ctx", &nonce);
        assert_eq!(gate.verify(&nonce, "ctx", &sig, 1000 + DEFAULT_TTL_MS), Ok(()));
    }

    #[test]
    fn a_failed_attempt_burns_the_nonce() {
        // Grind defence: one wrong signature must not leave the nonce available
        // for a second guess. Each challenge is one shot.
        let armed = controller(1);
        let attacker = controller(2);
        let mut gate = armed_gate(&armed);
        let nonce = gate.issue_challenge(1000).unwrap();
        let bad = respond(&attacker, "ctx", &nonce);
        assert_eq!(gate.verify(&nonce, "ctx", &bad, 1000), Err(UaError::BadSignature));
        // The correct signature now fails too, because the nonce is gone.
        let good = respond(&armed, "ctx", &nonce);
        assert_eq!(
            gate.verify(&nonce, "ctx", &good, 1000),
            Err(UaError::UnknownChallenge),
            "a burned nonce cannot be retried even with the right key",
        );
    }

    #[test]
    fn an_unarmed_gate_refuses_everything() {
        let mut gate = UaGate::new(DEFAULT_TTL_MS);
        assert!(!gate.is_armed());
        assert_eq!(gate.issue_challenge(0), Err(UaError::NotArmed));
        assert_eq!(gate.salt(), None);
        assert_eq!(gate.verify(&[0u8; 32], "ctx", &[0u8; 64], 0), Err(UaError::NotArmed));
    }

    #[test]
    fn disarming_invalidates_outstanding_challenges() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        gate.disarm();
        let sig = respond(&sk, "ctx", &nonce);
        assert_eq!(gate.verify(&nonce, "ctx", &sig, 1000), Err(UaError::NotArmed));
    }

    #[test]
    fn re_arming_with_a_new_key_invalidates_old_challenges() {
        // A passphrase change must not leave a challenge answerable under the
        // old key — else rotating the passphrase would not actually revoke the
        // old one until the TTL lapsed.
        let old = controller(1);
        let new = controller(9);
        let mut gate = armed_gate(&old);
        let nonce = gate.issue_challenge(1000).unwrap();
        gate.arm(UaRecord::new([7u8; 16], new.verifying_key().to_bytes()));
        let sig = respond(&old, "ctx", &nonce);
        assert_eq!(
            gate.verify(&nonce, "ctx", &sig, 1000),
            Err(UaError::UnknownChallenge),
            "a challenge issued before re-arming must not survive it",
        );
    }

    #[test]
    fn the_pending_map_cannot_grow_without_bound() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        for i in 0..(MAX_PENDING + 50) {
            gate.issue_challenge(1000 + i as u64).unwrap();
        }
        assert!(
            gate.pending_len() <= MAX_PENDING,
            "an unanswered flood of challenges must be capped, got {}",
            gate.pending_len(),
        );
    }

    #[test]
    fn a_malformed_signature_length_is_reported_not_panicked() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let nonce = gate.issue_challenge(1000).unwrap();
        assert_eq!(
            gate.verify(&nonce, "ctx", &[0u8; 10], 1000),
            Err(UaError::Malformed("signature is not 64 bytes")),
        );
    }

    #[test]
    fn the_record_round_trips_through_json() {
        // The host persists this; a serde change that dropped a field would
        // silently un-arm or mis-key the gate on the next load.
        let rec = UaRecord::new([3u8; 16], [5u8; 32]);
        let back: UaRecord = serde_json::from_str(&serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(rec, back);
        assert_eq!(back.version, UaRecord::VERSION);
    }

    #[test]
    fn the_signed_message_framing_is_unambiguous() {
        // Two different (context, nonce) pairs must never produce the same bytes.
        // If context were not length-prefixed, "a" + nonce starting 0x62('b')
        // could collide with "ab" + a different nonce. Pin that it does not.
        let n = [0u8; 32];
        assert_ne!(challenge_message("a", &n), challenge_message("ab", &n));
        let mut n2 = [0u8; 32];
        n2[0] = 1;
        assert_ne!(challenge_message("a", &n), challenge_message("a", &n2));
    }
}
