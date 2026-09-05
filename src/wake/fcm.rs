//! FCM HTTP v1 as a doorbell.
//!
//! The OAuth machinery is resurrected from the removed push transport (git
//! fc09683) — it was correct and tested; only the message it authorises has
//! changed. `build_message` takes a token and NOTHING else: the body is a
//! constant, so what crosses Google is decided here, once, visibly, and no
//! caller can widen it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::RwLock;

use super::{WakeError, WakeTransport};

/// Refresh this far before actual expiry, so an in-flight wake never races the
/// boundary and 401s.
const REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
/// Google issues 1h tokens; fallback if the response omits it.
const DEFAULT_TOKEN_TTL: Duration = Duration::from_secs(3600);
const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

/// The subset of a Firebase service-account JSON we need.
///
/// Deserialised from a file path, never from an env var: the `private_key` is
/// a multi-line PEM (a quoting hazard in an EnvironmentFile), and a 0600 file
/// gives filesystem protection `/proc/<pid>/environ` does not.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccount {
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

#[derive(Debug, serde::Serialize)]
struct Assertion<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    exp: u64,
    iat: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

/// Classify an FCM response. Pure and network-free so the whole table is
/// testable. Wrong in either direction is expensive: a transient 503 read as
/// dead silently unsubscribes a live device; a dead token read as transient
/// retries forever against a phone that no longer exists.
pub fn classify(status: u16, body: &str) -> WakeError {
    match status {
        404 => WakeError::Unregistered,
        400 if body.contains("UNREGISTERED") => WakeError::Unregistered,
        400 => WakeError::InvalidToken,
        401 | 403 => WakeError::Auth(format!("HTTP {status}")),
        429 => WakeError::RateLimited,
        s => WakeError::Transient(format!("HTTP {s}")),
    }
}

pub struct FcmWake {
    project_id: String,
    account: ServiceAccount,
    http: reqwest::Client,
    /// (access token, expires_at)
    cached: Arc<RwLock<Option<(String, Instant)>>>,
}

impl FcmWake {
    /// Err on a malformed key rather than degrading to a no-op: a deployment
    /// that CONFIGURED wakes and silently got none is the documented failure
    /// class here, so main.rs fails loudly at boot instead.
    pub fn new(project_id: String, account_json: &str) -> anyhow::Result<Self> {
        let account: ServiceAccount = serde_json::from_str(account_json)
            .map_err(|e| anyhow::anyhow!("FCM service account JSON is not parseable: {e}"))?;
        jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes()).map_err(|e| {
            anyhow::anyhow!("FCM service account private_key is not a usable RSA PEM: {e}")
        })?;
        Ok(Self {
            project_id,
            account,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?,
            cached: Arc::new(RwLock::new(None)),
        })
    }

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// The signed service-account assertion. Split out so its claims are
    /// assertable in a test without a network.
    pub fn build_assertion(account: &ServiceAccount, now: u64) -> Result<String, WakeError> {
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key.as_bytes())
            .map_err(|e| WakeError::Auth(format!("bad private key: {e}")))?;
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &Assertion {
                iss: &account.client_email,
                scope: OAUTH_SCOPE,
                aud: &account.token_uri,
                exp: now + 3600,
                iat: now,
            },
            &key,
        )
        .map_err(|e| WakeError::Auth(format!("assertion signing failed: {e}")))
    }

    async fn access_token(&self) -> Result<String, WakeError> {
        if let Some((tok, expires_at)) = self.cached.read().await.as_ref() {
            if Instant::now() + REFRESH_MARGIN < *expires_at {
                return Ok(tok.clone());
            }
        }
        let assertion = Self::build_assertion(&self.account, Self::now_secs())?;
        let res = self
            .http
            .post(&self.account.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &assertion),
            ])
            .send()
            .await
            .map_err(|e| WakeError::Transient(format!("token endpoint unreachable: {e}")))?;
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        if status != 200 {
            return Err(WakeError::Auth(format!("token endpoint HTTP {status}: {body}")));
        }
        let parsed: TokenResponse = serde_json::from_str(&body)
            .map_err(|e| WakeError::Auth(format!("token response unparseable: {e}")))?;
        let ttl = parsed
            .expires_in
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TOKEN_TTL);
        let expires_at = Instant::now() + ttl;
        *self.cached.write().await = Some((parsed.access_token.clone(), expires_at));
        Ok(parsed.access_token)
    }

    async fn invalidate(&self) {
        *self.cached.write().await = None;
    }

    /// THE ENTIRE WIRE SURFACE. One constant field, because FCM rejects a
    /// message with neither `notification` nor `data`; `w=1` identifies the
    /// frame type to the receiver and describes nothing about anyone. HIGH
    /// priority is the point — it is what grants the app its Doze-piercing
    /// wake window. No `notification` key, ever: nothing renders from this.
    pub fn build_message(token: &str) -> serde_json::Value {
        serde_json::json!({
            "message": {
                "token": token,
                "data": { "w": "1" },
                "android": { "priority": "HIGH" },
            }
        })
    }
}

#[async_trait::async_trait]
impl WakeTransport for FcmWake {
    async fn wake(&self, token: &str) -> Result<(), WakeError> {
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.project_id
        );
        let body = Self::build_message(token);
        for attempt in 0..2 {
            let access = self.access_token().await?;
            let res = self
                .http
                .post(&url)
                .bearer_auth(&access)
                .json(&body)
                .send()
                .await
                .map_err(|e| WakeError::Transient(format!("fcm unreachable: {e}")))?;
            let status = res.status().as_u16();
            if status == 200 {
                return Ok(());
            }
            let text = res.text().await.unwrap_or_default();
            // A 401 means the cached token died early: re-mint once, then stop
            // rather than hammering Google with a bad credential.
            if status == 401 && attempt == 0 {
                self.invalidate().await;
                continue;
            }
            return Err(classify(status, &text));
        }
        Err(WakeError::Auth("retry exhausted after 401".to_string()))
    }

    fn enabled(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway keypair per run — a committed private key is a private key,
    /// test or not.
    fn test_account() -> ServiceAccount {
        // Minted here, not by shelling out to openssl: the test must not
        // depend on a binary being on PATH, and the `rsa` dev-dependency
        // exists for exactly this.
        use rsa::pkcs8::{EncodePrivateKey, LineEnding};
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("rsa keygen");
        ServiceAccount {
            client_email: "svc@example.iam.gserviceaccount.com".into(),
            private_key: key.to_pkcs8_pem(LineEnding::LF).expect("pkcs8 pem").to_string(),
            token_uri: default_token_uri(),
        }
    }

    #[test]
    fn the_wake_message_is_a_constant_and_nothing_else() {
        // The privacy contract, pinned. If this test changes, the user-facing
        // claim about what Google sees changes with it — that is the point of
        // asserting the ENTIRE serialised body.
        let msg = FcmWake::build_message("tok-1");
        assert_eq!(
            serde_json::to_string(&msg).unwrap(),
            r#"{"message":{"android":{"priority":"HIGH"},"data":{"w":"1"},"token":"tok-1"}}"#
        );
    }

    #[test]
    fn the_assertion_carries_the_claims_google_requires() {
        use base64::Engine;
        let acct = test_account();
        let jwt = FcmWake::build_assertion(&acct, 1_700_000_000).expect("sign");
        let payload = jwt.split('.').nth(1).expect("payload segment");
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .expect("b64");
        let v: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(v["iss"], "svc@example.iam.gserviceaccount.com");
        assert_eq!(v["scope"], OAUTH_SCOPE);
        assert_eq!(v["exp"], 1_700_003_600u64); // Google rejects >1h validity
    }

    #[test]
    fn a_malformed_private_key_fails_at_construction_not_at_wake_time() {
        let json = r#"{"client_email":"a@b.com","private_key":"-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----"}"#;
        assert!(FcmWake::new("proj".into(), json).is_err());
    }

    #[test]
    fn status_classification_never_prunes_a_live_device_on_a_transient_error() {
        assert_eq!(classify(404, ""), WakeError::Unregistered);
        assert_eq!(
            classify(400, r#"{"error":{"status":"UNREGISTERED"}}"#),
            WakeError::Unregistered
        );
        assert_eq!(classify(400, "bad field"), WakeError::InvalidToken);
        assert!(!classify(500, "").is_token_dead());
        assert!(!classify(503, "").is_token_dead());
        assert!(!classify(429, "").is_token_dead());
        assert!(!classify(401, "").is_token_dead());
        // Positive control: the rig CAN see a token-dead verdict.
        assert!(classify(404, "").is_token_dead());
    }
}
