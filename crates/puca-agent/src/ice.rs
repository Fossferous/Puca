//! ICE candidate gathering for the agent's stream socket.
//!
//! WHY THIS EXISTS: str0m is sans-IO. It owns the ICE state machine but never
//! touches a socket, so it cannot discover a server-reflexive address or hold a
//! TURN allocation — the caller must. Nothing did, so until 0.8.6 the agent
//! answered every offer with host candidates only:
//!
//!     a=candidate:... udp ... 192.168.0.77 62393 typ host
//!     a=candidate:... udp ... 127.0.0.1    62393 typ host
//!
//! which works on one LAN segment and nowhere else. The webview host had
//! relaying all along (`fetchIceConfig()`), so shipping the agent in 0.8.4
//! silently moved users onto the worse transport. See `protocol::StartStream`.
//!
//! SHARING THE STREAM SOCKET IS THE POINT. A reflexive address is only useful
//! if it is the mapping for the socket str0m actually sends from, so gathering
//! runs on that socket before the stream thread starts. That is also why it is
//! strictly time-boxed: it happens inside the synchronous `start()` that the
//! app is blocked on, so a black-holed STUN server must cost a bounded wait,
//! never the session.

use crate::protocol::IceServer;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// STUN magic cookie (RFC 5389 §6).
const MAGIC: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// What gathering actually produced, and what it could not.
///
/// `notes` is not decoration. This feature's defining defect is failing without
/// saying why — a passphrase that enforced nothing, an update that failed
/// silently, a controller that waited forever, a probe that returned a bare
/// bool. A gather that quietly yields nothing would look exactly like the bug
/// it is meant to fix, so every server that did not answer says so here and the
/// caller puts it in the log and the reply.
#[derive(Default)]
pub struct Gathered {
    /// Reflexive addresses, paired with the local base they were mapped from.
    pub srflx: Vec<(SocketAddr, SocketAddr)>,
    /// A live TURN allocation, if one could be made. This is the candidate that
    /// makes remote control work between two machines that share no network —
    /// srflx alone does not survive symmetric NAT, which is the common case for
    /// a phone on mobile data.
    pub relay: Option<crate::turn::Allocation>,
    pub notes: Vec<String>,
}

impl Gathered {
    pub fn describe(&self) -> String {
        if self.notes.is_empty() && self.srflx.is_empty() {
            return "no ICE servers were supplied; host candidates only".to_string();
        }
        let mut s = format!(
            "{} reflexive, {}",
            self.srflx.len(),
            match &self.relay {
                Some(a) => format!("relay {}", a.relayed),
                None => "NO RELAY".to_string(),
            }
        );
        if !self.notes.is_empty() {
            s.push_str(" (");
            s.push_str(&self.notes.join("; "));
            s.push(')');
        }
        s
    }
}

/// A `stun:`/`stuns:`/`turn:`/`turns:` URL split into scheme and host:port.
///
/// Written by hand rather than with a URL crate because these are not URLs in
/// the generic sense: RFC 7064/7065 put the transport in a `?transport=` query
/// and allow no path or authority, so a general parser gets the host wrong on
/// exactly the forms that matter.
struct IceUrl<'a> {
    scheme: &'a str,
    host_port: &'a str,
    transport_udp: bool,
}

fn parse_ice_url(raw: &str) -> Option<IceUrl<'_>> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once(':')?;
    let scheme = scheme.trim();
    if !matches!(scheme, "stun" | "stuns" | "turn" | "turns") {
        return None;
    }
    // `?transport=tcp` means this URL is not for our UDP socket.
    let (host_port, query) = match rest.split_once('?') {
        Some((h, q)) => (h, Some(q)),
        None => (rest, None),
    };
    let transport_udp = match query {
        Some(q) => {
            let q = q.to_ascii_lowercase();
            !q.contains("transport=tcp") && !q.contains("transport=tls")
        }
        None => true,
    };
    if host_port.is_empty() {
        return None;
    }
    Some(IceUrl { scheme, host_port, transport_udp })
}

/// Default ports per RFC 7064/7065 when the URL omits one.
fn with_default_port(host_port: &str, scheme: &str) -> String {
    // An IPv6 literal is bracketed; a colon inside brackets is not a port.
    let has_port = match host_port.rfind(']') {
        Some(close) => host_port[close..].contains(':'),
        None => host_port.matches(':').count() == 1,
    };
    if has_port {
        return host_port.to_string();
    }
    let port = if scheme.ends_with('s') { 5349 } else { 3478 };
    format!("{host_port}:{port}")
}

/// Ask one STUN server what address it sees us on, using `socket`.
///
/// Returns the mapped address. The transaction id is compared on the way back:
/// without that check any stray packet arriving on this socket during the
/// window could be read as a STUN reply and advertised as our public address.
fn stun_binding(socket: &UdpSocket, server: SocketAddr, budget: Duration) -> Result<SocketAddr, String> {
    let mut txid = [0u8; 12];
    fill_random(&mut txid);

    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
    req.extend_from_slice(&0u16.to_be_bytes()); // no attributes
    req.extend_from_slice(&MAGIC.to_be_bytes());
    req.extend_from_slice(&txid);

    socket
        .send_to(&req, server)
        .map_err(|e| format!("send failed: {e}"))?;

    let deadline = Instant::now() + budget;
    let mut buf = [0u8; 1500];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("no reply".to_string());
        }
        socket
            .set_read_timeout(Some(left))
            .map_err(|e| format!("could not set a timeout: {e}"))?;
        let (n, from) = match socket.recv_from(&mut buf) {
            Ok(v) => v,
            Err(_) => return Err("no reply".to_string()),
        };
        if from != server {
            continue; // not ours; keep waiting within the budget
        }
        match parse_binding_response(&buf[..n], &txid) {
            Some(addr) => return Ok(addr),
            // A packet from the right peer that is not our response: ignore
            // rather than abort, the budget still bounds us.
            None => continue,
        }
    }
}

/// Pull the mapped address out of a Binding success response.
///
/// Returns None for anything that is not a success response for `txid` — that
/// includes an error response, which is deliberately not distinguished: the
/// caller reports "no usable reply" either way and the distinction has never
/// changed what it does.
fn parse_binding_response(msg: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    if msg.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([msg[0], msg[1]]);
    if msg_type != BINDING_SUCCESS {
        return None;
    }
    if u32::from_be_bytes([msg[4], msg[5], msg[6], msg[7]]) != MAGIC {
        return None;
    }
    if &msg[8..20] != txid {
        return None;
    }
    let len = u16::from_be_bytes([msg[2], msg[3]]) as usize;
    let body = msg.get(20..20 + len)?;

    let mut i = 0usize;
    let mut fallback = None;
    while i + 4 <= body.len() {
        let attr = u16::from_be_bytes([body[i], body[i + 1]]);
        let alen = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let val = body.get(i + 4..i + 4 + alen)?;
        match attr {
            ATTR_XOR_MAPPED_ADDRESS => {
                if let Some(a) = decode_address(val, true, txid) {
                    return Some(a); // preferred: survives NATs that rewrite payloads
                }
            }
            ATTR_MAPPED_ADDRESS => {
                if fallback.is_none() {
                    fallback = decode_address(val, false, txid);
                }
            }
            _ => {}
        }
        // Attributes are padded to a 4-byte boundary.
        i += 4 + alen.div_ceil(4) * 4;
    }
    fallback
}

/// MAPPED-ADDRESS / XOR-MAPPED-ADDRESS value decoding (RFC 5389 §15.1-15.2).
pub(crate) fn decode_address(val: &[u8], xor: bool, txid: &[u8; 12]) -> Option<SocketAddr> {
    if val.len() < 4 {
        return None;
    }
    let family = val[1];
    let raw_port = u16::from_be_bytes([val[2], val[3]]);
    let port = if xor { raw_port ^ (MAGIC >> 16) as u16 } else { raw_port };

    match family {
        0x01 => {
            let b = val.get(4..8)?;
            let mut ip = [b[0], b[1], b[2], b[3]];
            if xor {
                let cookie = MAGIC.to_be_bytes();
                for k in 0..4 {
                    ip[k] ^= cookie[k];
                }
            }
            Some(SocketAddr::from((ip, port)))
        }
        0x02 => {
            let b = val.get(4..20)?;
            let mut ip = [0u8; 16];
            ip.copy_from_slice(b);
            if xor {
                let cookie = MAGIC.to_be_bytes();
                for k in 0..16 {
                    ip[k] ^= if k < 4 { cookie[k] } else { txid[k - 4] };
                }
            }
            Some(SocketAddr::from((ip, port)))
        }
        _ => None,
    }
}

/// Discover reflexive addresses for `socket` from the supplied ICE servers.
///
/// `base` is the local address the reflexive candidates are mapped from —
/// str0m needs it to build the candidate, and it must be a real interface
/// address rather than the wildcard the socket is bound to.
///
/// Runs inside the app's synchronous `start()` call, so `budget` is a hard
/// ceiling on the whole thing, not per server.
pub fn gather(
    socket: &UdpSocket,
    servers: &[IceServer],
    base: SocketAddr,
    budget: Duration,
) -> Gathered {
    let mut out = Gathered::default();
    if servers.is_empty() {
        out.notes.push("the app sent no ICE servers".to_string());
        return out;
    }

    let deadline = Instant::now() + budget;
    let mut seen: Vec<SocketAddr> = Vec::new();

    for server in servers {
        for url in server.urls.as_slice() {
            if Instant::now() >= deadline {
                out.notes.push("ran out of time before every server was tried".to_string());
                return out;
            }
            let Some(parsed) = parse_ice_url(url) else {
                out.notes.push(format!("{url}: not a STUN/TURN URL"));
                continue;
            };
            // TURN needs an allocation, not a binding, and a `turns:`/TCP URL
            // is not reachable from this UDP socket at all. Say which, rather
            // than dropping them and reporting a smaller candidate set with no
            // explanation.
            if !parsed.transport_udp {
                out.notes.push(format!("{url}: not UDP, skipped"));
                continue;
            }
            if parsed.scheme.starts_with("turn") {
                if out.relay.is_some() {
                    continue; // one allocation is enough
                }
                let (Some(user), Some(pass)) = (&server.username, &server.credential) else {
                    out.notes.push(format!("{url}: TURN needs a username and credential"));
                    continue;
                };
                let target = with_default_port(parsed.host_port, parsed.scheme);
                let resolved = match target.to_socket_addrs() {
                    Ok(it) => it.filter(|a| a.is_ipv4() == base.is_ipv4()).next(),
                    Err(e) => {
                        out.notes.push(format!("{url}: does not resolve ({e})"));
                        continue;
                    }
                };
                let Some(addr) = resolved else {
                    out.notes.push(format!("{url}: no address of this IP version"));
                    continue;
                };
                let left = deadline.saturating_duration_since(Instant::now());
                match crate::turn::allocate(socket, addr, user, pass, left.min(Duration::from_millis(1_200))) {
                    Ok(alloc) => {
                        // The Allocate response carries our mapped address, so a
                        // reflexive candidate comes free with the relay and needs
                        // no extra STUN round trip.
                        if let Some(m) = alloc.mapped {
                            if m.ip() != base.ip() && !seen.contains(&m) {
                                seen.push(m);
                                out.srflx.push((m, base));
                            }
                        }
                        out.relay = Some(alloc);
                    }
                    Err(e) => out.notes.push(format!("{url}: {e}")),
                }
                continue;
            }

            let target = with_default_port(parsed.host_port, parsed.scheme);
            let resolved = match target.to_socket_addrs() {
                Ok(it) => it.filter(|a| a.is_ipv4() == base.is_ipv4()).collect::<Vec<_>>(),
                Err(e) => {
                    out.notes.push(format!("{url}: does not resolve ({e})"));
                    continue;
                }
            };
            let Some(addr) = resolved.into_iter().next() else {
                out.notes.push(format!("{url}: no address of this IP version"));
                continue;
            };

            let left = deadline.saturating_duration_since(Instant::now());
            let per_server = left.min(Duration::from_millis(700));
            match stun_binding(socket, addr, per_server) {
                Ok(mapped) => {
                    if mapped.ip() == base.ip() {
                        // Not behind NAT: the reflexive address IS the host
                        // candidate, and offering it twice only wastes checks.
                        out.notes.push(format!("{url}: not behind NAT"));
                    } else if !seen.contains(&mapped) {
                        seen.push(mapped);
                        out.srflx.push((mapped, base));
                    }
                }
                Err(e) => out.notes.push(format!("{url}: {e}")),
            }
        }
    }
    out
}

#[cfg(windows)]
pub(crate) fn fill_random(buf: &mut [u8]) {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    unsafe {
        let _ = BCryptGenRandom(None, buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    }
}

#[cfg(not(windows))]
pub(crate) fn fill_random(buf: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn txid() -> [u8; 12] {
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    }

    /// Build a Binding success response carrying XOR-MAPPED-ADDRESS.
    fn xor_mapped_response(ip: Ipv4Addr, port: u16, tx: &[u8; 12]) -> Vec<u8> {
        let cookie = MAGIC.to_be_bytes();
        let xport = port ^ (MAGIC >> 16) as u16;
        let o = ip.octets();
        let xip = [o[0] ^ cookie[0], o[1] ^ cookie[1], o[2] ^ cookie[2], o[3] ^ cookie[3]];

        let mut attrs = Vec::new();
        attrs.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        attrs.extend_from_slice(&8u16.to_be_bytes());
        attrs.push(0);
        attrs.push(0x01);
        attrs.extend_from_slice(&xport.to_be_bytes());
        attrs.extend_from_slice(&xip);

        let mut msg = Vec::new();
        msg.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        msg.extend_from_slice(&(attrs.len() as u16).to_be_bytes());
        msg.extend_from_slice(&cookie);
        msg.extend_from_slice(tx);
        msg.extend_from_slice(&attrs);
        msg
    }

    #[test]
    fn decodes_a_real_xor_mapped_address() {
        let tx = txid();
        let msg = xor_mapped_response(Ipv4Addr::new(203, 0, 113, 7), 51234, &tx);
        let got = parse_binding_response(&msg, &tx).expect("should decode");
        assert_eq!(got, SocketAddr::from(([203, 0, 113, 7], 51234)));
    }

    /// POSITIVE CONTROL for the test above: the decoder must actually be doing
    /// the XOR, not returning the raw bytes. Without this, a decoder that
    /// skipped the XOR entirely would still pass a test written against a
    /// fixture that was never XOR'd in the first place.
    #[test]
    fn the_xor_is_really_applied() {
        let tx = txid();
        let msg = xor_mapped_response(Ipv4Addr::new(203, 0, 113, 7), 51234, &tx);
        // The wire bytes must NOT equal the decoded address.
        let raw_ip = &msg[28..32];
        assert_ne!(
            raw_ip,
            &[203, 0, 113, 7],
            "fixture is not XOR-encoded, so the decode test proves nothing"
        );
    }

    /// A reply for someone else's transaction must never become our public
    /// address — otherwise any process able to spray this socket could choose
    /// what we advertise.
    #[test]
    fn a_response_for_another_transaction_is_refused() {
        let tx = txid();
        let mut other = tx;
        other[0] ^= 0xFF;
        let msg = xor_mapped_response(Ipv4Addr::new(203, 0, 113, 7), 51234, &other);
        assert!(parse_binding_response(&msg, &tx).is_none());
    }

    #[test]
    fn an_error_response_is_not_read_as_an_address() {
        let tx = txid();
        let mut msg = xor_mapped_response(Ipv4Addr::new(203, 0, 113, 7), 51234, &tx);
        msg[0] = 0x01;
        msg[1] = 0x11; // Binding error response
        assert!(parse_binding_response(&msg, &tx).is_none());
    }

    #[test]
    fn a_truncated_attribute_does_not_panic() {
        let tx = txid();
        let msg = xor_mapped_response(Ipv4Addr::new(203, 0, 113, 7), 51234, &tx);
        for cut in 20..msg.len() {
            let _ = parse_binding_response(&msg[..cut], &tx);
        }
    }

    #[test]
    fn ice_urls_are_split_the_way_rfc7064_writes_them() {
        let u = parse_ice_url("stun:stun.l.google.com:19302").expect("stun");
        assert_eq!(u.scheme, "stun");
        assert_eq!(u.host_port, "stun.l.google.com:19302");
        assert!(u.transport_udp);

        let t = parse_ice_url("turn:turn.example.com:3478?transport=udp").expect("turn");
        assert_eq!(t.scheme, "turn");
        assert_eq!(t.host_port, "turn.example.com:3478");
        assert!(t.transport_udp);

        let tcp = parse_ice_url("turn:turn.example.com:3478?transport=tcp").expect("turn tcp");
        assert!(!tcp.transport_udp, "a TCP URL is not usable from our UDP socket");

        assert!(parse_ice_url("https://example.com").is_none());
    }

    #[test]
    fn a_url_without_a_port_gets_the_scheme_default() {
        assert_eq!(with_default_port("turn.example.com", "turn"), "turn.example.com:3478");
        assert_eq!(with_default_port("turn.example.com", "turns"), "turn.example.com:5349");
        assert_eq!(with_default_port("turn.example.com:9999", "turn"), "turn.example.com:9999");
        // An IPv6 literal's inner colons are not a port.
        assert_eq!(with_default_port("[2001:db8::1]", "stun"), "[2001:db8::1]:3478");
        assert_eq!(with_default_port("[2001:db8::1]:1234", "stun"), "[2001:db8::1]:1234");
    }

    #[test]
    fn no_servers_is_reported_rather_than_silently_empty() {
        let sock = UdpSocket::bind("127.0.0.1:0").expect("bind");
        let base = sock.local_addr().unwrap();
        let g = gather(&sock, &[], base, Duration::from_millis(50));
        assert!(g.srflx.is_empty());
        assert!(
            !g.notes.is_empty(),
            "a gather that finds nothing MUST say why - silence is the bug being fixed"
        );
    }
}
