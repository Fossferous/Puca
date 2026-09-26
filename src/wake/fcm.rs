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
use crate::http_err::http_err;

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
    /// `https://fcm.googleapis.com/v1/projects/<project>/messages:send`,
    /// fixed at construction. A field rather than a format! in `wake` so the
    /// tests can drive the real request path against a local listener; no
    /// configuration reaches it.
    send_url: String,
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
            send_url: format!("https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"),
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
            .map_err(|e| WakeError::Transient(format!("token endpoint unreachable: {}", http_err(&e))))?;
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
        let url = &self.send_url;
        let body = Self::build_message(token);
        for attempt in 0..2 {
            let access = self.access_token().await?;
            let res = self
                .http
                .post(url)
                .bearer_auth(&access)
                .json(&body)
                .send()
                .await
                .map_err(|e| WakeError::Transient(format!("fcm unreachable: {}", http_err(&e))))?;
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

    // --- The request path itself, over a real socket ------------------------
    //
    // Everything above is pure. These drive the actual reqwest calls against a
    // local listener standing in for Google, so a change of HTTP client (0.11
    // -> 0.12 on 2026-09-26) is tested by more than "it compiles".

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One request as the stand-in received it.
    struct Seen {
        /// "POST /token HTTP/1.1"
        line: String,
        /// Header names lower-cased.
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
        }
    }

    async fn read_request(sock: &mut tokio::net::TcpStream) -> Seen {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.expect("read");
            assert!(n > 0, "the client closed before sending a whole request");
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            let Some(end) = text.find("\r\n\r\n") else { continue };
            let mut lines = text[..end].split("\r\n");
            let line = lines.next().unwrap_or("").to_string();
            let headers: Vec<(String, String)> = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect();
            let len = headers
                .iter()
                .find(|(k, _)| k == "content-length")
                .and_then(|(_, v)| v.parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                let body = String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string();
                return Seen { line, headers, body };
            }
        }
    }

    /// A stand-in server that answers each accepted connection with the next
    /// scripted (status, body) and closes it. `connection: close` stops the
    /// client pooling, so every request is its own accept and the script is
    /// also a count: a request beyond it finds the listener gone.
    async fn stand_in(script: Vec<(u16, &'static str)>) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for (status, body) in script {
                let (mut sock, _) = listener.accept().await.expect("accept");
                seen.push(read_request(&mut sock).await);
                let resp = format!(
                    "HTTP/1.1 {status} Scripted\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(resp.as_bytes()).await.expect("write");
                let _ = sock.shutdown().await;
            }
            seen
        });
        (base, task)
    }

    /// Everything a stand-in saw, once its script is used up. BOUNDED: if the
    /// code under test skips a request the stand-in is waiting for (a 401 that
    /// no longer re-mints, say), the test must FAIL, not hang CI on an accept
    /// that never comes. Found by breaking the re-mint on purpose.
    async fn seen_by(task: tokio::task::JoinHandle<Vec<Seen>>, what: &str) -> Vec<Seen> {
        match tokio::time::timeout(Duration::from_secs(10), task).await {
            Ok(r) => r.expect("stand-in panicked"),
            Err(_) => panic!("{what}: fewer requests arrived than the stand-in was scripted for"),
        }
    }

    /// The service-account file main.rs hands to `FcmWake::new`.
    fn account_json(acct: &ServiceAccount) -> String {
        serde_json::json!({
            "client_email": acct.client_email,
            "private_key": acct.private_key,
            "token_uri": acct.token_uri,
        })
        .to_string()
    }

    /// These tests reach 127.0.0.1 through the PRODUCTION client, which
    /// honours HTTP(S)_PROXY / ALL_PROXY from the environment as an operator's
    /// proxy must be honoured - with no implied loopback exemption. A proxy in
    /// the environment would receive these requests and fail them with its
    /// own 502; say what to do instead.
    fn no_env_proxy() {
        let no = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
        for k in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
            if std::env::var_os(k).is_some_and(|v| !v.is_empty()) {
                assert!(
                    no.split(',').any(|h| h.trim() == "127.0.0.1"),
                    "{k} is set: add 127.0.0.1 to NO_PROXY to run the FCM socket tests"
                );
            }
        }
    }

    /// An FcmWake built by `new` - its real client - with only the two
    /// destinations moved onto the stand-ins.
    fn wake_against(token_base: &str, send_base: &str) -> FcmWake {
        no_env_proxy();
        let acct = ServiceAccount { token_uri: format!("{token_base}/token"), ..test_account() };
        let mut fcm = FcmWake::new("p".into(), &account_json(&acct)).expect("a valid account");
        fcm.send_url = format!("{send_base}/v1/projects/p/messages:send");
        fcm
    }

    /// The one destination the socket tests replace, pinned where it is made:
    /// a wrong path here is a 404 from Google, which `classify` reads as
    /// Unregistered - every phone's token pruned on its first wake.
    #[test]
    fn construction_targets_the_real_fcm_endpoint() {
        let fcm = FcmWake::new("proj-123".into(), &account_json(&test_account())).expect("a valid account");
        assert_eq!(fcm.send_url, "https://fcm.googleapis.com/v1/projects/proj-123/messages:send");
        assert_eq!(fcm.account.token_uri, "https://oauth2.googleapis.com/token");
    }

    /// A port nobody listens on: bound, read, released.
    fn closed_base() -> String {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn the_token_request_is_a_jwt_bearer_form_and_its_answer_is_cached() {
        let (token_base, token_srv) =
            stand_in(vec![(200, r#"{"access_token":"at-1","expires_in":3600}"#)]).await;
        let fcm = wake_against(&token_base, &closed_base());

        assert_eq!(fcm.access_token().await.expect("first mint"), "at-1");
        // The stand-in answers ONE request and then drops its listener, so a
        // second fetch would fail: Ok here is the cache answering.
        assert_eq!(fcm.access_token().await.expect("cached"), "at-1");

        let seen = seen_by(token_srv, "token endpoint").await;
        assert_eq!(seen.len(), 1);
        let r = &seen[0];
        assert_eq!(r.line, "POST /token HTTP/1.1", "the request line");
        assert_eq!(r.header("content-type"), Some("application/x-www-form-urlencoded"));
        let assertion = r
            .body
            .strip_prefix(
                "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=",
            )
            .unwrap_or_else(|| panic!("the form is grant_type then assertion: {}", r.body));
        assert_eq!(assertion.split('.').count(), 3, "the assertion is a JWT: {assertion}");
    }

    #[tokio::test]
    async fn a_401_re_mints_once_and_the_retry_carries_the_new_token() {
        let (token_base, token_srv) = stand_in(vec![
            (200, r#"{"access_token":"at-1","expires_in":3600}"#),
            (200, r#"{"access_token":"at-2","expires_in":3600}"#),
        ])
        .await;
        let (send_base, send_srv) = stand_in(vec![(401, "{}"), (200, "{}")]).await;
        let fcm = wake_against(&token_base, &send_base);

        fcm.wake("device-tok").await.expect("the retry succeeds");

        assert_eq!(seen_by(token_srv, "token endpoint").await.len(), 2, "one re-mint");
        let sent = seen_by(send_srv, "fcm send").await;
        assert_eq!(sent[0].line, "POST /v1/projects/p/messages:send HTTP/1.1");
        assert_eq!(sent[0].header("authorization"), Some("Bearer at-1"));
        assert_eq!(sent[1].header("authorization"), Some("Bearer at-2"));
        for s in &sent {
            assert_eq!(s.header("content-type"), Some("application/json"));
            // THE WIRE CONTRACT, as it actually crosses: the constant body.
            let v: serde_json::Value = serde_json::from_str(&s.body).expect("json body");
            assert_eq!(v, FcmWake::build_message("device-tok"));
        }
    }

    #[tokio::test]
    async fn fcm_statuses_reach_the_classifier_over_the_wire() {
        let (token_base, token_srv) = stand_in(vec![
            (200, r#"{"access_token":"at-1","expires_in":3600}"#),
        ])
        .await;
        let (send_base, send_srv) = stand_in(vec![
            (404, "{}"),
            (400, r#"{"error":{"status":"UNREGISTERED"}}"#),
            (503, "{}"),
        ])
        .await;
        let fcm = wake_against(&token_base, &send_base);

        assert_eq!(fcm.wake("t").await, Err(WakeError::Unregistered));
        assert_eq!(fcm.wake("t").await, Err(WakeError::Unregistered), "the 400 body is read");
        let e = fcm.wake("t").await.expect_err("503");
        assert!(!e.is_token_dead(), "a 503 must not prune a live device: {e:?}");

        assert_eq!(seen_by(token_srv, "token endpoint").await.len(), 1, "one mint, then cached");
        assert_eq!(seen_by(send_srv, "fcm send").await.len(), 3);
    }

    #[tokio::test]
    async fn an_unreachable_endpoint_is_transient_and_names_its_cause() {
        let fcm = wake_against(&closed_base(), &closed_base());
        match fcm.wake("t").await {
            Err(WakeError::Transient(m)) => {
                assert!(m.starts_with("token endpoint unreachable: "), "{m}");
                assert!(m.contains("tcp connect error"), "the cause is kept: {m}");
            }
            other => panic!("an unreachable token endpoint is transient: {other:?}"),
        }

        let (token_base, _token_srv) = stand_in(vec![
            (200, r#"{"access_token":"at-1","expires_in":3600}"#),
        ])
        .await;
        let fcm = wake_against(&token_base, &closed_base());
        match fcm.wake("t").await {
            Err(WakeError::Transient(m)) => {
                assert!(m.starts_with("fcm unreachable: "), "{m}");
                assert!(m.contains("tcp connect error"), "the cause is kept: {m}");
            }
            other => panic!("an unreachable FCM is transient: {other:?}"),
        }
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
