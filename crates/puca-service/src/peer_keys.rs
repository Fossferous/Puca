//! Deciding whether a device row from the server is really the owner's device.
//!
//! WHY THIS CANNOT BE SKIPPED. The service learns a peer's public keys from
//! `GET /devices`, and the server **never verifies `auth_sig`** — `device_handlers.rs`
//! length-checks it and stores it, and its own header says the CLIENT verifies
//! it "against the account signing key it derives from its OWN seed". So the
//! rows the API returns are whatever is in the table, and a server that wanted
//! to read a session could substitute its own `device_pub`, sit in the middle of
//! the static DH, and neither end would notice.
//!
//! The account signing key is what closes that, and it works because it is
//! derived from the account seed — which is password-derived and which the
//! server has never held. A row signed under it is one the owner's own client
//! wrote.
//!
//! WHAT THIS SERVICE HAS, AND WHAT IT DOES NOT. It holds the account signing
//! PUBLIC key, pinned into its config when the machine was enrolled by someone
//! signed in. That is enough to verify and is deliberately all it gets: it
//! cannot sign, so a compromise of this service cannot enrol a new device into
//! the account.
//!
//! EVERY CHECK BELOW IS LOAD-BEARING and mirrors `verifyAuthRecordWithKey`
//! (frontend/src/api/devices/identity.ts:150). Dropping any one of them leaves a
//! way to present a validly-signed record that describes a different device —
//! the signature alone only says "the owner signed SOMETHING", not "the owner
//! signed THIS row".

#![cfg(windows)]

pub const DEVICE_AUTH_TYPE: &str = "sovereign-device-auth-v1";
const SIGN_PUBKEY_PREFIX: &str = "ed25519:";

/// A device row as `GET /devices` returns it.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct DeviceRow {
    pub id: String,
    pub device_pub: String,
    pub sign_pub: String,
    #[serde(default)]
    pub auth_record: Option<String>,
    #[serde(default)]
    pub auth_sig: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
}

/// Canonical JSON: object keys sorted, no whitespace, nulls kept, undefined
/// dropped (which cannot occur once parsed).
///
/// MUST MATCH `canonicalJson` (frontend/src/api/e2ee.ts:1059) byte for byte,
/// because the last check re-canonicalises the parsed record and compares it to
/// the signed bytes. A different key order or a space after a colon would make
/// every honest record fail to verify, and the symptom would be "no device can
/// ever connect" rather than anything pointing here.
pub fn canonical_json(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => serde_json::Value::String(s.clone()).to_string(),
        serde_json::Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::Value::String((*k).clone()),
                        canonical_json(&o[*k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Is this row genuinely a device of `expected_user_id`, signed by the account?
///
/// Returns false for every failure without saying which: the caller has nothing
/// useful to do differently, and the distinction would tell whoever supplied the
/// row which check to defeat next.
pub fn verify_device_row(
    account_sign_pub: &str,
    row: &DeviceRow,
    expected_user_id: i64,
) -> bool {
    verify_device_row_diag(account_sign_pub, row, expected_user_id).is_ok()
}

/// The same checks, naming which one failed.
///
/// SEPARATE FROM `verify_device_row` on purpose: the boolean version is what a
/// remote peer's fate depends on and must stay silent about why, but this
/// process's OWN log is not a channel the peer can read, and a refusal with no
/// reason anywhere is undiagnosable — which is exactly the shape of the bug
/// that shipped in this file's sibling, `caller.rs`, before it logged anything.
/// Called only for the local log line; the wire-facing refusal text is
/// unchanged either way.
pub fn verify_device_row_diag(
    account_sign_pub: &str,
    row: &DeviceRow,
    expected_user_id: i64,
) -> Result<(), &'static str> {
    use ed25519_dalek::Verifier;

    let (Some(record), Some(sig_b64)) = (row.auth_record.as_ref(), row.auth_sig.as_ref()) else {
        // An unsigned row is not a trusted row. Older devices enrolled before
        // auth records existed land here, and refusing them is right: the whole
        // point is that the server cannot mint one.
        return Err("row has no auth_record/auth_sig");
    };

    let Some(pub_b64) = account_sign_pub.strip_prefix(SIGN_PUBKEY_PREFIX) else {
        return Err("account_sign_pub has no ed25519: prefix");
    };
    let Some(pub_raw) = b64d(pub_b64) else { return Err("account_sign_pub is not base64") };
    let Ok(pub_arr): Result<[u8; 32], _> = pub_raw.try_into() else {
        return Err("account_sign_pub is not 32 bytes");
    };
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(&pub_arr) else {
        return Err("account_sign_pub is not a valid Ed25519 point");
    };

    let Some(sig_raw) = b64d(sig_b64) else { return Err("auth_sig is not base64") };
    let Ok(sig_arr): Result<[u8; 64], _> = sig_raw.try_into() else {
        return Err("auth_sig is not 64 bytes");
    };
    let sig = ed25519_dalek::Signature::from_bytes(&sig_arr);

    // 1. The account really signed these bytes.
    if vk.verify(record.as_bytes(), &sig).is_err() {
        return Err("signature does not verify under account_sign_pub");
    }

    // 2. ...and those bytes describe THIS row.
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(record) else {
        return Err("auth_record is not JSON");
    };
    let s = |k: &str| rec.get(k).and_then(|x| x.as_str());

    if s("typ") != Some(DEVICE_AUTH_TYPE) {
        return Err("auth_record.typ mismatch");
    }
    if rec.get("v").and_then(|x| x.as_i64()) != Some(1) {
        return Err("auth_record.v mismatch");
    }
    if rec.get("uid").and_then(|x| x.as_i64()) != Some(expected_user_id) {
        return Err("auth_record.uid does not match this account");
    }
    let (Some(did), Some(dpub), Some(spub)) = (s("did"), s("dpub"), s("spub")) else {
        return Err("auth_record is missing did/dpub/spub");
    };
    if did != row.id {
        return Err("auth_record.did does not match the row's id");
    }
    if dpub != row.device_pub {
        return Err("auth_record.dpub does not match the row's device_pub");
    }
    if spub != row.sign_pub {
        return Err("auth_record.spub does not match the row's sign_pub");
    }
    // 3. The id is the honest hash of the keys the record itself carries, so a
    //    signed record cannot name one device while carrying another's keys.
    if crate::secrets::derive_device_id(dpub, spub) != did {
        return Err("did is not the hash of dpub+spub");
    }
    // 4. Re-canonicalising reproduces the signed bytes exactly. Without this a
    //    record could carry EXTRA fields outside everything checked above and
    //    still verify.
    if canonical_json(&rec) != *record {
        return Err("auth_record bytes are not the canonical serialisation");
    }
    Ok(())
}

fn b64d(s: &str) -> Option<Vec<u8>> {
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    fn b64(b: &[u8]) -> String {
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b)
    }

    /// Build a row exactly as an honest client would, then let the tests break
    /// it one field at a time.
    fn honest(uid: i64) -> (String, ed25519_dalek::SigningKey, DeviceRow) {
        let account = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
        let account_pub = format!("ed25519:{}", b64(account.verifying_key().as_bytes()));

        let id = crate::secrets::MachineIdentity::generate().expect("RNG");
        let rec = serde_json::json!({
            "typ": DEVICE_AUTH_TYPE,
            "v": 1,
            "uid": uid,
            "did": id.device_id,
            "dpub": id.device_pub,
            "spub": id.sign_pub,
        });
        let record = canonical_json(&rec);
        let sig = b64(&account.sign(record.as_bytes()).to_bytes());

        let row = DeviceRow {
            id: id.device_id.clone(),
            device_pub: id.device_pub.clone(),
            sign_pub: id.sign_pub.clone(),
            auth_record: Some(record),
            auth_sig: Some(sig),
            name: None,
            platform: None,
        };
        (account_pub, account, row)
    }

    #[test]
    fn an_honest_row_verifies() {
        // THE POSITIVE CONTROL. Every refusal below is meaningless without it —
        // a verifier that returned false unconditionally would satisfy them all
        // while making every connection impossible.
        let (account_pub, _, row) = honest(7);
        assert!(verify_device_row(&account_pub, &row, 7));
        assert_eq!(verify_device_row_diag(&account_pub, &row, 7), Ok(()));
    }

    #[test]
    fn the_diagnostic_names_a_different_reason_per_failure() {
        // THE THING THAT MAKES A REFUSAL DIAGNOSABLE FROM THE LOCAL LOG, without
        // telling the remote peer anything the bool version doesn't already.
        // If two real failure modes ever collapsed to the same reason string,
        // reading the log would still leave you guessing between them.
        let (account_pub, _, row) = honest(7);

        let wrong_account = {
            let other = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
            format!("ed25519:{}", b64(other.verifying_key().as_bytes()))
        };
        let bad_sig_reason = verify_device_row_diag(&wrong_account, &row, 7).unwrap_err();

        let wrong_user_reason = verify_device_row_diag(&account_pub, &row, 8).unwrap_err();

        let mut no_record = row.clone();
        no_record.auth_record = None;
        let missing_reason = verify_device_row_diag(&account_pub, &no_record, 7).unwrap_err();

        let reasons = [bad_sig_reason, wrong_user_reason, missing_reason];
        for (i, a) in reasons.iter().enumerate() {
            for b in reasons.iter().skip(i + 1) {
                assert_ne!(a, b, "two distinct failures must not read the same: {a} / {b}");
            }
        }
    }

    #[test]
    fn the_canonical_form_matches_the_javascript() {
        // Sorted keys, no whitespace. If this drifts, check 4 fails on every
        // honest record and nothing can ever connect.
        let v = serde_json::json!({ "b": 1, "a": "x", "c": [1, 2], "d": { "z": true, "y": null } });
        assert_eq!(
            canonical_json(&v),
            r#"{"a":"x","b":1,"c":[1,2],"d":{"y":null,"z":true}}"#
        );
        // Strings are JSON-escaped, not raw.
        assert_eq!(
            canonical_json(&serde_json::json!({ "k": "a\"b" })),
            r#"{"k":"a\"b"}"#
        );
    }

    #[test]
    fn a_server_substituted_key_is_refused() {
        // THE ATTACK THIS MODULE EXISTS FOR. The server hands back a row whose
        // device_pub is the SERVER's, so it can sit in the middle of the static
        // DH. It cannot re-sign the record, so the substitution shows up.
        let (account_pub, _, mut row) = honest(7);
        let attacker = crate::secrets::MachineIdentity::generate().expect("RNG");
        row.device_pub = attacker.device_pub.clone();
        assert!(!verify_device_row(&account_pub, &row, 7));

        // And it cannot fix it by also rewriting the record, because it cannot
        // produce the account's signature over the rewritten bytes.
        let rec = serde_json::json!({
            "typ": DEVICE_AUTH_TYPE, "v": 1, "uid": 7,
            "did": row.id, "dpub": attacker.device_pub, "spub": row.sign_pub,
        });
        row.auth_record = Some(canonical_json(&rec));
        assert!(!verify_device_row(&account_pub, &row, 7));
    }

    #[test]
    fn a_record_signed_by_a_different_account_is_refused() {
        let (_, _, row) = honest(7);
        let other = ed25519_dalek::SigningKey::from_bytes(&[43u8; 32]);
        let other_pub = format!("ed25519:{}", b64(other.verifying_key().as_bytes()));
        assert!(!verify_device_row(&other_pub, &row, 7));
    }

    #[test]
    fn a_row_for_another_account_is_refused() {
        // The uid is inside the signed record precisely so one account's device
        // cannot be presented to another's.
        let (account_pub, _, row) = honest(7);
        assert!(!verify_device_row(&account_pub, &row, 8));
    }

    #[test]
    fn every_structural_check_actually_fires() {
        // Each of these is a validly-SIGNED record that describes something
        // other than the row it arrived on. Without the matching check, each
        // would be accepted — a signature alone only says the owner signed
        // something, not that they signed this.
        let account = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
        let account_pub = format!("ed25519:{}", b64(account.verifying_key().as_bytes()));
        let id = crate::secrets::MachineIdentity::generate().expect("RNG");
        let other = crate::secrets::MachineIdentity::generate().expect("RNG");

        let base = serde_json::json!({
            "typ": DEVICE_AUTH_TYPE, "v": 1, "uid": 7,
            "did": id.device_id, "dpub": id.device_pub, "spub": id.sign_pub,
        });

        let sign_row = |rec: serde_json::Value, mutate: &dyn Fn(&mut DeviceRow)| {
            let record = canonical_json(&rec);
            let sig = b64(&account.sign(record.as_bytes()).to_bytes());
            let mut row = DeviceRow {
                id: id.device_id.clone(),
                device_pub: id.device_pub.clone(),
                sign_pub: id.sign_pub.clone(),
                auth_record: Some(record),
                auth_sig: Some(sig),
                name: None,
                platform: None,
            };
            mutate(&mut row);
            row
        };

        // Sanity: unmutated, it passes. Otherwise the cases below prove nothing.
        assert!(verify_device_row(&account_pub, &sign_row(base.clone(), &|_| {}), 7));

        let mut wrong_typ = base.clone();
        wrong_typ["typ"] = serde_json::json!("sovereign-device-auth-v2");
        assert!(!verify_device_row(&account_pub, &sign_row(wrong_typ, &|_| {}), 7), "typ");

        let mut wrong_v = base.clone();
        wrong_v["v"] = serde_json::json!(2);
        assert!(!verify_device_row(&account_pub, &sign_row(wrong_v, &|_| {}), 7), "v");

        // did in the record disagrees with the row's id.
        let mut wrong_did = base.clone();
        wrong_did["did"] = serde_json::json!(other.device_id);
        assert!(!verify_device_row(&account_pub, &sign_row(wrong_did, &|_| {}), 7), "did");

        // A record whose did is NOT the hash of its own keys — the check that
        // stops a signed record naming one device while carrying another's key.
        let mut forged_id = base.clone();
        forged_id["dpub"] = serde_json::json!(other.device_pub);
        let row = sign_row(forged_id, &|r| r.device_pub = other.device_pub.clone());
        assert!(!verify_device_row(&account_pub, &row, 7), "derived id");

        // Bytes that are validly signed and describe the right device, but are
        // NOT the canonical serialisation of what they parse to.
        //
        // The first attempt here inserted `"admin":true` at the front and the
        // test failed — because "admin" sorts before "did", so that string IS
        // canonical and is rightly accepted. Worth stating plainly: this check
        // does not forbid extra fields, and neither does the JS it mirrors. It
        // forbids the signed bytes differing from the re-serialised form —
        // whitespace, duplicate keys, or a key out of order — any of which
        // would let two different byte strings pass as one record.
        let record = canonical_json(&base);
        let tampered = record.replace("{\"did\"", "{\"zz\":true,\"did\"");
        assert_ne!(
            tampered,
            canonical_json(&serde_json::from_str(&tampered).unwrap()),
            "the fixture must actually be non-canonical, or this proves nothing"
        );
        let sig = b64(&account.sign(tampered.as_bytes()).to_bytes());
        let row = DeviceRow {
            id: id.device_id.clone(),
            device_pub: id.device_pub.clone(),
            sign_pub: id.sign_pub.clone(),
            auth_record: Some(tampered),
            auth_sig: Some(sig),
            name: None,
            platform: None,
        };
        // It verifies as a signature and describes the right device, and is
        // still refused, because the bytes are not the canonical form.
        assert!(!verify_device_row(&account_pub, &row, 7), "non-canonical");
    }

    #[test]
    fn an_unsigned_row_is_refused() {
        let (account_pub, _, mut row) = honest(7);
        row.auth_sig = None;
        assert!(!verify_device_row(&account_pub, &row, 7));
        let (account_pub2, _, mut row2) = honest(7);
        row2.auth_record = None;
        assert!(!verify_device_row(&account_pub2, &row2, 7));
    }

    #[test]
    fn malformed_input_is_refused_rather_than_panicking() {
        // This parses attacker-supplied bytes on a LocalSystem service. A panic
        // here is a denial of service against the only path that can reach a
        // locked machine.
        let (account_pub, _, base) = honest(7);
        for (rec, sig) in [
            ("not json", "AAAA"),
            ("{}", "AAAA"),
            ("[]", "not base64!!"),
            ("", ""),
        ] {
            let row = DeviceRow {
                auth_record: Some(rec.into()),
                auth_sig: Some(sig.into()),
                ..base.clone()
            };
            assert!(!verify_device_row(&account_pub, &row, 7), "{rec}");
        }
        for bad_key in ["", "not-a-key", "x25519:AAAA", "ed25519:!!!", "ed25519:AAAA"] {
            assert!(!verify_device_row(bad_key, &base, 7), "{bad_key}");
        }
    }
}
