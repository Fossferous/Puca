//! Wake signals: the Signal-messenger architecture, adopted deliberately.
//!
//! HISTORY, because this repo has been burned by losing it. Push went through
//! three designs in one day: (1) FCM data messages carrying sender names and
//! conversation ids — removed on the owner's principle that a privacy product
//! must not route who-messaged-whom metadata through Google, even opt-in;
//! (2) a pure native WebSocket to our own server (NativeDelivery.java) — fully
//! Google-free, but structurally unable to punch through Doze on its own: a
//! socket the OS has suspended cannot hear the message that should wake it;
//! (3) THIS: keep the native socket as the ONLY data path, and use FCM purely
//! as a doorbell.
//!
//! THE CONTRACT — enforced by construction, not by discipline: a wake signal
//! carries a single constant field (`{"w":"1"}`). There is no payload
//! parameter anywhere in this module's API. Google learns that *some* server
//! can wake *this* device, and when wakes happen. It never learns a name, an
//! id, a conversation, or a byte of content — there is nothing in the message
//! to learn. The user approved exactly this surface, stated in those words.
//!
//! When does a wake fire? Only when a notification-worthy frame found NO live
//! session to accept it (`send_to_user` returned false). A healthy native
//! socket means no wakes at all: the doorbell rings only for a house that
//! stopped answering.

pub mod fcm;
pub mod sender;

/// Why a wake failed, in the only categories a caller treats differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeError {
    /// The token is dead (app uninstalled, token rotated). FCM's response is
    /// the ONLY authoritative staleness signal; this drives token pruning.
    Unregistered,
    /// Malformed token — same pruning, distinguished so a spike reads as a
    /// client bug rather than user churn.
    InvalidToken,
    /// Backed off by Google. Dropped, never queued — the undelivered-frame
    /// queue (state.rs) is what preserves the notification itself.
    RateLimited,
    /// Credentials rejected: deployment misconfiguration, operator-visible.
    Auth(String),
    /// Network, timeout, 5xx.
    Transient(String),
}

impl std::fmt::Display for WakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WakeError::Unregistered => write!(f, "token unregistered"),
            WakeError::InvalidToken => write!(f, "invalid token"),
            WakeError::RateLimited => write!(f, "rate limited"),
            WakeError::Auth(m) => write!(f, "auth failed: {m}"),
            WakeError::Transient(m) => write!(f, "transient failure: {m}"),
        }
    }
}

impl WakeError {
    /// Should the token this failed against be deleted? Only genuinely dead
    /// tokens — a Google outage must never silently unsubscribe live devices.
    pub fn is_token_dead(&self) -> bool {
        matches!(self, WakeError::Unregistered | WakeError::InvalidToken)
    }
}

/// The transport seam. Note the signature: a token and nothing else. A caller
/// CANNOT attach data to a wake — the leak the first design permitted is
/// unrepresentable in this one.
#[async_trait::async_trait]
pub trait WakeTransport: Send + Sync {
    async fn wake(&self, token: &str) -> Result<(), WakeError>;

    /// False when no credentials are configured: callers skip the work, and
    /// `/notifications/test` answers honestly instead of pretending.
    fn enabled(&self) -> bool;
}

/// The no-credentials deployment: wakes are off, the native socket alone
/// carries delivery (with its documented Doze limits), nothing pretends
/// otherwise.
pub struct NullWake;

#[async_trait::async_trait]
impl WakeTransport for NullWake {
    async fn wake(&self, _token: &str) -> Result<(), WakeError> {
        Ok(())
    }
    fn enabled(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_null_transport_reports_itself_disabled() {
        let t = NullWake;
        assert!(!t.enabled());
        assert!(t.wake("tok").await.is_ok());
    }

    #[test]
    fn only_token_failures_prune_a_row() {
        assert!(WakeError::Unregistered.is_token_dead());
        assert!(WakeError::InvalidToken.is_token_dead());
        // The half that matters: transient failures must NEVER delete a live
        // device's row — that silently unsubscribes them until reinstall.
        assert!(!WakeError::RateLimited.is_token_dead());
        assert!(!WakeError::Transient("timeout".into()).is_token_dead());
        assert!(!WakeError::Auth("bad key".into()).is_token_dead());
    }
}
