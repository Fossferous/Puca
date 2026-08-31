use governor::middleware::NoOpMiddleware;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::KeyExtractor, GovernorError, GovernorLayer,
};

/// Rate-limit key extractor that defers entirely to `state::real_client_ip`.
///
/// It used to keep its own copy of the header precedence, "identical to
/// `real_client_ip`" by comment only — and both copies believed
/// `CF-Connecting-IP` unconditionally, so any caller could mint a fresh bucket
/// per request and neither limiter bound anything. There is now one policy
/// function and this calls it, so the two cannot drift again.
///
/// `SmartIpKeyExtractor` is deliberately NOT used as a fallback: it keys on the
/// leftmost `X-Forwarded-For` with no notion of who forwarded it, which is the
/// same spoofable behaviour on a directly-exposed socket.
#[derive(Debug, Clone, Copy)]
pub struct TrustedClientIpKeyExtractor;

impl KeyExtractor for TrustedClientIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, req: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        // Installed by `into_make_service_with_connect_info::<SocketAddr>` in
        // main.rs. Without a peer there is no unforgeable identity to key on, so
        // refuse rather than fall back to a header the client controls.
        let peer = req
            .extensions()
            .get::<axum::extract::ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0)
            .ok_or(GovernorError::UnableToExtractKey)?;
        Ok(crate::state::real_client_ip(req.headers(), peer))
    }
}

/// Create a rate limiting layer specifically for authentication endpoints
/// Limit: 5 requests per second per IP
/// Burst: 10 requests
///
/// Keys on `state::real_client_ip`, which believes a forwarding header only when
/// something vouches for it (see `TrustedClientIpKeyExtractor`).
pub fn create_auth_rate_limit_layer() -> GovernorLayer<TrustedClientIpKeyExtractor, NoOpMiddleware> {
    let burst = std::env::var("AUTH_RATE_LIMIT_BURST")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(10);

    let per_second_opt = std::env::var("AUTH_RATE_LIMIT_PER_SECOND")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());

    let governor_conf = match per_second_opt {
        Some(n) if n >= 1000 => GovernorConfigBuilder::default()
            .key_extractor(TrustedClientIpKeyExtractor)
            .burst_size(burst)
            .per_millisecond(1)
            .finish()
            .unwrap(),
        Some(n) if n > 0 => GovernorConfigBuilder::default()
            .key_extractor(TrustedClientIpKeyExtractor)
            .burst_size(burst)
            .per_millisecond(1000 / n)
            .finish()
            .unwrap(),
        _ => GovernorConfigBuilder::default()
            .key_extractor(TrustedClientIpKeyExtractor)
            .burst_size(burst)
            .per_second(5)
            .finish()
            .unwrap(),
    };

    GovernorLayer {
        config: Arc::new(governor_conf),
    }
}

/// Create a general-purpose rate limiting layer for the main API.
///
/// Auth endpoints get a much stricter limit (see `create_auth_rate_limit_layer`);
/// this protects the rest of the API from a single client flooding requests.
/// Limit: 50 requests/second per IP with a burst of 100.
pub fn create_api_rate_limit_layer() -> GovernorLayer<TrustedClientIpKeyExtractor, NoOpMiddleware> {
    let per_second_opt = std::env::var("AUTH_RATE_LIMIT_PER_SECOND")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());

    let governor_conf = match per_second_opt {
        Some(n) if n >= 1000 => GovernorConfigBuilder::default()
            .key_extractor(TrustedClientIpKeyExtractor)
            .burst_size(1000)
            .per_millisecond(1)
            .finish()
            .unwrap(),
        _ => GovernorConfigBuilder::default()
            .key_extractor(TrustedClientIpKeyExtractor)
            .burst_size(100)
            .per_millisecond(20)
            .finish()
            .unwrap(),
    };

    GovernorLayer {
        config: Arc::new(governor_conf),
    }
}
