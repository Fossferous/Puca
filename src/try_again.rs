//! A lookup that FAILED is not an answer.
//!
//! When the database does not answer (a pool that timed out under load, a
//! dropped connection, a statement the server cancelled), a handler does not
//! know whether the caller may see the channel, whether the user exists, or
//! how much of a quota is used. Answering that with the 404 or 403 of a real
//! "no" has the client believe it: 0.9.866 found pictures, icons and emoji
//! left blank for a session over one busy moment, and a sign-in that read a
//! 404 from its own public key twice refused the identity outright
//! (frontend/src/api/auth.ts, `checkPublishedOwnKey`). And where the failed
//! lookup GUARDS something (a quota, a rate limit, a block), folding the
//! failure into "nothing counted" let the request through.
//!
//! So: a 503 with `Retry-After: 2`, the shape GET /files' per-IP ceiling
//! already answers with. Still a refusal (nothing is served, stored or sent),
//! but one a client may retry. The true 404 / 403 stays for a real "no".

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

/// The answer when the server cannot tell right now: 503 + `Retry-After: 2`.
pub(crate) fn try_again_shortly(what: &'static str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, [(header::RETRY_AFTER, "2")], what).into_response()
}

/// The message most gates answer a failed lookup with.
pub(crate) const COULD_NOT_CHECK: &str = "Could not check that right now, try again shortly";

/// A refusal from a helper that used to return `(StatusCode, &'static str)`:
/// the ordinary answer, or the 503 of a lookup that failed. `From` the old
/// tuple, so `?` on a helper that still returns one keeps working.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// A real answer: the status and message the handler always gave.
    Is(StatusCode, &'static str),
    /// A lookup failed: [`try_again_shortly`] with this message.
    TryAgain(&'static str),
}

impl Refusal {
    pub(crate) fn status(&self) -> StatusCode {
        match self {
            Refusal::Is(code, _) => *code,
            Refusal::TryAgain(_) => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

impl From<(StatusCode, &'static str)> for Refusal {
    fn from((code, msg): (StatusCode, &'static str)) -> Self {
        Refusal::Is(code, msg)
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        match self {
            Refusal::Is(code, msg) => (code, msg).into_response(),
            Refusal::TryAgain(msg) => try_again_shortly(msg),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_keeps_its_answer_and_a_failed_lookup_says_when_to_retry() {
        let plain = Refusal::from((StatusCode::NOT_FOUND, "Channel not found")).into_response();
        assert_eq!(plain.status(), StatusCode::NOT_FOUND);
        assert!(plain.headers().get(header::RETRY_AFTER).is_none(), "a real no is final");
        let retry = Refusal::TryAgain(COULD_NOT_CHECK).into_response();
        assert_eq!(retry.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(retry.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()), Some("2"));
        assert_eq!(Refusal::TryAgain("x").status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
