use governor::middleware::NoOpMiddleware;
use std::net::IpAddr;
use std::sync::Arc;
use tower_governor::{
    governor::GovernorConfigBuilder,
    key_extractor::{KeyExtractor, SmartIpKeyExtractor},
    GovernorError, GovernorLayer,
};

/// Rate-limit key extractor that PREFERS `CF-Connecting-IP`.
///
/// `SmartIpKeyExtractor` keys on the leftmost `X-Forwarded-For`, which a client
/// can pre-populate: proxies APPEND to XFF, so `X-Forwarded-For: <spoofed>` sent
/// by the client leaves the leftmost (trusted) entry attacker-controlled, and a
/// fresh fake IP per request buys a fresh rate-limit bucket — the limit becomes
/// unenforceable. Behind Cloudflare (this deployment; origin ufw-locked to CF
/// ranges) `CF-Connecting-IP` is set by Cloudflare, cannot be spoofed by the
/// client, and is the true peer. Falls back to the smart extractor
/// (XFF/X-Real-IP/peer) when no CF header is present, so local dev and any
/// non-Cloudflare deployment behave exactly as before.
///
/// Precedence is kept identical to `state::real_client_ip`.
#[derive(Debug, Clone, Copy)]
pub struct CfConnectingIpKeyExtractor;

impl KeyExtractor for CfConnectingIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, req: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        if let Some(ip) = req
            .headers()
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<IpAddr>().ok())
        {
            return Ok(ip);
        }
        SmartIpKeyExtractor.extract(req)
    }
}

/// Create a rate limiting layer specifically for authentication endpoints
/// Limit: 5 requests per second per IP
/// Burst: 10 requests
///
/// Uses SmartIpKeyExtractor to properly handle X-Forwarded-For headers from nginx proxy
pub fn create_auth_rate_limit_layer() -> GovernorLayer<CfConnectingIpKeyExtractor, NoOpMiddleware> {
    let burst = std::env::var("AUTH_RATE_LIMIT_BURST")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(10);

    let per_second_opt = std::env::var("AUTH_RATE_LIMIT_PER_SECOND")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());

    let governor_conf = match per_second_opt {
        Some(n) if n >= 1000 => GovernorConfigBuilder::default()
            .key_extractor(CfConnectingIpKeyExtractor)
            .burst_size(burst)
            .per_millisecond(1)
            .finish()
            .unwrap(),
        Some(n) if n > 0 => GovernorConfigBuilder::default()
            .key_extractor(CfConnectingIpKeyExtractor)
            .burst_size(burst)
            .per_millisecond(1000 / n)
            .finish()
            .unwrap(),
        _ => GovernorConfigBuilder::default()
            .key_extractor(CfConnectingIpKeyExtractor)
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
pub fn create_api_rate_limit_layer() -> GovernorLayer<CfConnectingIpKeyExtractor, NoOpMiddleware> {
    let per_second_opt = std::env::var("AUTH_RATE_LIMIT_PER_SECOND")
        .ok()
        .and_then(|v| v.parse::<u64>().ok());

    let governor_conf = match per_second_opt {
        Some(n) if n >= 1000 => GovernorConfigBuilder::default()
            .key_extractor(CfConnectingIpKeyExtractor)
            .burst_size(1000)
            .per_millisecond(1)
            .finish()
            .unwrap(),
        _ => GovernorConfigBuilder::default()
            .key_extractor(CfConnectingIpKeyExtractor)
            .burst_size(100)
            .per_millisecond(20)
            .finish()
            .unwrap(),
    };

    GovernorLayer {
        config: Arc::new(governor_conf),
    }
}
