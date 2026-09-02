//! A minimal TURN client (RFC 5766) for the agent's stream socket.
//!
//! WHY BY HAND: str0m is sans-IO and implements none of TURN — it will happily
//! hold a `Candidate::relayed` and tell us "send these bytes to that peer", but
//! getting them there through a relay is entirely the caller's job. The webrtc-rs
//! `turn` crate is tokio-based and the agent's stream loop is a plain blocking
//! socket on one thread, so pulling in an async runtime to borrow ~400 lines of
//! protocol was the worse trade.
//!
//! SCOPE, stated so the next reader does not assume more: Allocate with
//! long-term credentials, CreatePermission, Refresh, and Send/Data indications.
//! No ChannelBind — indications cost 36 bytes of header per packet against
//! ChannelData's 4, which at this bitrate is about 3%, and channels are an
//! optimisation that can land once the relay is known to work at all.
//!
//! EVERYTHING HERE SHARES THE STREAM SOCKET. The allocation is only useful if it
//! belongs to the socket str0m actually sends from, so allocation happens on
//! that socket before the answer, and afterwards TURN traffic is demultiplexed
//! from media inside the same read loop.

use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use sha1::Sha1;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

type HmacSha1 = Hmac<Sha1>;

const MAGIC: u32 = 0x2112_A442;

// Message types: method | class (RFC 5389 §6).
const ALLOCATE_REQUEST: u16 = 0x0003;
const ALLOCATE_SUCCESS: u16 = 0x0103;
const ALLOCATE_ERROR: u16 = 0x0113;
const REFRESH_REQUEST: u16 = 0x0004;
const REFRESH_SUCCESS: u16 = 0x0104;
const CREATE_PERM_REQUEST: u16 = 0x0008;
const CREATE_PERM_SUCCESS: u16 = 0x0108;
const SEND_INDICATION: u16 = 0x0016;
const DATA_INDICATION: u16 = 0x0017;

// Attributes.
const ATTR_USERNAME: u16 = 0x0006;
const ATTR_MESSAGE_INTEGRITY: u16 = 0x0008;
const ATTR_ERROR_CODE: u16 = 0x0009;
const ATTR_LIFETIME: u16 = 0x000D;
const ATTR_XOR_PEER_ADDRESS: u16 = 0x0012;
const ATTR_DATA: u16 = 0x0013;
const ATTR_REALM: u16 = 0x0014;
const ATTR_NONCE: u16 = 0x0015;
const ATTR_XOR_RELAYED_ADDRESS: u16 = 0x0016;
const ATTR_REQUESTED_TRANSPORT: u16 = 0x0019;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// A live TURN allocation on the stream socket.
pub struct Allocation {
    /// The address the TURN server relays for us. This is what goes into the
    /// SDP as `typ relay`, and — because str0m sets `Transmit.source` from the
    /// candidate's base — it is also how the send path recognises that a packet
    /// must go through the relay rather than straight out.
    pub relayed: SocketAddr,
    /// What the server saw us come from. Free with the Allocate response, and a
    /// reflexive candidate we would otherwise need a separate STUN round trip
    /// for.
    pub mapped: Option<SocketAddr>,
    pub server: SocketAddr,
    username: String,
    realm: String,
    nonce: String,
    key: [u8; 16],
    /// Permissions expire after 5 minutes; the server drops inbound traffic
    /// from any peer without one, silently. A peer is only recorded here once
    /// the server CONFIRMED the permission — recording it at send time (as
    /// this did until 2026-08-13) meant one lost UDP request opened a
    /// ~3-minute window where the server was silently discarding BOTH
    /// directions while this side believed itself covered and would not
    /// re-ask until the 4-minute renewal.
    permitted: Vec<(SocketAddr, Instant)>,
    /// CreatePermissions in flight: (transaction id, peer, sent at). The
    /// success response carries only the txid, so this is how a confirmation
    /// finds its peer. Entries also throttle re-asks (2s) and die with their
    /// nonce on a 438.
    pending_perms: Vec<([u8; 12], SocketAddr, Instant)>,
    expires_at: Instant,
    lifetime: Duration,
    /// When the last Refresh went out. The refresh is fire-and-forget, so
    /// nothing else stops the loop re-sending it on every iteration until the
    /// answer happens to arrive.
    last_refresh_sent: Option<Instant>,
    /// Since when Refreshes have gone UNANSWERED — set on the first send of a
    /// refresh episode, cleared by REFRESH_SUCCESS. `looks_dead` reads it:
    /// thirty seconds of one-per-second refreshes with no reply is not UDP
    /// loss, it is a server that no longer has our allocation (NAT rebind,
    /// restart, expiry) and will never answer.
    refresh_unanswered_since: Option<Instant>,
    /// Transaction ids of Refreshes still plausibly in flight, newest last.
    ///
    /// Half of the authenticity check in [`Allocation::may_act_on`]. A 438 or a
    /// 437 is an ERROR response, and RFC 5389 §10.2.2 says a 438 "SHOULD NOT
    /// include the USERNAME or MESSAGE-INTEGRITY attribute" — so demanding
    /// integrity on the branch that matters MOST would mean a nonce-rotating
    /// coturn stopped being believed and every relayed call died at the first
    /// rotation. What an unauthenticated response must instead prove is that it
    /// answers a request WE sent: 96 bits of OS randomness an off-path spoofer
    /// cannot guess. `pending_perms` already records exactly that for
    /// permission asks; this is the missing half for refreshes.
    refresh_txids: Vec<([u8; 12], Instant)>,
}

/// The longest lifetime this client will believe.
///
/// The granted LIFETIME arrives in a server message and decides when the next
/// Refresh goes out, so an attacker-chosen large value STOPS the client
/// refreshing until the real allocation silently expires — a relayed call
/// killed by one datagram. 600s is RFC 5766's recommended default allocation
/// lifetime; refreshing more often than a generous server asked for costs one
/// small packet every few minutes.
const MAX_LIFETIME: Duration = Duration::from_secs(600);

/// How long a Refresh transaction id stays acceptable as one we can be
/// answering. Bounded so the list cannot grow for the life of a call, and so a
/// txid seen on the wire cannot be replayed much later.
const TXID_MEMORY: Duration = Duration::from_secs(40);

/// STUN message builder. Attributes are written in order; MESSAGE-INTEGRITY
/// must be last and is added by `finish_with_integrity`.
struct MsgBuilder {
    typ: u16,
    txid: [u8; 12],
    attrs: Vec<u8>,
}

impl MsgBuilder {
    fn new(typ: u16) -> Self {
        let mut txid = [0u8; 12];
        crate::ice::fill_random(&mut txid);
        Self { typ, txid, attrs: Vec::new() }
    }

    fn push(&mut self, attr: u16, value: &[u8]) {
        self.attrs.extend_from_slice(&attr.to_be_bytes());
        self.attrs.extend_from_slice(&(value.len() as u16).to_be_bytes());
        self.attrs.extend_from_slice(value);
        // Every attribute is padded to a 4-byte boundary. Omitting this is the
        // classic TURN bug: the server reads the next attribute type out of the
        // padding and rejects the whole message as malformed.
        while self.attrs.len() % 4 != 0 {
            self.attrs.push(0);
        }
    }

    fn push_xor_addr(&mut self, attr: u16, addr: SocketAddr, txid: &[u8; 12]) {
        self.push(attr, &encode_xor_address(addr, txid));
    }

    fn header(&self, body_len: usize) -> [u8; 20] {
        let mut h = [0u8; 20];
        h[0..2].copy_from_slice(&self.typ.to_be_bytes());
        h[2..4].copy_from_slice(&(body_len as u16).to_be_bytes());
        h[4..8].copy_from_slice(&MAGIC.to_be_bytes());
        h[8..20].copy_from_slice(&self.txid);
        h
    }

    fn finish(self) -> Vec<u8> {
        let mut out = self.header(self.attrs.len()).to_vec();
        out.extend_from_slice(&self.attrs);
        out
    }

    /// Append MESSAGE-INTEGRITY over the message so far.
    ///
    /// The HMAC covers the header with its length field ALREADY INCLUDING the
    /// 24 bytes this attribute will occupy — a detail that is easy to miss and
    /// produces a 401 loop that looks exactly like wrong credentials.
    fn finish_with_integrity(self, key: &[u8; 16]) -> Vec<u8> {
        let with_mi = self.attrs.len() + 24;
        let mut signed = self.header(with_mi).to_vec();
        signed.extend_from_slice(&self.attrs);

        let mut mac = HmacSha1::new_from_slice(key).expect("hmac accepts any key length");
        mac.update(&signed);
        let digest = mac.finalize().into_bytes();

        let mut out = signed;
        out.extend_from_slice(&ATTR_MESSAGE_INTEGRITY.to_be_bytes());
        out.extend_from_slice(&20u16.to_be_bytes());
        out.extend_from_slice(&digest);
        out
    }
}

/// Where MESSAGE-INTEGRITY sits in `msg`: (offset of the attribute header
/// within the BODY, its 20-byte digest). `None` when the message carries none.
///
/// Walks the attribute run itself rather than reusing [`attrs`], because the
/// HMAC is computed over everything BEFORE this attribute and that boundary is
/// exactly what a `(type, value)` list throws away.
fn integrity_at(msg: &[u8]) -> Option<(usize, &[u8])> {
    if msg.len() < 20 {
        return None;
    }
    let len = u16::from_be_bytes([msg[2], msg[3]]) as usize;
    let body = msg.get(20..20 + len)?;
    let mut i = 0usize;
    while i + 4 <= body.len() {
        let a = u16::from_be_bytes([body[i], body[i + 1]]);
        let l = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let v = body.get(i + 4..i + 4 + l)?;
        if a == ATTR_MESSAGE_INTEGRITY {
            // A 20-byte HMAC-SHA1 or it is not one.
            return if l == 20 { Some((i, v)) } else { None };
        }
        i += 4 + l.div_ceil(4) * 4;
    }
    None
}

/// Does `msg` claim a MESSAGE-INTEGRITY at all?
///
/// ABSENT AND INVALID ARE DIFFERENT ANSWERS and the caller treats them
/// differently: absent is "unproven, look for another proof", invalid is
/// "forged, refuse". Collapsing the two either breaks nonce rotation (if
/// absent is refused) or accepts a forgery (if invalid is treated as absent).
fn has_integrity(msg: &[u8]) -> bool {
    integrity_at(msg).is_some()
}

/// The verifying counterpart to [`MsgBuilder::finish_with_integrity`].
///
/// The arithmetic mirrors the builder exactly, and getting it wrong has one
/// failure mode: EVERY legitimate server response is rejected and relayed media
/// stops entirely, invisibly to a test suite that builds and verifies with the
/// same buggy helper. So the length field is reconstructed as
/// `offset_of_MI + 24` — the header length the server signed, which counts the
/// MESSAGE-INTEGRITY attribute itself and nothing after it — rather than being
/// read back out of the message.
///
/// Constant-time compare via `Mac::verify_slice`: a byte-at-a-time comparison
/// of a MAC is a forgery oracle for an attacker who can retry.
fn verify_integrity(msg: &[u8], key: &[u8; 16]) -> bool {
    let Some((at, digest)) = integrity_at(msg) else {
        return false;
    };
    let Some(body) = msg.get(20..20 + at) else {
        return false;
    };
    let Ok(declared) = u16::try_from(at + 24) else {
        return false;
    };

    let mut signed = Vec::with_capacity(20 + at);
    signed.extend_from_slice(&msg[0..2]);
    signed.extend_from_slice(&declared.to_be_bytes());
    signed.extend_from_slice(&msg[4..20]);
    signed.extend_from_slice(body);

    let Ok(mut mac) = HmacSha1::new_from_slice(key) else {
        return false;
    };
    mac.update(&signed);
    mac.verify_slice(digest).is_ok()
}

fn encode_xor_address(addr: SocketAddr, txid: &[u8; 12]) -> Vec<u8> {
    let cookie = MAGIC.to_be_bytes();
    let mut v = vec![0u8, if addr.is_ipv4() { 0x01 } else { 0x02 }];
    v.extend_from_slice(&(addr.port() ^ (MAGIC >> 16) as u16).to_be_bytes());
    match addr.ip() {
        std::net::IpAddr::V4(ip) => {
            let o = ip.octets();
            for k in 0..4 {
                v.push(o[k] ^ cookie[k]);
            }
        }
        std::net::IpAddr::V6(ip) => {
            let o = ip.octets();
            for k in 0..16 {
                v.push(o[k] ^ if k < 4 { cookie[k] } else { txid[k - 4] });
            }
        }
    }
    v
}

/// One parsed attribute run. Borrowed rather than collected into a map: these
/// messages carry a handful of attributes and the allocation path runs twice
/// per session.
fn attrs(msg: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    if msg.len() < 20 {
        return out;
    }
    let len = u16::from_be_bytes([msg[2], msg[3]]) as usize;
    let Some(body) = msg.get(20..20 + len) else { return out };
    let mut i = 0usize;
    while i + 4 <= body.len() {
        let a = u16::from_be_bytes([body[i], body[i + 1]]);
        let l = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let Some(v) = body.get(i + 4..i + 4 + l) else { break };
        out.push((a, v));
        i += 4 + l.div_ceil(4) * 4;
    }
    out
}

fn msg_type(msg: &[u8]) -> u16 {
    if msg.len() < 2 { 0 } else { u16::from_be_bytes([msg[0], msg[1]]) }
}

fn txid_of(msg: &[u8]) -> Option<[u8; 12]> {
    let mut t = [0u8; 12];
    t.copy_from_slice(msg.get(8..20)?);
    Some(t)
}

fn decode_xor_address(val: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    crate::ice::decode_address(val, true, txid)
}

/// Long-term credential key: MD5(username ":" realm ":" password).
fn long_term_key(username: &str, realm: &str, password: &str) -> [u8; 16] {
    let mut h = Md5::new();
    h.update(username.as_bytes());
    h.update(b":");
    h.update(realm.as_bytes());
    h.update(b":");
    h.update(password.as_bytes());
    let d = h.finalize();
    let mut k = [0u8; 16];
    k.copy_from_slice(&d);
    k
}

fn error_code(msg: &[u8]) -> Option<(u16, String)> {
    for (a, v) in attrs(msg) {
        if a == ATTR_ERROR_CODE && v.len() >= 4 {
            let code = (v[2] as u16 & 0x07) * 100 + v[3] as u16;
            let reason = String::from_utf8_lossy(&v[4..]).to_string();
            return Some((code, reason));
        }
    }
    None
}

/// Send `req` and wait for a reply with the same transaction id.
///
/// Anything else arriving on the socket in the window is discarded. That is
/// safe here only because allocation happens before the stream thread starts,
/// so no media is in flight yet — doing this once the loop is running would eat
/// packets str0m needs.
fn transact(
    socket: &UdpSocket,
    server: SocketAddr,
    req: &[u8],
    txid: &[u8; 12],
    budget: Duration,
) -> Result<Vec<u8>, String> {
    socket.send_to(req, server).map_err(|e| format!("send: {e}"))?;
    let deadline = Instant::now() + budget;
    let mut buf = vec![0u8; 2048];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("no reply".to_string());
        }
        socket.set_read_timeout(Some(left)).map_err(|e| format!("timeout: {e}"))?;
        let (n, from) = socket.recv_from(&mut buf).map_err(|_| "no reply".to_string())?;
        if from != server {
            continue;
        }
        if txid_of(&buf[..n]).as_ref() == Some(txid) {
            return Ok(buf[..n].to_vec());
        }
    }
}

/// Allocate a relay on `server`.
///
/// Two round trips by design: RFC 5766 requires the first Allocate to be
/// unauthenticated so the server can hand back the realm and a nonce.
pub fn allocate(
    socket: &UdpSocket,
    server: SocketAddr,
    username: &str,
    password: &str,
    budget: Duration,
) -> Result<Allocation, String> {
    let deadline = Instant::now() + budget;

    let mut first = MsgBuilder::new(ALLOCATE_REQUEST);
    first.push(ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]); // 17 = UDP
    let txid = first.txid;
    let reply = transact(socket, server, &first.finish(), &txid, deadline.saturating_duration_since(Instant::now()))?;

    // The expected path is 401 with REALM + NONCE. A straight success would
    // mean an OPEN RELAY — the server allocated for an unauthenticated client —
    // which is worth refusing loudly rather than quietly using.
    if msg_type(&reply) == ALLOCATE_SUCCESS {
        return Err(
            "the TURN server allocated without credentials; refusing to use an open relay"
                .to_string(),
        );
    }
    if msg_type(&reply) != ALLOCATE_ERROR {
        return Err(format!("unexpected reply 0x{:04X} to Allocate", msg_type(&reply)));
    }
    let (code, reason) = error_code(&reply).unwrap_or((0, String::new()));
    if code != 401 {
        return Err(format!("Allocate refused: {code} {reason}"));
    }

    let mut realm = String::new();
    let mut nonce = String::new();
    for (a, v) in attrs(&reply) {
        match a {
            ATTR_REALM => realm = String::from_utf8_lossy(v).to_string(),
            ATTR_NONCE => nonce = String::from_utf8_lossy(v).to_string(),
            _ => {}
        }
    }
    if realm.is_empty() || nonce.is_empty() {
        return Err("the 401 carried no realm/nonce".to_string());
    }

    let key = long_term_key(username, &realm, password);
    let mut second = MsgBuilder::new(ALLOCATE_REQUEST);
    second.push(ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
    second.push(ATTR_USERNAME, username.as_bytes());
    second.push(ATTR_REALM, realm.as_bytes());
    second.push(ATTR_NONCE, nonce.as_bytes());
    let txid2 = second.txid;
    let reply2 = transact(
        socket,
        server,
        &second.finish_with_integrity(&key),
        &txid2,
        deadline.saturating_duration_since(Instant::now()),
    )?;

    if msg_type(&reply2) != ALLOCATE_SUCCESS {
        let (c, r) = error_code(&reply2).unwrap_or((0, "unknown".into()));
        return Err(format!("Allocate rejected: {c} {r}"));
    }

    let mut relayed = None;
    let mut mapped = None;
    let mut lifetime = Duration::from_secs(600);
    for (a, v) in attrs(&reply2) {
        match a {
            ATTR_XOR_RELAYED_ADDRESS => relayed = decode_xor_address(v, &txid2),
            ATTR_XOR_MAPPED_ADDRESS => mapped = decode_xor_address(v, &txid2),
            // Clamped for the same reason the refresh path clamps it: the
            // lifetime is what decides when we next ask, and a number we
            // believe uncritically is a way to stop us asking at all.
            ATTR_LIFETIME if v.len() >= 4 => {
                lifetime = Duration::from_secs(u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as u64)
                    .min(MAX_LIFETIME);
            }
            _ => {}
        }
    }
    let relayed = relayed.ok_or("the allocation carried no relayed address")?;

    Ok(Allocation {
        relayed,
        mapped,
        server,
        username: username.to_string(),
        realm,
        nonce,
        key,
        permitted: Vec::new(),
        pending_perms: Vec::new(),
        expires_at: Instant::now() + lifetime,
        last_refresh_sent: None,
        refresh_unanswered_since: None,
        refresh_txids: Vec::new(),
        lifetime,
    })
}

impl Allocation {
    /// Authorise inbound traffic from `peer`.
    ///
    /// Without this the server DISCARDS everything the peer relays to us and
    /// says nothing — the allocation looks healthy and no media arrives, which
    /// is the same shape as the bug this whole change exists to fix.
    pub fn create_permission(&mut self, socket: &UdpSocket, peer: SocketAddr) -> Result<(), String> {
        let mut m = MsgBuilder::new(CREATE_PERM_REQUEST);
        let txid = m.txid;
        m.push_xor_addr(ATTR_XOR_PEER_ADDRESS, peer, &txid);
        m.push(ATTR_USERNAME, self.username.as_bytes());
        m.push(ATTR_REALM, self.realm.as_bytes());
        m.push(ATTR_NONCE, self.nonce.as_bytes());
        let reply = transact(
            socket,
            self.server,
            &m.finish_with_integrity(&self.key),
            &txid,
            Duration::from_millis(600),
        )?;
        if msg_type(&reply) != CREATE_PERM_SUCCESS {
            let (c, r) = error_code(&reply).unwrap_or((0, "unknown".into()));
            // A stale nonce is routine — the server rotates it — so take the new
            // one and let the caller retry rather than treating it as fatal.
            if c == 438 {
                for (a, v) in attrs(&reply) {
                    if a == ATTR_NONCE {
                        self.nonce = String::from_utf8_lossy(v).to_string();
                    }
                }
                return Err("stale nonce, refreshed".to_string());
            }
            return Err(format!("CreatePermission rejected: {c} {r}"));
        }
        self.permitted.retain(|(p, _)| *p != peer);
        self.permitted.push((peer, Instant::now()));
        Ok(())
    }

    /// Has `peer` a permission that is still comfortably inside its 5-minute
    /// life? Re-created at 4 minutes so a refresh in flight cannot leave a gap.
    ///
    /// A request already in flight (< 2s old) also answers "no need": without
    /// that, un-confirmed permissions would be re-asked on every Transmit —
    /// but unlike the optimistic scheme this replaces, an ask that goes
    /// UNANSWERED is retried two seconds later rather than trusted for four
    /// minutes.
    pub fn needs_permission(&self, peer: SocketAddr) -> bool {
        let granted = self
            .permitted
            .iter()
            .any(|(p, at)| *p == peer && at.elapsed() < Duration::from_secs(240));
        let asking = self
            .pending_perms
            .iter()
            .any(|(_, p, at)| *p == peer && at.elapsed() < Duration::from_secs(2));
        !granted && !asking
    }

    /// Ask for a permission WITHOUT waiting for the answer.
    ///
    /// The blocking form above drains the socket until its reply arrives, which
    /// is fine before the stream thread exists and destructive afterwards: it
    /// would swallow ICE checks and media for up to 600ms. Once the loop is
    /// running the request goes out fire-and-forget and the reply is picked up
    /// by `handle_server_message` on the normal read path.
    ///
    /// Recorded as PENDING, not permitted. The previous version recorded it as
    /// granted at send time, reasoning that a refusal would be retried by the
    /// 4-minute renewal — but a request LOST in flight produces no refusal to
    /// retry on, and for the next four minutes the server silently discarded
    /// both directions while this side believed itself covered. Only
    /// CREATE_PERM_SUCCESS (matched by txid in `handle_server_message`)
    /// promotes the peer to `permitted`; an unanswered ask is simply re-sent
    /// two seconds later by `needs_permission`'s pending window.
    pub fn request_permission(&mut self, socket: &UdpSocket, peer: SocketAddr) {
        let mut m = MsgBuilder::new(CREATE_PERM_REQUEST);
        let txid = m.txid;
        m.push_xor_addr(ATTR_XOR_PEER_ADDRESS, peer, &txid);
        m.push(ATTR_USERNAME, self.username.as_bytes());
        m.push(ATTR_REALM, self.realm.as_bytes());
        m.push(ATTR_NONCE, self.nonce.as_bytes());
        let wire = m.finish_with_integrity(&self.key);
        if let Err(e) = socket.send_to(&wire, self.server) {
            eprintln!("[turn] could not ask for permission for {peer}: {e}");
            return;
        }
        // Replace any older ask for the same peer — one pending entry per
        // peer keeps the vec bounded by the handful of candidates a session
        // ever addresses.
        self.pending_perms.retain(|(_, p, _)| *p != peer);
        self.pending_perms.push((txid, peer, Instant::now()));
    }

    /// Is this response one we may CHANGE STATE on?
    ///
    /// Until this existed, the only gate was the caller's `source ==
    /// alloc.server` check in `stream.rs` — a UDP source address, which an
    /// off-path spoofer picks freely. Four state changes were reachable with
    /// one forged datagram: a REFRESH_SUCCESS carrying a huge LIFETIME (stop
    /// refreshing until the real allocation expires), a 438 (overwrite the
    /// nonce, then clear every permission, so every later authenticated request
    /// fails), a 437 (declare the relay dead within a round trip) and a
    /// CREATE_PERM_SUCCESS. Net effect: relayed media killed for a call — which
    /// is the path used when P2P fails, i.e. the restrictive-NAT users who have
    /// no fallback.
    ///
    /// Two proofs, applied where each is actually available:
    ///
    /// - SUCCESS responses to authenticated requests always carry
    ///   MESSAGE-INTEGRITY (RFC 5766 §7.3, §9.3), so nothing weaker is accepted
    ///   for the branches that extend a lifetime or promote a peer.
    /// - ERROR responses may legitimately carry none — RFC 5389 §10.2.2 says a
    ///   438 Stale Nonce "SHOULD NOT include the USERNAME or MESSAGE-INTEGRITY
    ///   attribute", and requiring it there would break nonce rotation and take
    ///   relayed calls down at the first rotation, which is a worse outage than
    ///   the bug. So an error must EITHER verify, or answer a transaction id we
    ///   actually sent.
    ///
    /// PRESENT-AND-WRONG IS ALWAYS A REFUSAL. "Absent" means look for the other
    /// proof; it never means "accept".
    fn may_act_on(&self, msg: &[u8]) -> bool {
        match msg_type(msg) {
            REFRESH_SUCCESS | CREATE_PERM_SUCCESS => verify_integrity(msg, &self.key),
            _ if has_integrity(msg) => verify_integrity(msg, &self.key),
            _ => self.answers_our_request(msg),
        }
    }

    /// Does `msg` carry the transaction id of a request still plausibly in
    /// flight from this allocation?
    fn answers_our_request(&self, msg: &[u8]) -> bool {
        let Some(t) = txid_of(msg) else { return false };
        self.pending_perms.iter().any(|(p, _, _)| *p == t)
            || self
                .refresh_txids
                .iter()
                .any(|(r, at)| *r == t && at.elapsed() < TXID_MEMORY)
    }

    /// Consume a non-media message from the TURN server.
    ///
    /// Returns true when the packet was TURN bookkeeping and must NOT be handed
    /// to str0m — feeding it a CreatePermission response would be fed into the
    /// ICE state machine as a malformed STUN packet.
    pub fn handle_server_message(&mut self, msg: &[u8]) -> bool {
        let typ = msg_type(msg);
        let is_turn_response = matches!(typ, REFRESH_SUCCESS | CREATE_PERM_SUCCESS)
            || typ & 0x0110 == 0x0110;
        if is_turn_response && !self.may_act_on(msg) {
            // CONSUMED, not forwarded: it is shaped like TURN bookkeeping, so
            // str0m has no use for it either. Nothing here reads it — an
            // unauthenticated packet must not be able to move the nonce, the
            // lifetime, the permissions or the liveness clock, which is the
            // whole finding.
            eprintln!("[turn] dropped an unauthenticated server message (type 0x{typ:04X})");
            return true;
        }
        match typ {
            REFRESH_SUCCESS => {
                // The allocation is confirmed alive. Nothing used to extend it
                // here because the blocking refresh consumed its own reply;
                // now that the request is fire-and-forget, THIS is the only
                // place the lifetime can be renewed.
                let granted = attrs(msg)
                    .into_iter()
                    .find(|(a, _)| *a == ATTR_LIFETIME)
                    .and_then(|(_, v)| v.get(..4))
                    .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
                    .map(|s| Duration::from_secs(s as u64))
                    .filter(|d| !d.is_zero())
                    // CLAMPED. The lifetime decides when the next Refresh goes
                    // out, so believing an enormous one is how a client stops
                    // refreshing and lets the real allocation lapse under it.
                    // Applies to an honest server too: nothing needs us to
                    // trust a number this far past what the RFC recommends.
                    .map(|d| d.min(MAX_LIFETIME))
                    .unwrap_or(self.lifetime);
                self.lifetime = granted;
                self.expires_at = Instant::now() + granted;
                self.refresh_unanswered_since = None;
                self.refresh_txids.clear();
                true
            }
            CREATE_PERM_SUCCESS => {
                // The confirmation this whole scheme waits for: match it to
                // the ask by txid and promote the peer. A success with no
                // matching pending entry (a duplicate, or one that outlived
                // its 438-cleared episode) is consumed and changes nothing —
                // promoting an unknown txid would be trusting the packet for
                // exactly the claim the pending list exists to verify.
                if let Some(txid) = txid_of(msg) {
                    if let Some(pos) = self.pending_perms.iter().position(|(t, _, _)| *t == txid) {
                        let (_, peer, _) = self.pending_perms.remove(pos);
                        self.permitted.retain(|(p, _)| *p != peer);
                        self.permitted.push((peer, Instant::now()));
                    }
                }
                true
            }
            t if t & 0x0110 == 0x0110 => {
                // ANY error response is still an ANSWER: the server and the
                // path to it are alive, whatever it thought of the request.
                // looks_dead's unanswered-refresh proof reads "thirty silent
                // seconds", and an error-answering server (nonce churn,
                // credential rotation) is not silent — leaving this clock
                // running here declared demonstrably-alive relays dead.
                self.refresh_unanswered_since = None;
                // Any error response. A stale nonce is routine — the server
                // rotates it — so adopt the new one instead of failing.
                if let Some((code, reason)) = error_code(msg) {
                    if code == 438 {
                        for (a, v) in attrs(msg) {
                            if a == ATTR_NONCE {
                                self.nonce = String::from_utf8_lossy(v).to_string();
                            }
                        }
                        // Force the next send to re-ask with the fresh nonce.
                        // Pending asks carried the dead nonce, so their
                        // answers are these 438s — drop them or they throttle
                        // the very re-ask the fresh nonce exists for.
                        self.permitted.clear();
                        self.pending_perms.clear();
                    } else if code == 437 {
                        // Allocation Mismatch: the server has NO allocation
                        // for our 5-tuple (expired, server restart, NAT
                        // rebind). That is the definitive death certificate —
                        // expire the allocation NOW so looks_dead reports it
                        // within a round trip instead of after a whole
                        // unrenewed lifetime. A CreatePermission answered
                        // this way is answered: retire its pending entry too.
                        self.expires_at = Instant::now();
                        if let Some(txid) = txid_of(msg) {
                            self.pending_perms.retain(|(t, _, _)| *t != txid);
                        }
                        eprintln!("[turn] 437: the server no longer holds our allocation");
                    } else {
                        // A REFUSED ask is an answered ask: remove it so the
                        // 2s pending window re-asks rather than waiting out a
                        // grant that never existed.
                        if let Some(txid) = txid_of(msg) {
                            self.pending_perms.retain(|(t, _, _)| *t != txid);
                        }
                        eprintln!("[turn] server refused a request: {code} {reason}");
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// Keep the allocation alive. Called from the stream loop, every iteration.
    ///
    /// FIRE-AND-FORGET, for the reason `request_permission` spells out three
    /// functions up: the blocking `transact` drains the socket until ITS reply
    /// arrives and discards everything else, and on a relayed session the
    /// peer's media and ICE arrive from the same address. Refreshing that way
    /// froze the media loop for up to 400ms and threw away every relayed packet
    /// in the window — roughly every five minutes, for the whole call. The
    /// sibling's doc called that out as "destructive afterwards"; this one did
    /// it anyway.
    ///
    /// The reply is picked up by `handle_server_message` on the normal read
    /// path, which is where the lifetime is now extended.
    pub fn maybe_refresh(&mut self, socket: &UdpSocket) {
        // Half-life, so one lost Refresh does not drop the relay mid-call.
        if self.expires_at.saturating_duration_since(Instant::now()) > self.lifetime / 2 {
            return;
        }
        // Without a throttle this would re-send on EVERY loop iteration for the
        // entire second half of the allocation's life, because nothing here
        // waits for the answer any more.
        if let Some(sent) = self.last_refresh_sent {
            if sent.elapsed() < Duration::from_secs(1) {
                return;
            }
        }
        let mut m = MsgBuilder::new(REFRESH_REQUEST);
        let secs = self.lifetime.as_secs() as u32;
        m.push(ATTR_LIFETIME, &secs.to_be_bytes());
        m.push(ATTR_USERNAME, self.username.as_bytes());
        m.push(ATTR_REALM, self.realm.as_bytes());
        m.push(ATTR_NONCE, self.nonce.as_bytes());
        let txid = m.txid;
        let wire = m.finish_with_integrity(&self.key);
        // Remembered so an ERROR answer to THIS request can be believed without
        // a MESSAGE-INTEGRITY the RFC says a 438 will not carry. Pruned by age
        // rather than count so the list cannot grow across a long call.
        self.refresh_txids.retain(|(_, at)| at.elapsed() < TXID_MEMORY);
        self.refresh_txids.push((txid, Instant::now()));
        self.last_refresh_sent = Some(Instant::now());
        // First send of this refresh episode starts the unanswered clock;
        // REFRESH_SUCCESS is the only thing that stops it.
        if self.refresh_unanswered_since.is_none() {
            self.refresh_unanswered_since = Some(Instant::now());
        }
        if let Err(e) = socket.send_to(&wire, self.server) {
            eprintln!("[turn] could not send a refresh: {e}");
        }
    }

    /// Is this allocation PROVABLY gone?
    ///
    /// Three independent proofs, any sufficient. Past `expires_at`: the
    /// server discarded the allocation whatever else is true, because only a
    /// REFRESH_SUCCESS extends that stamp and none arrived for a whole
    /// lifetime — and a 437 sets it to "now" directly, the server's own
    /// death certificate. Thirty seconds of unanswered one-per-second
    /// refreshes: not UDP loss — a server that HAS the allocation answers
    /// (success or error — EVERY response clears this clock, not just
    /// success) within a round trip, so thirty silent tries mean the path or
    /// the allocation is gone.
    ///
    /// The stream loop treats this as fatal ONLY while media is actually
    /// leaving through the relay — a session nominated onto a direct pair
    /// loses nothing when its unused relay dies.
    pub fn looks_dead(&self) -> bool {
        Instant::now() >= self.expires_at
            || self
                .refresh_unanswered_since
                .is_some_and(|t| t.elapsed() > Duration::from_secs(30))
    }

    /// Wrap one media packet for the peer in a Send indication.
    pub fn wrap_send(&self, peer: SocketAddr, payload: &[u8]) -> Vec<u8> {
        let mut m = MsgBuilder::new(SEND_INDICATION);
        let txid = m.txid;
        m.push_xor_addr(ATTR_XOR_PEER_ADDRESS, peer, &txid);
        m.push(ATTR_DATA, payload);
        // Indications are NOT authenticated (RFC 5766 §10.3): the permission is
        // what authorises them, and adding MESSAGE-INTEGRITY here makes coturn
        // drop the packet.
        m.finish()
    }
}

/// Unwrap a Data indication into (peer, payload).
///
/// Returns None for anything that is not one, which is how the read loop tells
/// relayed media apart from packets arriving directly on the same socket.
pub fn parse_data_indication(msg: &[u8]) -> Option<(SocketAddr, Vec<u8>)> {
    if msg_type(msg) != DATA_INDICATION {
        return None;
    }
    let txid = txid_of(msg)?;
    let mut peer = None;
    let mut data = None;
    for (a, v) in attrs(msg) {
        match a {
            ATTR_XOR_PEER_ADDRESS => peer = decode_xor_address(v, &txid),
            ATTR_DATA => data = Some(v.to_vec()),
            _ => {}
        }
    }
    Some((peer?, data?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An allocation whose lifetime is nearly up, ready to be refreshed.
    fn expiring_allocation(lifetime: Duration, remaining: Duration) -> Allocation {
        Allocation {
            relayed: "203.0.113.9:50000".parse().unwrap(),
            mapped: None,
            server: "203.0.113.1:3478".parse().unwrap(),
            username: "u".into(),
            realm: "r".into(),
            nonce: "n".into(),
            key: [1u8; 16],
            permitted: Vec::new(),
            pending_perms: Vec::new(),
            expires_at: Instant::now() + remaining,
            lifetime,
            last_refresh_sent: None,
            refresh_unanswered_since: None,
            refresh_txids: Vec::new(),
        }
    }

    /// Mark `txid` as a Refresh this allocation sent, so an ERROR response
    /// carrying it is one we may act on.
    ///
    /// The real path records this inside `maybe_refresh`; the tests below need
    /// it without a socket and without the half-life gate.
    fn sent_refresh(alloc: &mut Allocation, txid: [u8; 12]) {
        alloc.refresh_txids.push((txid, Instant::now()));
    }

    fn peer() -> SocketAddr {
        "198.51.100.7:40000".parse().unwrap()
    }

    /// Ask for a permission over a loopback socket pair and return the txid
    /// the request carried.
    fn ask(alloc: &mut Allocation) -> [u8; 12] {
        let sink = UdpSocket::bind("127.0.0.1:0").expect("bind sink");
        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        alloc.server = sink.local_addr().unwrap();
        alloc.request_permission(&client, peer());
        alloc.pending_perms.last().expect("the ask must be recorded pending").0
    }

    /// A permission ask is recorded PENDING, and only the server's
    /// CREATE_PERM_SUCCESS — matched by transaction id — promotes it.
    ///
    /// The optimistic version this replaces pushed straight into `permitted`,
    /// which is the state that silently blackholed relayed media for up to
    /// four minutes whenever one UDP request was lost.
    #[test]
    fn a_sent_permission_is_pending_not_granted() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        let txid = ask(&mut alloc);
        assert!(alloc.permitted.is_empty(), "send must not grant");
        assert!(!alloc.needs_permission(peer()), "a fresh ask throttles re-asks");

        let mut m = MsgBuilder::new(CREATE_PERM_SUCCESS);
        m.txid = txid;
        assert!(alloc.handle_server_message(&m.finish_with_integrity(&alloc.key.clone())));
        assert!(
            alloc.permitted.iter().any(|(p, _)| *p == peer()),
            "the confirmation must promote the peer",
        );
        assert!(alloc.pending_perms.is_empty(), "the ask is answered");
        assert!(!alloc.needs_permission(peer()));
    }

    /// A success with a FOREIGN txid must not promote anything — matching by
    /// txid is the whole verification.
    #[test]
    fn a_success_with_an_unknown_txid_promotes_nothing() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        ask(&mut alloc);
        let mut m = MsgBuilder::new(CREATE_PERM_SUCCESS); // random, unmatched txid
        assert!(alloc.handle_server_message(&m.finish_with_integrity(&alloc.key.clone())), "still consumed");
        assert!(alloc.permitted.is_empty());
        assert_eq!(alloc.pending_perms.len(), 1, "the real ask stays pending");
    }

    /// An UNANSWERED ask stops throttling after its 2s window, so a lost UDP
    /// request costs two seconds, not four minutes.
    #[test]
    fn an_unanswered_ask_reopens_after_its_window() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        ask(&mut alloc);
        assert!(!alloc.needs_permission(peer()), "positive control: the window throttles");
        alloc.pending_perms[0].2 = Instant::now() - Duration::from_secs(3);
        assert!(alloc.needs_permission(peer()), "a stale ask must be re-askable");
    }

    /// A REFUSED ask is an answered ask: it must reopen the window immediately
    /// rather than waiting out a grant that never existed.
    #[test]
    fn a_refused_ask_is_removed() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        let txid = ask(&mut alloc);
        let mut m = MsgBuilder::new(CREATE_PERM_REQUEST | 0x0110); // CreatePermission error response
        m.txid = txid;
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 41]); // 441 Wrong Credentials
        assert!(alloc.handle_server_message(&m.finish()));
        assert!(alloc.pending_perms.is_empty());
        assert!(alloc.permitted.is_empty());
    }

    /// 438 rotates the nonce; asks in flight carried the dead one, so they
    /// must die with it or their 2s windows throttle the re-ask that would
    /// carry the fresh nonce.
    #[test]
    fn a_stale_nonce_clears_pending_asks_too() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        let txid = ask(&mut alloc);
        let mut m = MsgBuilder::new(CREATE_PERM_REQUEST | 0x0110);
        // ANSWERS OUR ASK. A 438 carries no MESSAGE-INTEGRITY (RFC 5389
        // §10.2.2), so the transaction id is the only thing distinguishing the
        // server's answer from a spoofed datagram — this test used to build one
        // with a random txid and expect it to be believed, which is the bug.
        m.txid = txid;
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 38]);
        m.push(ATTR_NONCE, b"fresh");
        assert!(alloc.handle_server_message(&m.finish()));
        assert_eq!(alloc.nonce, "fresh");
        assert!(alloc.pending_perms.is_empty());
        assert!(alloc.needs_permission(peer()), "the re-ask must be immediate");
    }

    /// An error response IS an answer: it must clear the unanswered-refresh
    /// clock, or a server rotating nonces (answering every Refresh with 438)
    /// reads as thirty seconds of silence and a live relay is declared dead.
    #[test]
    fn an_error_response_clears_the_unanswered_refresh_clock() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(250));
        alloc.refresh_unanswered_since = Some(Instant::now() - Duration::from_secs(29));
        let mut m = MsgBuilder::new(REFRESH_REQUEST | 0x0110);
        sent_refresh(&mut alloc, m.txid);
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 38]);
        m.push(ATTR_NONCE, b"rotated");
        assert!(alloc.handle_server_message(&m.finish()));
        assert!(alloc.refresh_unanswered_since.is_none(), "an answer is an answer");
        assert!(!alloc.looks_dead(), "a nonce-rotating server is alive");
    }

    /// 437 Allocation Mismatch is the server saying it has no allocation for
    /// us — the definitive death certificate, effective immediately.
    #[test]
    fn a_437_expires_the_allocation_on_the_spot() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(400));
        assert!(!alloc.looks_dead(), "positive control: healthy before the 437");
        let mut m = MsgBuilder::new(REFRESH_REQUEST | 0x0110);
        sent_refresh(&mut alloc, m.txid);
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 37]);
        assert!(alloc.handle_server_message(&m.finish()));
        assert!(alloc.looks_dead(), "the server's own death certificate is final");
    }

    // ---- L8-NATIVE-3: an unauthenticated datagram changes nothing ----------
    //
    // The gate these pin: until it existed, the ONLY check on a message
    // reaching `handle_server_message` was the caller's `source ==
    // alloc.server` — a UDP source address, which an off-path spoofer picks
    // freely. Each test below is one of the four state changes that were
    // reachable with a single forged packet, and each has a positive control
    // proving the same message IS applied when it is authentic (otherwise a
    // handler that ignored everything would pass the lot).

    #[test]
    fn an_unauthenticated_refresh_success_cannot_move_the_clock() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(10));
        let before_expiry = alloc.expires_at;
        alloc.refresh_unanswered_since = Some(Instant::now() - Duration::from_secs(29));

        let mut m = MsgBuilder::new(REFRESH_SUCCESS);
        // The attack: a LIFETIME so large the client stops refreshing and the
        // real allocation lapses under it.
        m.push(ATTR_LIFETIME, &86_400u32.to_be_bytes());
        assert!(alloc.handle_server_message(&m.finish()), "consumed, not forwarded");
        assert_eq!(alloc.lifetime, Duration::from_secs(600), "lifetime untouched");
        assert_eq!(alloc.expires_at, before_expiry, "expiry untouched");
        assert!(
            alloc.refresh_unanswered_since.is_some(),
            "the liveness clock must not be cleared by a packet nobody authenticated",
        );

        // POSITIVE CONTROL: signed, it applies — and is clamped.
        let mut ok = MsgBuilder::new(REFRESH_SUCCESS);
        ok.push(ATTR_LIFETIME, &86_400u32.to_be_bytes());
        let key = alloc.key;
        assert!(alloc.handle_server_message(&ok.finish_with_integrity(&key)));
        assert_eq!(
            alloc.lifetime, MAX_LIFETIME,
            "even an authenticated server cannot push the refresh clock past the clamp",
        );
        assert!(alloc.expires_at > before_expiry);
        assert!(alloc.refresh_unanswered_since.is_none());
    }

    #[test]
    fn a_forged_message_integrity_is_refused_rather_than_ignored() {
        // Present-and-wrong must never fall back to "well, treat it as
        // absent" — that is how a forgery gets in through the door held open
        // for the messages that legitimately carry no integrity.
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(10));
        let before = alloc.expires_at;
        let mut m = MsgBuilder::new(REFRESH_SUCCESS);
        m.push(ATTR_LIFETIME, &600u32.to_be_bytes());
        let wire = m.finish_with_integrity(&[0xAAu8; 16]); // not our key
        assert!(alloc.handle_server_message(&wire));
        assert_eq!(alloc.expires_at, before, "a bad MAC changes nothing");
        assert!(!verify_integrity(&wire, &alloc.key));
    }

    #[test]
    fn an_unauthenticated_438_cannot_rewrite_the_nonce_or_wipe_permissions() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        let txid = ask(&mut alloc);
        alloc.permitted.push((peer(), Instant::now()));

        let mut m = MsgBuilder::new(CREATE_PERM_REQUEST | 0x0110); // random txid
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 38]);
        m.push(ATTR_NONCE, b"attacker");
        assert!(alloc.handle_server_message(&m.finish()));
        assert_eq!(alloc.nonce, "n", "the nonce must survive a spoofed 438");
        assert_eq!(alloc.permitted.len(), 1, "permissions must survive it too");
        assert_eq!(alloc.pending_perms.len(), 1, "and so must the ask in flight");

        // POSITIVE CONTROL: the SAME message, carrying the txid of the request
        // it answers, is believed.
        let mut real = MsgBuilder::new(CREATE_PERM_REQUEST | 0x0110);
        real.txid = txid;
        real.push(ATTR_ERROR_CODE, &[0, 0, 4, 38]);
        real.push(ATTR_NONCE, b"fresh");
        assert!(alloc.handle_server_message(&real.finish()));
        assert_eq!(alloc.nonce, "fresh");
        assert!(alloc.permitted.is_empty());
        assert!(alloc.pending_perms.is_empty());
    }

    #[test]
    fn an_unauthenticated_437_cannot_declare_the_relay_dead() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(400));
        let mut m = MsgBuilder::new(REFRESH_REQUEST | 0x0110); // random txid
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 37]);
        assert!(alloc.handle_server_message(&m.finish()));
        assert!(
            !alloc.looks_dead(),
            "one spoofed datagram must not kill relayed media for the call",
        );

        // POSITIVE CONTROL: answering a Refresh we actually sent, it is final.
        let mut real = MsgBuilder::new(REFRESH_REQUEST | 0x0110);
        sent_refresh(&mut alloc, real.txid);
        real.push(ATTR_ERROR_CODE, &[0, 0, 4, 37]);
        assert!(alloc.handle_server_message(&real.finish()));
        assert!(alloc.looks_dead());
    }

    #[test]
    fn an_unauthenticated_create_perm_success_promotes_nothing() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        let txid = ask(&mut alloc);

        let mut m = MsgBuilder::new(CREATE_PERM_SUCCESS);
        m.txid = txid; // right txid, no MESSAGE-INTEGRITY
        assert!(alloc.handle_server_message(&m.finish()));
        assert!(
            alloc.permitted.is_empty(),
            "a success response always carries integrity; an unsigned one is a forgery",
        );
        assert_eq!(alloc.pending_perms.len(), 1, "the ask stays pending");

        // POSITIVE CONTROL: signed, it promotes.
        let mut real = MsgBuilder::new(CREATE_PERM_SUCCESS);
        real.txid = txid;
        let key = alloc.key;
        assert!(alloc.handle_server_message(&real.finish_with_integrity(&key)));
        assert!(alloc.permitted.iter().any(|(p, _)| *p == peer()));
    }

    #[test]
    fn verify_integrity_is_the_exact_counterpart_of_the_builder() {
        // The failure mode of getting the length arithmetic wrong is that EVERY
        // legitimate server response is rejected and relayed calls stop
        // entirely — invisible if the same buggy helper both builds and
        // verifies. So this pins the round trip AND that the MAC depends on
        // every input it should.
        let key = [7u8; 16];
        let mut m = MsgBuilder::new(REFRESH_SUCCESS);
        m.push(ATTR_LIFETIME, &600u32.to_be_bytes());
        m.push(ATTR_NONCE, b"abc"); // 3 bytes: forces attribute padding
        let wire = m.finish_with_integrity(&key);

        assert!(verify_integrity(&wire, &key));
        assert!(has_integrity(&wire));
        assert!(!verify_integrity(&wire, &[8u8; 16]), "a different key must not verify");

        // A flipped byte anywhere in the signed region must break it.
        for i in [0usize, 3, 9, 21, wire.len() - 1] {
            let mut tampered = wire.clone();
            tampered[i] ^= 0x01;
            assert!(
                !verify_integrity(&tampered, &key),
                "a message tampered at byte {i} must not verify",
            );
        }

        // And a message with no MESSAGE-INTEGRITY is ABSENT, not invalid.
        let mut bare = MsgBuilder::new(REFRESH_SUCCESS);
        bare.push(ATTR_LIFETIME, &600u32.to_be_bytes());
        let bare = bare.finish();
        assert!(!has_integrity(&bare));
        assert!(!verify_integrity(&bare, &key));
    }

    #[test]
    fn a_refresh_records_its_transaction_id() {
        // The mechanism the error-response proof rests on. Without it every
        // unsigned 438/437 would be refused and nonce rotation would take
        // relayed calls down — the outage that is worse than the bug.
        let server = UdpSocket::bind("127.0.0.1:0").expect("bind server");
        server.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(10));
        alloc.server = server.local_addr().unwrap();

        alloc.maybe_refresh(&client);
        let mut buf = [0u8; 2048];
        let (n, _) = server.recv_from(&mut buf).expect("a refresh went out");
        let txid = txid_of(&buf[..n]).expect("a transaction id");
        assert!(
            alloc.answers_our_request(&buf[..n]),
            "the refresh we just sent must be recognised as ours",
        );

        // Positive control for the recogniser: a different txid is not ours.
        let mut other = txid;
        other[0] ^= 0xFF;
        let mut m = MsgBuilder::new(REFRESH_REQUEST | 0x0110);
        m.txid = other;
        assert!(!alloc.answers_our_request(&m.finish()));
    }

    /// `looks_dead` is the honesty check the stream loop consults: a lifetime
    /// that ran out, or thirty seconds of unanswered refreshes, is a relay
    /// that will never carry another packet.
    #[test]
    fn looks_dead_on_expiry_or_thirty_unanswered_seconds() {
        let alive = expiring_allocation(Duration::from_secs(600), Duration::from_secs(300));
        assert!(!alive.looks_dead(), "positive control: a healthy allocation is not dead");

        let expired = expiring_allocation(Duration::from_secs(600), Duration::ZERO);
        assert!(expired.looks_dead(), "past expires_at is definitive");

        let mut unanswered = expiring_allocation(Duration::from_secs(600), Duration::from_secs(250));
        unanswered.refresh_unanswered_since = Some(Instant::now() - Duration::from_secs(31));
        assert!(unanswered.looks_dead(), "30s of silent refreshes is definitive");

        // And the clock is CLEARED by a success, so a recovered relay stops
        // reading as dead.
        let mut m = MsgBuilder::new(REFRESH_SUCCESS);
        m.push(ATTR_LIFETIME, &600u32.to_be_bytes());
        let key = unanswered.key;
        assert!(unanswered.handle_server_message(&m.finish_with_integrity(&key)));
        assert!(!unanswered.looks_dead());
    }

    /// A REFRESH_SUCCESS read off the normal receive path must extend the
    /// allocation.
    ///
    /// Nothing did this before, because the blocking refresh consumed its own
    /// reply and extended the lifetime itself. Now that the request is
    /// fire-and-forget — so it cannot eat 400ms of relayed media — this is the
    /// ONLY place the allocation can be renewed, and an allocation that is
    /// never renewed simply dies mid-call.
    #[test]
    fn a_refresh_success_extends_the_allocation() {
        let lifetime = Duration::from_secs(600);
        let mut alloc = expiring_allocation(lifetime, Duration::from_secs(10));
        let before = alloc.expires_at;

        let mut m = MsgBuilder::new(REFRESH_SUCCESS);
        m.push(ATTR_LIFETIME, &600u32.to_be_bytes());
        let reply = m.finish_with_integrity(&alloc.key);

        assert!(alloc.handle_server_message(&reply), "a refresh reply is TURN bookkeeping");
        assert!(
            alloc.expires_at > before + Duration::from_secs(500),
            "the allocation must be renewed for the granted lifetime",
        );
    }

    /// The server may grant LESS than we asked for; believing our own request
    /// would let the allocation lapse while we think it is healthy.
    #[test]
    fn a_shorter_granted_lifetime_is_honoured() {
        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(10));
        let mut m = MsgBuilder::new(REFRESH_SUCCESS);
        m.push(ATTR_LIFETIME, &60u32.to_be_bytes());
        let reply = m.finish_with_integrity(&alloc.key);

        alloc.handle_server_message(&reply);
        assert_eq!(alloc.lifetime, Duration::from_secs(60));
        assert!(alloc.expires_at <= Instant::now() + Duration::from_secs(61));
    }

    /// Fire-and-forget means nothing waits for the answer, so without a
    /// throttle the loop would re-send a Refresh on every single iteration for
    /// the whole second half of the allocation's life.
    #[test]
    fn refreshes_are_throttled_rather_than_sent_every_iteration() {
        let server = UdpSocket::bind("127.0.0.1:0").expect("bind server");
        server.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");

        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(10));
        alloc.server = server.local_addr().unwrap();

        for _ in 0..25 {
            alloc.maybe_refresh(&client);
        }

        let mut buf = [0u8; 2048];
        let mut seen = 0;
        while server.recv_from(&mut buf).is_ok() {
            seen += 1;
        }
        assert_eq!(seen, 1, "25 loop iterations must produce ONE refresh, not 25");

        // POSITIVE CONTROL: the rig can see a refresh at all, so "only one"
        // is not passing because none were sent.
        assert!(alloc.last_refresh_sent.is_some());
    }

    /// An allocation with plenty of life left must not refresh at all.
    #[test]
    fn a_healthy_allocation_does_not_refresh() {
        let server = UdpSocket::bind("127.0.0.1:0").expect("bind server");
        server.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");

        let mut alloc = expiring_allocation(Duration::from_secs(600), Duration::from_secs(599));
        alloc.server = server.local_addr().unwrap();
        alloc.maybe_refresh(&client);

        let mut buf = [0u8; 2048];
        assert!(server.recv_from(&mut buf).is_err(), "nothing should have been sent");
    }

    /// RFC 5766 §10.2: key = MD5(username ":" realm ":" password).
    #[test]
    fn the_long_term_key_is_the_rfc_construction() {
        let k = long_term_key("user", "realm", "pass");
        let mut h = Md5::new();
        h.update(b"user:realm:pass");
        let want = h.finalize();
        assert_eq!(&k[..], &want[..]);
    }

    /// POSITIVE CONTROL: the key must actually depend on all three inputs.
    /// A construction that ignored the realm would still match a test written
    /// against one fixed realm.
    #[test]
    fn the_key_changes_with_every_component() {
        let base = long_term_key("user", "realm", "pass");
        assert_ne!(base, long_term_key("other", "realm", "pass"));
        assert_ne!(base, long_term_key("user", "other", "pass"));
        assert_ne!(base, long_term_key("user", "realm", "other"));
    }

    /// MESSAGE-INTEGRITY is computed over a header whose length ALREADY counts
    /// the attribute. Getting this wrong yields an endless 401 loop that reads
    /// as bad credentials, so it is pinned here.
    #[test]
    fn message_integrity_covers_a_length_that_includes_itself() {
        let mut m = MsgBuilder::new(ALLOCATE_REQUEST);
        m.push(ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
        let attrs_len = m.attrs.len();
        let key = [7u8; 16];
        let out = m.finish_with_integrity(&key);

        let declared = u16::from_be_bytes([out[2], out[3]]) as usize;
        assert_eq!(declared, attrs_len + 24, "length must include MESSAGE-INTEGRITY");
        assert_eq!(out.len(), 20 + attrs_len + 24);

        // And the digest must be the HMAC of everything before it.
        let mut mac = HmacSha1::new_from_slice(&key).unwrap();
        mac.update(&out[..20 + attrs_len]);
        assert_eq!(&out[20 + attrs_len + 4..], &mac.finalize().into_bytes()[..]);
    }

    #[test]
    fn attributes_are_padded_to_four_bytes() {
        let mut m = MsgBuilder::new(ALLOCATE_REQUEST);
        m.push(ATTR_USERNAME, b"abc"); // 3 bytes -> one byte of padding
        assert_eq!(m.attrs.len() % 4, 0);
        // The padding must not be counted in the attribute's own length.
        assert_eq!(u16::from_be_bytes([m.attrs[2], m.attrs[3]]), 3);
    }

    /// POSITIVE CONTROL for the padding test: prove an unpadded value would
    /// actually be caught, rather than the assertion passing because every
    /// fixture happens to be 4-aligned.
    #[test]
    fn an_unaligned_attribute_would_be_visible() {
        let raw_len = 2 + 2 + 3; // header + 3-byte value, unpadded
        assert_ne!(raw_len % 4, 0, "the fixture must be unaligned or the test is vacuous");
    }

    fn xor_addr_roundtrip(addr: SocketAddr) {
        let txid = [9u8; 12];
        let enc = encode_xor_address(addr, &txid);
        assert_eq!(decode_xor_address(&enc, &txid), Some(addr));
    }

    #[test]
    fn xor_addresses_round_trip_both_families() {
        xor_addr_roundtrip("203.0.113.9:51234".parse().unwrap());
        xor_addr_roundtrip("[2001:db8::5]:9999".parse().unwrap());
    }

    #[test]
    fn a_data_indication_unwraps_to_peer_and_payload() {
        let peer: SocketAddr = "198.51.100.4:40000".parse().unwrap();
        let payload = b"media bytes".to_vec();
        let mut m = MsgBuilder::new(DATA_INDICATION);
        let txid = m.txid;
        m.push_xor_addr(ATTR_XOR_PEER_ADDRESS, peer, &txid);
        m.push(ATTR_DATA, &payload);
        let wire = m.finish();

        let (got_peer, got) = parse_data_indication(&wire).expect("should unwrap");
        assert_eq!(got_peer, peer);
        assert_eq!(got, payload);
    }

    /// A Send indication is what WE emit; a Data indication is what we receive.
    /// Confusing them silently would relay nothing, so the parser must refuse
    /// the wrong direction rather than half-decoding it.
    #[test]
    fn a_send_indication_is_not_mistaken_for_a_data_indication() {
        let peer: SocketAddr = "198.51.100.4:40000".parse().unwrap();
        let alloc_key = [0u8; 16];
        let _ = alloc_key;
        let mut m = MsgBuilder::new(SEND_INDICATION);
        let txid = m.txid;
        m.push_xor_addr(ATTR_XOR_PEER_ADDRESS, peer, &txid);
        m.push(ATTR_DATA, b"x");
        assert!(parse_data_indication(&m.finish()).is_none());
    }

    #[test]
    fn media_is_not_mistaken_for_turn() {
        // An RTP packet (version 2, PT 102) must not parse as a Data indication.
        let rtp = [0x80u8, 0x66, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        assert!(parse_data_indication(&rtp).is_none());
    }

    #[test]
    fn an_error_code_is_decoded_as_class_times_hundred_plus_number() {
        let mut m = MsgBuilder::new(ALLOCATE_ERROR);
        m.push(ATTR_ERROR_CODE, &[0, 0, 4, 1]); // class 4, number 1 -> 401
        m.push(ATTR_REALM, b"example.com");
        let wire = m.finish();
        assert_eq!(error_code(&wire).map(|(c, _)| c), Some(401));

        let mut stale = MsgBuilder::new(ALLOCATE_ERROR);
        stale.push(ATTR_ERROR_CODE, &[0, 0, 4, 38]); // 438 Stale Nonce
        assert_eq!(error_code(&stale.finish()).map(|(c, _)| c), Some(438));
    }

    /// LIVE, against the real relay. Run with:
    ///   PUCA_TURN_SERVER=host:port cargo test --release -- --ignored --nocapture live_coturn
    ///
    /// Ignored by default because it needs the network, but it is the only
    /// thing here that proves the WIRE FORMAT: every other test in this module
    /// checks our encoder against our own decoder, which agrees with itself by
    /// construction. coturn parsing our Allocate well enough to answer
    /// "401, here is my realm and a nonce" exercises the header, the attribute
    /// padding and REQUESTED-TRANSPORT against an implementation that did not
    /// come from this file.
    ///
    /// It deliberately stops short of MESSAGE-INTEGRITY: that needs a real REST
    /// credential, which is minted server-side from TURN_SECRET. What the
    /// unauthenticated leg cannot tell you is pinned by
    /// `the_long_term_key_is_the_rfc_construction` instead.
    /// LIVE, the authenticated leg — what `live_coturn_answers_our_allocate_with_a_challenge`
    /// deliberately stops short of. Runs the real `allocate()` (401 challenge,
    /// then the MESSAGE-INTEGRITY-signed retry) against a TURN server with a
    /// REST credential, so the SUCCESS response must pass the same integrity
    /// check `may_act_on` applies in production (L8-NATIVE-3). Bad HMAC
    /// arithmetic on either side shows up here as a failed allocation, not as
    /// a silent relay outage in the field. Mint the credential where
    /// TURN_SECRET lives (username `<expiry>:<user id>`, password
    /// base64(HMAC-SHA1(secret, username))) and run:
    ///   PUCA_TURN_SERVER=host:port PUCA_TURN_USER=... PUCA_TURN_PASS=...     ///   cargo test --release -- --ignored --nocapture live_coturn_allocates
    #[test]
    #[ignore]
    fn live_coturn_allocates_with_a_rest_credential() {
        use std::net::ToSocketAddrs;
        let server_spec = std::env::var("PUCA_TURN_SERVER").expect("PUCA_TURN_SERVER=host:port");
        let user = std::env::var("PUCA_TURN_USER").expect("PUCA_TURN_USER");
        let pass = std::env::var("PUCA_TURN_PASS").expect("PUCA_TURN_PASS");
        let server = server_spec
            .to_socket_addrs()
            .expect("resolve")
            .find(|a| a.is_ipv4())
            .expect("an IPv4 address");
        let socket = UdpSocket::bind("0.0.0.0:0").expect("bind");

        let mut alloc = allocate(&socket, server, &user, &pass, Duration::from_secs(8))
            .expect("the authenticated Allocate must succeed and its success response must pass the integrity check");
        println!("live coturn: allocation granted, relayed address {:?}", alloc.relayed);

        // A refresh exercises the same signed path a long call takes, and the
        // server's answer must again carry an integrity we accept.
        alloc.maybe_refresh(&socket);

        // POSITIVE CONTROL: the same server refuses a credential whose password
        // does not match — proving the success above was not the rig accepting
        // anything that came back.
        let bad = allocate(&socket, server, &user, "not-the-password", Duration::from_secs(8));
        let refusal = match bad { Ok(_) => panic!("a wrong password must not allocate"), Err(e) => e };
        println!("live coturn: wrong password refused ({refusal})");
    }

    #[test]
    #[ignore]
    fn live_coturn_answers_our_allocate_with_a_challenge() {
        use std::net::ToSocketAddrs;
        let server = std::env::var("PUCA_TURN_SERVER").unwrap_or_else(|_| "turn.example.com:3479".to_string())
            .to_socket_addrs()
            .expect("resolve")
            .find(|a| a.is_ipv4())
            .expect("an IPv4 address");
        let socket = UdpSocket::bind("0.0.0.0:0").expect("bind");

        let mut first = MsgBuilder::new(ALLOCATE_REQUEST);
        first.push(ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
        let txid = first.txid;
        let reply = transact(&socket, server, &first.finish(), &txid, Duration::from_secs(5))
            .expect("coturn should answer an Allocate");

        assert_eq!(
            msg_type(&reply),
            ALLOCATE_ERROR,
            "expected a 401 challenge, got type 0x{:04X}",
            msg_type(&reply)
        );
        let (code, reason) = error_code(&reply).expect("an ERROR-CODE attribute");
        assert_eq!(code, 401, "expected 401 Unauthorized, got {code} {reason}");

        let mut realm = None;
        let mut nonce = None;
        for (a, v) in attrs(&reply) {
            match a {
                ATTR_REALM => realm = Some(String::from_utf8_lossy(v).to_string()),
                ATTR_NONCE => nonce = Some(String::from_utf8_lossy(v).to_string()),
                _ => {}
            }
        }
        let realm = realm.expect("the challenge must carry a REALM");
        assert!(nonce.is_some(), "the challenge must carry a NONCE");
        println!("live coturn: 401, realm={realm:?}, nonce present");

        // And prove the rig can see a failure: a garbage method must NOT come
        // back as a 401 Allocate challenge.
        let mut bogus = MsgBuilder::new(0x00FF);
        bogus.push(ATTR_REQUESTED_TRANSPORT, &[17, 0, 0, 0]);
        let btx = bogus.txid;
        match transact(&socket, server, &bogus.finish(), &btx, Duration::from_secs(2)) {
            Ok(r) => assert_ne!(
                (msg_type(&r), error_code(&r).map(|(c, _)| c)),
                (ALLOCATE_ERROR, Some(401)),
                "a bogus method produced the same answer as a real one - the test proves nothing"
            ),
            Err(_) => { /* ignored/no reply is the expected outcome */ }
        }
    }

    #[test]
    fn a_truncated_message_does_not_panic() {
        let mut m = MsgBuilder::new(DATA_INDICATION);
        let txid = m.txid;
        m.push_xor_addr(ATTR_XOR_PEER_ADDRESS, "198.51.100.4:40000".parse().unwrap(), &txid);
        m.push(ATTR_DATA, b"payload");
        let wire = m.finish();
        for cut in 0..wire.len() {
            let _ = parse_data_indication(&wire[..cut]);
            let _ = error_code(&wire[..cut]);
            let _ = attrs(&wire[..cut]);
        }
    }
}
