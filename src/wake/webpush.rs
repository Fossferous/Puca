//! Web Push as a doorbell: the same contract as the FCM wake, for the web app.
//!
//! WHY THIS EXISTS. An iPhone or iPad runs Púca as a Home Screen web app
//! (0.9.848), and a web page that is closed has no socket and no Java to keep
//! one: the only thing that can reach it is the browser's own push service —
//! Apple's for Safari, Google's for Chrome, Mozilla's for Firefox, Microsoft's
//! for Edge. That service is a relay we do not run, so it gets exactly what
//! FCM gets (src/wake/mod.rs): THE CONSTANT `{"w":"1"}`, encrypted to the
//! subscribing browser (RFC 8291), and nothing else. There is no payload
//! parameter anywhere in this module's API — `seal_wake` takes the
//! subscription and nothing more, and `WebPushTransport::push` takes a target
//! and nothing more — so a caller cannot attach a name, an id or a byte of
//! content even by mistake.
//!
//! WHAT THE PUSH SERVICE LEARNS. That this server holds a subscription for
//! this browser (it issued the endpoint), and when a wake happened. The
//! encrypted body is 9 bytes of plaintext that are the same for every push to
//! every user, so even the push service's own decryption key (it has none)
//! would learn nothing from it. The headers are constants too: `TTL`,
//! `Urgency: high`, `Topic: pucawake`.
//!
//! WHAT THE NOTIFICATION SAYS is decided on the device. The service worker
//! (frontend/public/sw.js) wakes, asks THIS server — over TLS, with a
//! per-subscription credential that can do nothing else — what knocked, and
//! shows the same content-free titles the Android app does ("alice sent you a
//! message" / "New message"). See `push_web_handlers.rs`.
//!
//! VAPID (RFC 8292). The server signs every request with a P-256 key the
//! operator generates once per deployment (`VAPID_PRIVATE_KEY`; `puca
//! generate-vapid-key` prints one). Browsers bind each subscription to the
//! public half, so a stranger who learns an endpoint cannot push to it, and
//! rotating the key strands every existing subscription until its app is
//! next opened (the client resubscribes when /config shows a different key).

use std::time::Duration;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use sha2::Sha256;

use super::WakeError;
use crate::http_err::http_err;

/// THE wake. The whole plaintext of every Web Push this server sends, to every
/// user, for every reason. Pinned by a test that decrypts a real sealed body.
pub const WEB_PUSH_PAYLOAD: &[u8] = br#"{"w":"1"}"#;

/// How long a push service may hold an undelivered wake. Matches the parked
/// frames' own TTL (`AppState::UNDELIVERED_TTL`): a wake that arrives after
/// what it announces has expired could only ever show the generic text.
pub const PUSH_TTL_SECS: u32 = 3600;

/// RFC 8030 §5.4: a push service keeps only the NEWEST undelivered message per
/// topic. Every wake is the same constant, so a phone that was offline for a
/// burst is handed one wake, not thirty — coalescing at the relay, on top of
/// the per-user rate limit in sender.rs.
pub const PUSH_TOPIC: &str = "pucawake";

/// VAPID tokens are minted per request and live this long. Short on purpose:
/// several push services refuse an `exp` more than a day out, and Apple's is
/// the strictest.
const VAPID_TTL_SECS: u64 = 60 * 60;

/// The push services browsers actually use. A subscription endpoint is a URL
/// the CLIENT hands us and the server then POSTs to, so without this list any
/// signed-in user could point the server at an address on its own network.
/// Exact hosts, or a suffix that starts with a dot.
const PUSH_HOSTS: &[&str] = &[
    // Chrome, Chromium-based browsers other than Edge, Android Chrome.
    "fcm.googleapis.com",
    "android.googleapis.com",
    // Firefox.
    "updates.push.services.mozilla.com",
    ".push.services.mozilla.com",
    // Safari, including the iPhone/iPad Home Screen app.
    "web.push.apple.com",
    ".push.apple.com",
    // Edge (Windows Push Notification Services).
    ".notify.windows.com",
];

/// Is this a push service we will POST to? HTTPS on the default port, no
/// credentials in the URL, and a host from `PUSH_HOSTS`.
pub fn endpoint_allowed(endpoint: &str) -> Result<reqwest::Url, String> {
    if endpoint.len() > 2048 {
        return Err("endpoint is too long".into());
    }
    let url = reqwest::Url::parse(endpoint).map_err(|_| "endpoint is not a URL".to_string())?;
    if url.scheme() != "https" {
        return Err("endpoint must be https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("endpoint must not carry credentials".into());
    }
    if url.port().is_some_and(|p| p != 443) {
        return Err("endpoint must use the default port".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let known = PUSH_HOSTS.iter().any(|h| {
        if let Some(suffix) = h.strip_prefix('.') {
            host.len() > suffix.len() + 1 && host.ends_with(h)
        } else {
            host == *h
        }
    });
    if !known {
        return Err(format!("{host} is not a known push service"));
    }
    Ok(url)
}

/// One browser's subscription, as the transport needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebPushTarget {
    pub endpoint: String,
    /// The browser's P-256 public key, uncompressed (65 bytes).
    pub p256dh: Vec<u8>,
    /// The browser's 16-byte authentication secret.
    pub auth: Vec<u8>,
}

impl WebPushTarget {
    /// From the strings `PushSubscription.toJSON()` produces. Validates the
    /// key is a real P-256 point and the secret is the 16 bytes RFC 8291
    /// requires, so a malformed subscription is refused at the door rather
    /// than failing every wake.
    pub fn from_b64(endpoint: &str, p256dh: &str, auth: &str) -> Result<Self, String> {
        let p256dh = decode_b64(p256dh).ok_or("p256dh is not base64url")?;
        let auth = decode_b64(auth).ok_or("auth is not base64url")?;
        if p256dh.len() != 65 || p256::PublicKey::from_sec1_bytes(&p256dh).is_err() {
            return Err("p256dh is not an uncompressed P-256 public key".into());
        }
        if auth.len() != 16 {
            return Err("auth must be 16 bytes".into());
        }
        Ok(Self { endpoint: endpoint.to_string(), p256dh, auth })
    }
}

/// base64url with or without padding — browsers emit it unpadded, some
/// libraries pad.
pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s.trim().trim_end_matches('=')).ok()
}

/// Seal THE wake to one subscription (RFC 8291, `aes128gcm`). Fresh ephemeral
/// key and salt per call. Takes no payload: it can only ever seal
/// `WEB_PUSH_PAYLOAD`.
pub fn seal_wake(target: &WebPushTarget) -> Result<Vec<u8>, WakeError> {
    let as_secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let mut salt = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut salt);
    encrypt(target, WEB_PUSH_PAYLOAD, &as_secret, &salt)
}

/// RFC 8291 §3-4 with the ephemeral key and salt supplied, so the RFC's own
/// worked example (Appendix A) can check every byte. Private: the only
/// production caller is `seal_wake`, which passes the constant.
fn encrypt(
    target: &WebPushTarget,
    plaintext: &[u8],
    as_secret: &p256::SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, WakeError> {
    let bad = |what: &str| WakeError::Transient(format!("cannot seal a wake: {what}"));
    let ua_public = p256::PublicKey::from_sec1_bytes(&target.p256dh).map_err(|_| bad("p256dh"))?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_public.as_affine());

    // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua || as, 32)
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&target.p256dh);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&target.auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| bad("ikm"))?;

    // CEK and NONCE from (salt, IKM).
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| bad("cek"))?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| bad("nonce"))?;

    // One record: the plaintext, then the 0x02 last-record delimiter.
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(2);
    let sealed = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| bad("aes key"))?
        .encrypt(&Nonce::from(nonce), record.as_slice())
        .map_err(|_| bad("aes"))?;

    // Header: salt(16) || rs(4) || idlen(1) || keyid(as_public).
    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// Classify a push service's answer. Only 404 and 410 — the RFC 8030 answers
/// for "this subscription is gone" — prune a row. Everything else, 400 and 403
/// included, is kept: a clock skew or a deployment misconfiguration answers
/// those for EVERY subscription at once, and pruning on them would silently
/// unsubscribe every browser this server has.
pub fn classify(status: u16) -> Result<(), WakeError> {
    match status {
        200..=299 => Ok(()),
        404 | 410 => Err(WakeError::Unregistered),
        401 | 403 => Err(WakeError::Auth(format!("HTTP {status}"))),
        429 => Err(WakeError::RateLimited),
        s => Err(WakeError::Transient(format!("HTTP {s}"))),
    }
}

/// The transport seam, shaped like `WakeTransport`: a target and nothing else.
#[async_trait::async_trait]
pub trait WebPushTransport: Send + Sync {
    async fn push(&self, target: &WebPushTarget) -> Result<(), WakeError>;

    /// The VAPID public key browsers subscribe with (base64url, uncompressed
    /// point), or `None` when Web Push is not configured on this deployment.
    fn public_key(&self) -> Option<String>;

    fn enabled(&self) -> bool {
        self.public_key().is_some()
    }
}

/// No `VAPID_PRIVATE_KEY`: no Web Push, and /config says so.
pub struct NullWebPush;

#[async_trait::async_trait]
impl WebPushTransport for NullWebPush {
    async fn push(&self, _target: &WebPushTarget) -> Result<(), WakeError> {
        Ok(())
    }
    fn public_key(&self) -> Option<String> {
        None
    }
}

pub struct VapidPush {
    signing: p256::ecdsa::SigningKey,
    public_b64: String,
    /// RFC 8292 `sub`: a mailto: or https: contact the push service can use.
    /// Apple refuses a request without one.
    subject: String,
    http: reqwest::Client,
    /// Lets the socket tests aim the REAL request path at a local stand-in.
    /// Never set outside `#[cfg(test)]` code; `new` always leaves it false.
    allow_loopback: bool,
}

/// A fresh VAPID private key, base64url (the 32-byte scalar), for
/// `puca generate-vapid-key`.
pub fn generate_private_key() -> String {
    let sk = p256::SecretKey::random(&mut rand::rngs::OsRng);
    B64.encode(sk.to_bytes())
}

/// The VAPID subject from its own variable, else the web app's address.
pub fn subject_from(vapid_subject: Option<String>, app_url: Option<String>) -> Option<String> {
    let ok = |s: &str| s.starts_with("mailto:") || s.starts_with("https://");
    if let Some(s) = vapid_subject.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return ok(&s).then_some(s);
    }
    crate::public_config::app_url_from(app_url).filter(|u| ok(u))
}

impl VapidPush {
    /// Err on a malformed key rather than degrading to a no-op — main.rs
    /// aborts the boot, the same rule as the FCM wake.
    pub fn new(private_key_b64: &str, subject: String) -> anyhow::Result<Self> {
        let raw = decode_b64(private_key_b64)
            .ok_or_else(|| anyhow::anyhow!("VAPID_PRIVATE_KEY is not base64url"))?;
        if raw.len() != 32 {
            anyhow::bail!("VAPID_PRIVATE_KEY must be a 32-byte P-256 key (base64url); run `puca generate-vapid-key`");
        }
        let secret = p256::SecretKey::from_slice(&raw)
            .map_err(|_| anyhow::anyhow!("VAPID_PRIVATE_KEY is not a valid P-256 private key"))?;
        let public_b64 = B64.encode(secret.public_key().to_encoded_point(false).as_bytes());
        Ok(Self {
            signing: p256::ecdsa::SigningKey::from(&secret),
            public_b64,
            subject,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                // The endpoint was checked against PUSH_HOSTS; a redirect would
                // take the request somewhere that check never saw.
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            allow_loopback: false,
        })
    }

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// The RFC 8292 token for one push service origin.
    fn vapid_jwt(&self, aud: &str, now: u64) -> String {
        let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({ "aud": aud, "exp": now + VAPID_TTL_SECS, "sub": self.subject });
        let claims = B64.encode(claims.to_string().as_bytes());
        let signing_input = format!("{header}.{claims}");
        let sig: p256::ecdsa::Signature = self.signing.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", B64.encode(sig.to_bytes()))
    }

    fn checked_url(&self, endpoint: &str) -> Result<reqwest::Url, WakeError> {
        if self.allow_loopback {
            if let Ok(u) = reqwest::Url::parse(endpoint) {
                if u.host_str() == Some("127.0.0.1") {
                    return Ok(u);
                }
            }
        }
        // Re-checked at send time, not only at subscribe time: a row written
        // before a host was dropped from the list must not be posted to.
        endpoint_allowed(endpoint).map_err(|e| WakeError::Transient(format!("refused endpoint: {e}")))
    }
}

#[async_trait::async_trait]
impl WebPushTransport for VapidPush {
    async fn push(&self, target: &WebPushTarget) -> Result<(), WakeError> {
        let url = self.checked_url(&target.endpoint)?;
        let aud = url.origin().ascii_serialization();
        let body = seal_wake(target)?;
        let res = self
            .http
            .post(url)
            .header("TTL", PUSH_TTL_SECS.to_string())
            .header("Urgency", "high")
            .header("Topic", PUSH_TOPIC)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header(
                "Authorization",
                format!("vapid t={}, k={}", self.vapid_jwt(&aud, Self::now_secs()), self.public_b64),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| WakeError::Transient(format!("push service unreachable: {}", http_err(&e))))?;
        classify(res.status().as_u16())
    }

    fn public_key(&self) -> Option<String> {
        Some(self.public_b64.clone())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn b(s: &str) -> Vec<u8> {
        decode_b64(s).expect("test vector is base64url")
    }

    /// The receiving browser's half of RFC 8291 — what Chrome, Safari and
    /// Firefox do with a body. Kept here so the tests prove a sealed wake
    /// opens to exactly the constant, not merely that sealing ran.
    pub(crate) fn open(body: &[u8], ua_secret: &p256::SecretKey, auth: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        let rs = u32::from_be_bytes(body[16..20].try_into().unwrap());
        assert_eq!(rs, 4096, "record size");
        let idlen = body[20] as usize;
        let as_public = &body[21..21 + idlen];
        let sealed = &body[21 + idlen..];
        let ua_public = ua_secret.public_key().to_encoded_point(false);
        let as_pk = p256::PublicKey::from_sec1_bytes(as_public).expect("sender key");
        let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_pk.as_affine());
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(ua_public.as_bytes());
        key_info.extend_from_slice(as_public);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes()).expand(&key_info, &mut ikm).unwrap();
        let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let mut cek = [0u8; 16];
        let mut nonce = [0u8; 12];
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut record = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(&Nonce::from(nonce), sealed)
            .expect("the body opens under the subscriber's key");
        assert_eq!(record.pop(), Some(2), "a single, last record");
        record
    }

    /// A browser-side subscription: its secret key (only the test holds it)
    /// and the target the server would be given.
    pub(crate) fn browser(endpoint: &str) -> (p256::SecretKey, WebPushTarget) {
        let sk = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let mut auth = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut auth);
        let pk = sk.public_key().to_encoded_point(false).as_bytes().to_vec();
        (sk, WebPushTarget { endpoint: endpoint.into(), p256dh: pk, auth: auth.to_vec() })
    }

    /// RFC 8291 Appendix A, byte for byte: the encryption is the standard one
    /// every browser decrypts, not merely self-consistent.
    #[test]
    fn rfc_8291_appendix_a_encrypts_to_the_published_bytes() {
        let as_secret = p256::SecretKey::from_slice(&b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        assert_eq!(
            B64.encode(as_secret.public_key().to_encoded_point(false).as_bytes()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let target = WebPushTarget::from_b64(
            "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "BTBZMqHH6r4Tts7J_aSIgg",
        )
        .unwrap();
        let salt: [u8; 16] = b("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt(&target, b"When I grow up, I want to be a watermelon", &as_secret, &salt).unwrap();
        assert_eq!(
            B64.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
        // And the receiving half opens it.
        let ua = p256::SecretKey::from_slice(&b("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        assert_eq!(open(&body, &ua, &target.auth), b"When I grow up, I want to be a watermelon");
    }

    /// THE CONTRACT, pinned at the bytes a push service relays: whatever the
    /// caller, a sealed wake opens to `{"w":"1"}` and nothing else, and two
    /// wakes to one browser share no ciphertext (fresh key and salt).
    #[test]
    fn a_sealed_wake_opens_to_the_constant_and_nothing_else() {
        assert_eq!(WEB_PUSH_PAYLOAD, br#"{"w":"1"}"#);
        let (sk, target) = browser("https://fcm.googleapis.com/fcm/send/x");
        let one = seal_wake(&target).unwrap();
        let two = seal_wake(&target).unwrap();
        assert_eq!(open(&one, &sk, &target.auth), br#"{"w":"1"}"#);
        assert_eq!(open(&two, &sk, &target.auth), br#"{"w":"1"}"#);
        assert_ne!(one, two, "fresh salt and ephemeral key per wake");
        // 16 salt + 4 rs + 1 idlen + 65 key + 9 plaintext + 1 delimiter + 16 tag.
        assert_eq!(one.len(), 112, "the size of every wake, for every user");
    }

    #[test]
    fn only_the_browsers_push_services_are_reachable() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc:def",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
            "https://web.push.apple.com/QGuQyavXutnMH",
            "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
            "https://FCM.googleapis.com/fcm/send/x",
        ] {
            assert!(endpoint_allowed(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/fcm/send/x",            // not https
            "https://127.0.0.1/push",                          // loopback
            "https://10.20.30.40/push",                        // the LAN
            "https://localhost/push",
            "https://fcm.googleapis.com.evil.example/x",       // suffix trick
            "https://evilnotify.windows.com/x",                // no dot before the suffix
            "https://notify.windows.com/x",                    // the bare suffix is no host
            "https://user:pw@fcm.googleapis.com/x",            // credentials
            "https://fcm.googleapis.com:8443/x",               // another port
            "https://storage.googleapis.com/bucket",           // a Google host, not a push service
            "not a url",
        ] {
            assert!(endpoint_allowed(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_subscription_with_a_bad_key_is_refused_at_the_door() {
        let (_, t) = browser("https://fcm.googleapis.com/x");
        let p = B64.encode(&t.p256dh);
        let a = B64.encode(&t.auth);
        assert!(WebPushTarget::from_b64(&t.endpoint, &p, &a).is_ok());
        assert!(WebPushTarget::from_b64(&t.endpoint, &p, "AAAA").is_err(), "short auth");
        assert!(WebPushTarget::from_b64(&t.endpoint, &B64.encode([4u8; 65]), &a).is_err(), "not on the curve");
        assert!(WebPushTarget::from_b64(&t.endpoint, "%%%", &a).is_err(), "not base64");
        // Padded base64 (some libraries) is the same key.
        assert!(WebPushTarget::from_b64(&t.endpoint, &format!("{p}="), &format!("{a}==")).is_ok());
    }

    #[test]
    fn only_a_gone_subscription_is_pruned() {
        assert!(classify(201).is_ok());
        assert!(classify(200).is_ok());
        assert_eq!(classify(404), Err(WakeError::Unregistered));
        assert_eq!(classify(410), Err(WakeError::Unregistered));
        // The half that matters: these answer for EVERY subscription at once
        // when the deployment is misconfigured; none may prune.
        for s in [400, 401, 403, 413, 429, 500, 502, 503] {
            let e = classify(s).unwrap_err();
            assert!(!e.is_token_dead(), "HTTP {s} must not prune a subscription");
        }
    }

    #[test]
    fn the_vapid_key_round_trips_and_a_bad_one_fails_at_construction() {
        let key = generate_private_key();
        let v = VapidPush::new(&key, "mailto:ops@example.com".into()).unwrap();
        let pk = decode_b64(&v.public_key().unwrap()).unwrap();
        assert_eq!(pk.len(), 65);
        assert_eq!(pk[0], 4, "uncompressed point, as applicationServerKey requires");
        assert!(VapidPush::new("AAAA", "mailto:a@b".into()).is_err());
        assert!(VapidPush::new(&B64.encode([0u8; 32]), "mailto:a@b".into()).is_err(), "zero is no key");
        assert!(VapidPush::new("not base64!", "mailto:a@b".into()).is_err());
    }

    #[test]
    fn the_subject_is_a_contact_apple_will_accept() {
        assert_eq!(subject_from(Some("mailto:ops@example.com".into()), None).as_deref(), Some("mailto:ops@example.com"));
        assert_eq!(subject_from(None, Some("https://app.example.com/".into())).as_deref(), Some("https://app.example.com"));
        assert_eq!(subject_from(Some("  ".into()), Some("https://app.example.com".into())).as_deref(), Some("https://app.example.com"));
        assert_eq!(subject_from(Some("ops@example.com".into()), Some("https://app.example.com".into())), None, "a set but invalid subject is not silently replaced");
        assert_eq!(subject_from(None, Some("http://app.example.com".into())), None, "Apple wants https or mailto");
        assert_eq!(subject_from(None, None), None);
    }

    /// The token is a real ES256 JWT over the claims RFC 8292 names, verifiable
    /// with the public key browsers were given.
    #[test]
    fn the_vapid_token_verifies_under_the_announced_key() {
        let v = VapidPush::new(&generate_private_key(), "mailto:ops@example.com".into()).unwrap();
        let jwt = v.vapid_jwt("https://fcm.googleapis.com", 1_000_000);
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&b(parts[0])).unwrap();
        assert_eq!(header, serde_json::json!({"typ":"JWT","alg":"ES256"}));
        let claims: serde_json::Value = serde_json::from_slice(&b(parts[1])).unwrap();
        assert_eq!(
            claims,
            serde_json::json!({"aud":"https://fcm.googleapis.com","exp":1_000_000 + VAPID_TTL_SECS,"sub":"mailto:ops@example.com"})
        );
        let vk = p256::ecdsa::VerifyingKey::from_sec1_bytes(&decode_b64(&v.public_key().unwrap()).unwrap()).unwrap();
        let sig = p256::ecdsa::Signature::from_slice(&b(parts[2])).unwrap();
        assert!(vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_ok());
        // Control: another deployment's key does not verify it.
        let other = VapidPush::new(&generate_private_key(), "mailto:x@y".into()).unwrap();
        let vk2 = p256::ecdsa::VerifyingKey::from_sec1_bytes(&decode_b64(&other.public_key().unwrap()).unwrap()).unwrap();
        assert!(vk2.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_err());
    }

    /// One request as a stand-in push service received it.
    pub(crate) struct Seen {
        pub line: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Seen {
        pub fn header(&self, name: &str) -> Option<&str> {
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
            let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let mut lines = head.split("\r\n");
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
                return Seen { line, headers, body: buf[end + 4..end + 4 + len].to_vec() };
            }
        }
    }

    /// A local stand-in push service: answers each request with the next
    /// scripted status. Bounded — a request that never comes fails the test.
    pub(crate) async fn stand_in(script: Vec<u16>) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let task = tokio::spawn(async move {
            let mut seen = Vec::new();
            for status in script {
                let (mut sock, _) = listener.accept().await.expect("accept");
                seen.push(read_request(&mut sock).await);
                let resp = format!("HTTP/1.1 {status} Scripted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                sock.write_all(resp.as_bytes()).await.expect("write");
                let _ = sock.shutdown().await;
            }
            seen
        });
        (base, task)
    }

    pub(crate) async fn seen_by(task: tokio::task::JoinHandle<Vec<Seen>>) -> Vec<Seen> {
        match tokio::time::timeout(Duration::from_secs(10), task).await {
            Ok(r) => r.expect("stand-in panicked"),
            Err(_) => panic!("fewer requests reached the stand-in push service than it was scripted for"),
        }
    }

    /// A VapidPush whose real client may reach the 127.0.0.1 stand-in.
    pub(crate) fn vapid_for_tests() -> VapidPush {
        let mut v = VapidPush::new(&generate_private_key(), "mailto:ops@example.com".into()).unwrap();
        v.allow_loopback = true;
        v
    }

    /// The real request path, over a socket: the headers every push service
    /// requires, a VAPID authorization for the endpoint's origin, and a body
    /// that the subscriber — and only the subscriber — opens to the constant.
    #[tokio::test]
    async fn a_wake_reaches_the_push_service_as_the_protocol_requires() {
        let (base, srv) = stand_in(vec![201]).await;
        let v = vapid_for_tests();
        let (sk, target) = browser(&format!("{base}/push/sub-1"));
        v.push(&target).await.expect("201 is delivered");
        let seen = seen_by(srv).await;
        let r = &seen[0];
        assert_eq!(r.line, "POST /push/sub-1 HTTP/1.1");
        assert_eq!(r.header("ttl"), Some("3600"));
        assert_eq!(r.header("urgency"), Some("high"));
        assert_eq!(r.header("topic"), Some("pucawake"));
        assert_eq!(r.header("content-encoding"), Some("aes128gcm"));
        let auth = r.header("authorization").expect("VAPID authorization");
        let (t, k) = auth
            .strip_prefix("vapid t=")
            .and_then(|s| s.split_once(", k="))
            .expect("vapid t=..., k=...");
        assert_eq!(k, v.public_key().unwrap());
        let claims: serde_json::Value = serde_json::from_slice(&b(t.split('.').nth(1).unwrap())).unwrap();
        assert_eq!(claims["aud"], base.as_str(), "aud is the push service's origin");
        assert_eq!(open(&r.body, &sk, &target.auth), WEB_PUSH_PAYLOAD);
        // Nothing but the constant: the only header set by the caller's
        // choice is the endpoint's own path; no header carries anything else.
        let names: Vec<&str> = r.headers.iter().map(|(k, _)| k.as_str()).collect();
        for n in &names {
            assert!(
                ["ttl", "urgency", "topic", "content-encoding", "content-type", "authorization", "content-length", "host", "accept"].contains(n),
                "unexpected header {n}: every header of a wake is fixed"
            );
        }
    }

    #[tokio::test]
    async fn push_service_statuses_reach_the_classifier_over_the_wire() {
        let (base, srv) = stand_in(vec![410, 404, 403, 429, 503]).await;
        let v = vapid_for_tests();
        let (_, target) = browser(&format!("{base}/push/s"));
        assert_eq!(v.push(&target).await, Err(WakeError::Unregistered));
        assert_eq!(v.push(&target).await, Err(WakeError::Unregistered));
        assert!(matches!(v.push(&target).await, Err(WakeError::Auth(_))));
        assert_eq!(v.push(&target).await, Err(WakeError::RateLimited));
        assert!(matches!(v.push(&target).await, Err(WakeError::Transient(_))));
        assert_eq!(seen_by(srv).await.len(), 5);
    }

    /// The production transport (allow_loopback false) refuses a loopback
    /// endpoint before any request is made — the SSRF door stays shut even
    /// for a row that somehow got past the subscribe check.
    #[tokio::test]
    async fn the_production_transport_never_posts_to_an_unlisted_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let v = VapidPush::new(&generate_private_key(), "mailto:ops@example.com".into()).unwrap();
        let (_, target) = browser(&format!("http://{addr}/push/s"));
        assert!(matches!(v.push(&target).await, Err(WakeError::Transient(m)) if m.contains("refused endpoint")));
        let accepted = tokio::time::timeout(Duration::from_millis(300), listener.accept()).await;
        assert!(accepted.is_err(), "no connection may reach the unlisted host");
    }
}
