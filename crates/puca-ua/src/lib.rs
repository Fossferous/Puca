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

/// Wrong passphrases in a row before the gate starts making the caller wait.
///
/// WHY A LIMIT AT ALL. One attempt per challenge stops a captured nonce being
/// ground offline, but nothing limited how fast challenges could be REQUESTED,
/// so whoever held the account password (the first factor) could guess this
/// second one online as fast as round trips allowed (0916 campaign, left open).
/// Five is room for honest typos; after that each further miss doubles the
/// wait, so a guesser gets about a hundred tries a day instead of thousands a
/// minute.
pub const FREE_FAILURES: u32 = 5;

/// The first wait, once `FREE_FAILURES` misses in a row have happened.
pub const FIRST_LOCKOUT_MS: u64 = 30_000;

/// The longest wait. The owner locked out by a guesser must still get in the
/// same day, and a wait this long already caps a guesser at ~100 tries a day.
pub const MAX_LOCKOUT_MS: u64 = 15 * 60_000;

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
    /// Too many wrong passphrases in a row: nothing is checked until the wait
    /// is over. Decided BEFORE any signature is looked at, so saying so leaks
    /// nothing about the guess, and the controller can tell its user when to
    /// try again.
    Throttled { retry_after_ms: u64 },
}

impl std::fmt::Display for UaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UaError::NotArmed => f.write_str("unattended access is not armed on this computer"),
            UaError::UnknownChallenge => f.write_str("that challenge is not known here"),
            UaError::Expired => f.write_str("that challenge expired"),
            UaError::BadSignature => f.write_str("wrong unattended passphrase"),
            UaError::Malformed(why) => f.write_str(why),
            UaError::Throttled { retry_after_ms } => {
                // Rounded UP, so "try again in 30 seconds" is never too early.
                let secs = retry_after_ms.div_ceil(1000).max(1);
                let when = if secs < 120 {
                    format!("{secs} seconds")
                } else {
                    format!("{} minutes", secs.div_ceil(60))
                };
                // The desktop app's host (session.ts) passes this on to the
                // controller only if it starts with "too many wrong unattended
                // passphrases"; keep that prefix, or the owner is told
                // "could not verify" instead.
                write!(f, "too many wrong unattended passphrases in a row; try again in {when}")
            }
        }
    }
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
    /// Wrong passphrases in a row since the last right one.
    failures: u32,
    /// Nothing is checked before this `now_ms` (0: no wait).
    locked_until_ms: u64,
}

impl Default for UaGate {
    fn default() -> Self {
        Self::new(DEFAULT_TTL_MS)
    }
}

impl UaGate {
    pub fn new(ttl_ms: u64) -> Self {
        Self { record: None, pending: HashMap::new(), ttl_ms, failures: 0, locked_until_ms: 0 }
    }

    /// Arm (or re-arm) the gate with a record the host loaded from disk or the
    /// user just set up. Re-arming with a new record invalidates every
    /// outstanding challenge — a passphrase change must not leave a challenge
    /// answerable under the old key.
    ///
    /// A DIFFERENT record also clears the wrong-passphrase count: that is the
    /// owner, at this machine, setting a new passphrase. The SAME record
    /// re-armed keeps it: the desktop app re-arms from disk before every
    /// challenge, and resetting there would reset the limit on every attempt.
    pub fn arm(&mut self, record: UaRecord) {
        if self.record.as_ref() != Some(&record) {
            self.failures = 0;
            self.locked_until_ms = 0;
        }
        self.record = Some(record);
        self.pending.clear();
    }

    /// Disarm — unattended access turned off. Clears the record and every
    /// pending challenge, so nothing issued while armed remains answerable.
    pub fn disarm(&mut self) {
        self.record = None;
        self.pending.clear();
        self.failures = 0;
        self.locked_until_ms = 0;
    }

    /// `Throttled` while a wait is running.
    ///
    /// No wait may run longer than `MAX_LOCKOUT_MS` from NOW: the agent's clock
    /// is wall time, and Windows setting it back during a wait would otherwise
    /// stretch 30 s into hours (a_clock_set_back_cannot_stretch_the_wait_past_the_cap).
    fn check_lockout(&mut self, now_ms: u64) -> Result<(), UaError> {
        self.locked_until_ms = self.locked_until_ms.min(now_ms.saturating_add(MAX_LOCKOUT_MS));
        if now_ms < self.locked_until_ms {
            return Err(UaError::Throttled { retry_after_ms: self.locked_until_ms - now_ms });
        }
        Ok(())
    }

    /// Count a wrong passphrase; from the `FREE_FAILURES`-th in a row on, start
    /// a wait that doubles with each further miss, up to `MAX_LOCKOUT_MS`.
    fn note_failure(&mut self, now_ms: u64) {
        self.failures = self.failures.saturating_add(1);
        if self.failures >= FREE_FAILURES {
            let doublings = (self.failures - FREE_FAILURES).min(16);
            let wait = FIRST_LOCKOUT_MS.saturating_mul(1u64 << doublings).min(MAX_LOCKOUT_MS);
            self.locked_until_ms = now_ms.saturating_add(wait);
        }
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
        self.check_lockout(now_ms)?;
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
        // Copied out (32 bytes) so the lockout check below can take `&mut self`.
        let verifying_key = self.record.as_ref().ok_or(UaError::NotArmed)?.verifying_key;

        // Look up and REMOVE atomically: one attempt per nonce, no matter the
        // outcome below.
        let issued_at = self.pending.remove(nonce).ok_or(UaError::UnknownChallenge)?;
        // AFTER the nonce is consumed and BEFORE the signature is looked at.
        // Checking only at issue would not be enough: up to MAX_PENDING
        // challenges can be collected while no wait is running and then all
        // answered at once, so a wait must also stop answers to challenges
        // issued before it began.
        self.check_lockout(now_ms)?;
        if now_ms.saturating_sub(issued_at) > self.ttl_ms {
            return Err(UaError::Expired);
        }

        let vk = VerifyingKey::from_bytes(&verifying_key)
            .map_err(|_| UaError::Malformed("stored key is not a valid Ed25519 point"))?;
        let sig_arr: [u8; 64] =
            signature.try_into().map_err(|_| UaError::Malformed("signature is not 64 bytes"))?;
        let sig = Signature::from_bytes(&sig_arr);

        match vk.verify_strict(&challenge_message(context, nonce), &sig) {
            Ok(()) => {
                self.failures = 0;
                Ok(())
            }
            Err(_) => {
                self.note_failure(now_ms);
                Err(UaError::BadSignature)
            }
        }
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

    // --- the wrong-passphrase limit ----------------------------------------

    /// One wrong guess at `now`: a fresh challenge, answered by the wrong key.
    fn miss(gate: &mut UaGate, now: u64) -> Result<(), UaError> {
        let nonce = gate.issue_challenge(now)?;
        gate.verify(&nonce, "ctx", &respond(&controller(99), "ctx", &nonce), now)
    }

    #[test]
    fn five_wrong_passphrases_in_a_row_start_a_wait() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        for i in 0..FREE_FAILURES {
            assert_eq!(miss(&mut gate, 1000), Err(UaError::BadSignature), "miss {i} is still checked");
        }
        assert_eq!(
            gate.issue_challenge(1000),
            Err(UaError::Throttled { retry_after_ms: FIRST_LOCKOUT_MS }),
            "the wait must begin at the FREE_FAILURES-th miss"
        );
        // Over when it says: a right answer then gets in.
        let later = 1000 + FIRST_LOCKOUT_MS;
        let nonce = gate.issue_challenge(later).expect("the wait is over");
        assert_eq!(gate.verify(&nonce, "ctx", &respond(&sk, "ctx", &nonce), later), Ok(()));
    }

    #[test]
    fn a_challenge_collected_before_the_wait_cannot_be_answered_during_it() {
        // The stockpile: collect challenges while no wait runs, then answer them
        // all. Checking only at issue would let every one of them be a guess.
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let stock: Vec<[u8; 32]> = (0..20).map(|_| gate.issue_challenge(1000).unwrap()).collect();
        let wrong = controller(99);
        for n in &stock[..FREE_FAILURES as usize] {
            assert_eq!(gate.verify(n, "ctx", &respond(&wrong, "ctx", n), 1000), Err(UaError::BadSignature));
        }
        // Even the RIGHT answer is not looked at during the wait: no guess of
        // any kind is evaluated, so the wait cannot be used to test guesses.
        let n = &stock[FREE_FAILURES as usize];
        assert!(matches!(
            gate.verify(n, "ctx", &respond(&sk, "ctx", n), 1001),
            Err(UaError::Throttled { .. })
        ));
    }

    #[test]
    fn each_further_miss_doubles_the_wait_up_to_the_cap() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let mut now = 1000;
        for _ in 0..FREE_FAILURES {
            miss(&mut gate, now).unwrap_err();
        }
        let mut expected = FIRST_LOCKOUT_MS;
        for _ in 0..8 {
            assert_eq!(gate.issue_challenge(now), Err(UaError::Throttled { retry_after_ms: expected }));
            now += expected; // wait it out...
            assert_eq!(miss(&mut gate, now), Err(UaError::BadSignature)); // ...and miss again
            expected = (expected * 2).min(MAX_LOCKOUT_MS);
        }
        assert_eq!(expected, MAX_LOCKOUT_MS, "eight doublings from 30 s must have reached the cap");
        assert_eq!(gate.issue_challenge(now), Err(UaError::Throttled { retry_after_ms: MAX_LOCKOUT_MS }));
    }

    #[test]
    fn a_right_passphrase_clears_the_count() {
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        for _ in 0..FREE_FAILURES - 1 {
            miss(&mut gate, 1000).unwrap_err();
        }
        let nonce = gate.issue_challenge(1000).unwrap();
        gate.verify(&nonce, "ctx", &respond(&sk, "ctx", &nonce), 1000).unwrap();
        // A fresh run of typos gets the full allowance again.
        for _ in 0..FREE_FAILURES - 1 {
            assert_eq!(miss(&mut gate, 1000), Err(UaError::BadSignature));
        }
        assert!(gate.issue_challenge(1000).is_ok(), "four misses after a success must not lock");
    }

    #[test]
    fn re_arming_the_same_record_keeps_the_wait_and_a_new_passphrase_clears_it() {
        // The desktop app re-arms from disk before EVERY challenge
        // (unattended_store.rs), so a reset on every arm would have reset the
        // limit on every attempt there, and it would never have engaged.
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        for _ in 0..FREE_FAILURES {
            miss(&mut gate, 1000).unwrap_err();
        }
        gate.arm(UaRecord::new([7u8; 16], sk.verifying_key().to_bytes())); // the same record
        assert!(
            matches!(gate.issue_challenge(1000), Err(UaError::Throttled { .. })),
            "re-arming the unchanged record must not lift the wait"
        );
        let new_sk = controller(2);
        gate.arm(UaRecord::new([8u8; 16], new_sk.verifying_key().to_bytes())); // a new passphrase
        assert!(gate.issue_challenge(1000).is_ok(), "the owner setting a new passphrase starts afresh");
    }

    #[test]
    fn a_clock_set_back_cannot_stretch_the_wait_past_the_cap() {
        // The agent's clock is wall time (SystemTime). Windows setting it back
        // hours during a wait would otherwise turn a 30 s wait into hours.
        let sk = controller(1);
        let mut gate = armed_gate(&sk);
        let t = 10_000_000_000;
        for _ in 0..FREE_FAILURES {
            miss(&mut gate, t).unwrap_err();
        }
        let back = t - 5 * 3_600_000; // five hours earlier
        match gate.issue_challenge(back) {
            Err(UaError::Throttled { retry_after_ms }) => {
                assert!(retry_after_ms <= MAX_LOCKOUT_MS, "waited {retry_after_ms} ms after the clock went back")
            }
            other => panic!("still throttled, but no longer than the cap: {other:?}"),
        }
        assert!(gate.issue_challenge(back + MAX_LOCKOUT_MS).is_ok(), "over by the cap at the latest");
    }

    #[test]
    fn the_wait_reads_as_a_sentence_the_controller_can_show() {
        assert_eq!(
            UaError::Throttled { retry_after_ms: 30_000 }.to_string(),
            "too many wrong unattended passphrases in a row; try again in 30 seconds"
        );
        assert_eq!(
            UaError::Throttled { retry_after_ms: 29_001 }.to_string(),
            "too many wrong unattended passphrases in a row; try again in 30 seconds",
            "rounded up, never too early"
        );
        assert_eq!(
            UaError::Throttled { retry_after_ms: MAX_LOCKOUT_MS }.to_string(),
            "too many wrong unattended passphrases in a row; try again in 15 minutes"
        );
    }
}
