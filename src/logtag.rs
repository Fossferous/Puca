//! What the server log may say about a person.
//!
//! Operators read the log; so does anyone who gets a copy of it. A username
//! or an e-mail address in an INFO line is a directory of who uses the server,
//! with timestamps, for the lifetime of the log rotation. Every line about a
//! user therefore names the user id (an opaque integer) or, where only a
//! username is known (login and reset attempts, before any id is resolved), a
//! short digest that lets an operator correlate repeated attempts against the
//! same account without the log ever holding the name.

/// Eight hex characters of SHA-256 over the lowercased username: stable across
/// restarts, meaningless without the name, enough to see "the same account
/// again" in a log.
pub fn user_tag(username: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(username.trim().to_lowercase().as_bytes());
    hex::encode(&d[..4])
}

/// The domain of an e-mail address (the part an operator needs to debug
/// delivery), never the mailbox.
pub fn mail_domain(address: &str) -> &str {
    address.rsplit('@').next().unwrap_or("?")
}

#[cfg(test)]
mod tests {
    use super::{mail_domain, user_tag};

    #[test]
    fn tags_are_stable_short_and_never_the_name() {
        let t = user_tag("Alice");
        assert_eq!(t.len(), 8);
        assert_eq!(t, user_tag("alice "), "case and whitespace do not change the tag");
        assert_ne!(t, user_tag("alicf"));
        assert!(!t.contains("lice"));
    }

    #[test]
    fn only_the_domain_of_an_address_is_kept() {
        assert_eq!(mail_domain("someone@example.org"), "example.org");
        assert_eq!(mail_domain("no-at-sign"), "no-at-sign");
    }
}
