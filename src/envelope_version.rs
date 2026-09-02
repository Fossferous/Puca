//! An encrypted body's envelope version must never go DOWN on an edit.
//!
//! The client seals message bodies and checklist items into JSON envelopes
//! `{"v":N,"t":...,"ct":...}` the server never opens. When a NEWER client
//! writes a newer envelope version (v3 binds the row's channel/epoch/author
//! into the AES-GCM tag), an OLDER client cannot parse it: its reader falls
//! back to "legacy plaintext" and renders the raw envelope JSON as the text,
//! badged "Not encrypted". If that user then EDITS the item, the old client
//! re-seals the JSON it displayed as the new body — under its own, older
//! format — and the real ciphertext is gone. Messages keep an edit history;
//! checklist items do not, so for them that is permanent loss.
//!
//! The server can see `v` (it is plaintext metadata in the envelope it already
//! stores), so it refuses the one transition that is never legitimate: a sealed
//! body replaced by an OLDER envelope version, or by non-envelope content. An
//! old client gets a clear error instead of destroying data; a new client
//! never hits this (it only ever writes the current version, or upgrades a
//! legacy row). Clearing an attachment sidecar (empty string) is a deletion,
//! not a downgrade, and is allowed for everyone.

/// The envelope version of a stored body, or None for anything that is not an
/// envelope (legacy plaintext, malformed JSON, JSON without a string `ct`).
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
    obj.get("v")?.as_u64()
}

/// True when replacing `old` with `new` would take a sealed body to an older
/// envelope version or to non-envelope content.
pub fn edit_is_downgrade(old: &str, new: &str) -> bool {
    match (envelope_version(old), envelope_version(new)) {
        (Some(o), Some(n)) => n < o,
        (Some(_), None) => true,
        _ => false,
    }
}

/// The refusal the client shows. Deliberately says what to DO.
pub const DOWNGRADE_MESSAGE: &str =
    "This was written by a newer version of the app — update the app to edit it";

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
        assert_eq!(envelope_version("hello"), None);
        assert_eq!(envelope_version(r#"{"v":3}"#), None, "no ct: not an envelope");
        assert_eq!(envelope_version(r#"{"v":"3","ct":"x"}"#), None, "v must be a number");
        assert_eq!(envelope_version("{not json"), None);
        assert_eq!(envelope_version(""), None);
    }

    #[test]
    fn a_newer_client_may_upgrade_and_rewrite_but_an_older_one_may_not_downgrade() {
        assert!(!edit_is_downgrade(V2, V3), "v2 -> v3 is an upgrade");
        assert!(!edit_is_downgrade(V3, V3), "same version is a rewrite");
        assert!(!edit_is_downgrade("legacy plaintext", V2), "sealing a legacy row is an upgrade");
        assert!(!edit_is_downgrade("legacy plaintext", "still plaintext"));
        assert!(edit_is_downgrade(V3, V2), "the old-client re-seal: refused");
        assert!(edit_is_downgrade(V3, "raw text"), "sealed -> plaintext: refused");
        assert!(edit_is_downgrade(V2, "raw text"));
    }
}
