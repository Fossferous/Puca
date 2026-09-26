//! What an outbound HTTP failure says in the log.
//!
//! The server makes three kinds of outbound request: Google's OAuth and FCM
//! endpoints (src/wake/fcm.rs), and the operator's LiveKit node for its
//! metrics and the RemoveParticipant admin call (src/sfu.rs). When one fails,
//! the log line is the operator's only view of WHY — a refused connection, a
//! name that did not resolve, a certificate that was rejected, the timeout.
//!
//! reqwest >= 0.12 prints none of that. An error's Display is only "error
//! sending request for url (..)"; the cause lives in its source chain, which
//! 0.11 appended and 0.12 does not. `{e}` alone would turn every one of those
//! causes into the same sentence.
//!
//! Same helper, same reason, as crates/puca-service/src/link.rs and
//! crates/puca-waker/src/net.rs; it is copied rather than shared because
//! neither of those is a dependency of the server.

/// A reqwest error WITH its cause: its own text, then each source in turn.
pub fn http_err(e: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(c) = src {
        s.push_str(": ");
        s.push_str(&c.to_string());
        src = c.source();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::http_err;

    #[tokio::test]
    async fn a_failed_request_is_logged_with_its_cause() {
        // A port nobody listens on: bound, read, released.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let e = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            // Straight to the closed port, whatever proxy the environment names.
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .expect_err("nothing listens there");
        let full = http_err(&e);
        assert!(full.contains("tcp connect error"), "the cause must be in the log line: {full}");
        // THE POSITIVE CONTROL: reqwest's own Display must NOT carry the
        // cause, or the assertion above proves nothing about http_err.
        assert!(
            !e.to_string().contains("tcp connect error"),
            "reqwest's own text now carries the cause; drop http_err: {e}"
        );
    }
}
