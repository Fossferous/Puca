//! An encrypted body's envelope version must never go DOWN on an edit —
//! unless the editor proves it could read what it is replacing.
//!
//! The client seals message bodies and checklist items into JSON envelopes
//! `{"v":N,"t":...,"ct":...}` the server never opens. When a NEWER client
//! writes a newer envelope version (v3 binds the row's channel/epoch/author
//! into the AES-GCM tag), a client that predates the v3 READER cannot parse
//! it: its reader falls back to "legacy plaintext" and renders the raw
//! envelope JSON as the text, badged "Not encrypted". If that user then EDITS
//! the item, the old client re-seals the JSON it displayed as the new body —
//! under its own, older format — and the real ciphertext is gone. Messages
//! keep an edit history; checklist items do not, so for them that is
//! permanent loss.
//!
//! The server can see `v` (it is plaintext metadata in the envelope it already
//! stores), so it refuses a sealed body being replaced by an OLDER envelope
//! version, or by non-envelope content — with one exception. A READER-FIRST
//! client (one release reads v3 while still writing v2, exactly how v3 was
//! rolled out) re-seals the real plaintext and loses only the binding, which
//! is a legitimate edit. Such a client says so with `reads_up_to` on the edit
//! request: the highest envelope version it can open. A downgrade is refused
//! only when the editor did not claim to read the stored version.
//!
//! DELIBERATE TRADE. 0.8.135 (reads v3, writes v2) predates `reads_up_to`, so
//! its edits of v3 bodies are refused until it updates — the message says so,
//! and the update banner is one click. The alternative, allowing v3 -> v2
//! unconditionally, would let a pre-0.8.135 client destroy checklist items
//! for everyone. A temporary "update to edit" beats permanent loss.
//!
//! Clearing an attachment sidecar (empty string) is a deletion, not a
//! downgrade, and is allowed for everyone. Sealed -> plaintext is refused
//! regardless: every writer seals, so no honest edit produces plaintext.

/// The envelope version of a stored body, or None for anything that is not an
/// envelope (legacy plaintext, malformed JSON, JSON without a string `ct`).
/// An integral float (`3.0`) counts as its integer, matching the client's
/// `typeof v === 'number'` check.
pub fn envelope_version(content: &str) -> Option<u64> {
    let t = content.trim_start();
    if !t.starts_with('{') {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    let obj = v.as_object()?;
    if !obj.get("ct").map(|c| c.is_string()).unwrap_or(false) {
        return None;
    }
    let ver = obj.get("v")?;
    ver.as_u64().or_else(|| {
        ver.as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0 && f.fract() == 0.0)
            .map(|f| f as u64)
    })
}

/// True when replacing `old` with `new` would take a sealed body to an older
/// envelope version the editor did not claim to be able to read, or to
/// non-envelope content.
pub fn edit_is_downgrade(old: &str, new: &str, reads_up_to: Option<u64>) -> bool {
    match (envelope_version(old), envelope_version(new)) {
        (Some(o), Some(n)) => n < o && reads_up_to.map_or(true, |r| r < o),
        (Some(_), None) => true,
        _ => false,
    }
}

/// The refusal the client shows. Deliberately says what to DO.
pub const DOWNGRADE_MESSAGE: &str =
    "This app version writes an older format than this item uses — update the app to edit it";

#[cfg(test)]
mod tests {
    use super::*;

    const V2: &str = r#"{"v":2,"t":"ch","epoch":3,"ct":"AAAA"}"#;
    const V3: &str = r#"{"v":3,"t":"ch","epoch":3,"ct":"AAAA"}"#;

    #[test]
    fn reads_the_version_and_ignores_non_envelopes() {
        assert_eq!(envelope_version(V2), Some(2));
        assert_eq!(envelope_version(V3), Some(3));
        assert_eq!(envelope_version(r#"  {"v":3,"t":"dm","ct":"x"}"#), Some(3));
        assert_eq!(envelope_version(r#"{"v":3.0,"t":"dm","ct":"x"}"#), Some(3), "integral float = its integer");
        assert_eq!(envelope_version(r#"{"v":2.5,"t":"dm","ct":"x"}"#), None);
        assert_eq!(envelope_version(r#"{"v":-1,"t":"dm","ct":"x"}"#), None);
        assert_eq!(envelope_version("hello"), None);
        assert_eq!(envelope_version(r#"{"v":3}"#), None, "no ct: not an envelope");
        assert_eq!(envelope_version(r#"{"v":"3","ct":"x"}"#), None, "v must be a number");
        assert_eq!(envelope_version(r#"{"v":3,"ct":{"a":1}}"#), None, "ct must be a string");
        assert_eq!(envelope_version("{not json"), None);
        assert_eq!(envelope_version(""), None);
    }

    #[test]
    fn a_newer_client_may_upgrade_and_rewrite_but_a_stale_one_may_not_downgrade() {
        assert!(!edit_is_downgrade(V2, V3, None), "v2 -> v3 is an upgrade");
        assert!(!edit_is_downgrade(V3, V3, None), "same version is a rewrite");
        assert!(!edit_is_downgrade("legacy plaintext", V2, None), "sealing a legacy row is an upgrade");
        assert!(!edit_is_downgrade("legacy plaintext", "still plaintext", None));
        assert!(edit_is_downgrade(V3, V2, None), "no claim of reading v3: the stale re-seal, refused");
        assert!(edit_is_downgrade(V3, "raw text", None), "sealed -> plaintext: refused");
        assert!(edit_is_downgrade(V2, "raw text", None));
    }

    #[test]
    fn a_reader_first_client_that_could_open_the_body_may_write_the_older_format() {
        assert!(!edit_is_downgrade(V3, V2, Some(3)), "read v3, writes v2: loses only the binding");
        assert!(!edit_is_downgrade(V3, V2, Some(4)));
        assert!(edit_is_downgrade(V3, V2, Some(2)), "claims to read only v2: the stale re-seal");
        assert!(edit_is_downgrade(V3, "raw text", Some(3)), "plaintext is never an honest edit");
        assert!(!edit_is_downgrade(V3, V3, Some(2)), "no downgrade, the claim is irrelevant");
    }
}
