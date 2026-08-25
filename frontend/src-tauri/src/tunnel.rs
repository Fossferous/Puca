//! TCP tunnelling policy for device sessions — who the host may be told to dial.
//!
//! WHAT THIS FEATURE IS, stated bluntly because the UI has to say it too: a
//! tunnel lets a remote controller reach hosts on the HOST'S network that it
//! could not otherwise reach. That is a lateral-movement primitive. "Forward
//! 3389 so I can RDP into my own PC" and "pivot from a compromised laptop into
//! the LAN behind it" are the same mechanism; only policy separates them.
//!
//! So the policy lives here, alone, with no I/O — every rule is a pure function
//! over an address, which is what makes the refusals exhaustively testable.
//!
//! THE RULE THAT MATTERS: check the address we are ABOUT TO CONNECT TO, never
//! the name we were given. A hostname is resolved first, the RESOLVED address is
//! checked, and the connection is then made to that exact address. Checking a
//! name and reconnecting by name lets DNS return something different the second
//! time — the same time-of-check/time-of-use shape as the symlink escape that
//! `file_transfer.rs` guards against by canonicalizing and re-checking.

use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// One permitted destination: a CIDR block, optionally narrowed to some ports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TargetRule {
    /// Network base address, e.g. `127.0.0.0`.
    pub base: IpAddr,
    /// Prefix length in bits. 32 (v4) / 128 (v6) means a single host.
    pub prefix: u8,
    /// Permitted ports. EMPTY MEANS ALL — the common case is "this subnet, any
    /// port", and forcing every rule to enumerate ports would push people
    /// towards a wildcard rule instead.
    #[serde(default)]
    pub ports: Vec<u16>,
}

impl TargetRule {
    /// A rule for exactly one address. Part of the policy-building API the
    /// settings UI will use; exercised by the tests until then.
    #[allow(dead_code)]
    pub fn host(ip: IpAddr) -> Self {
        let prefix = if ip.is_ipv4() { 32 } else { 128 };
        Self { base: ip, prefix, ports: Vec::new() }
    }

    fn contains(&self, addr: &SocketAddr) -> bool {
        if !self.ports.is_empty() && !self.ports.contains(&addr.port()) {
            return false;
        }
        match (self.base, normalize(addr.ip())) {
            (IpAddr::V4(base), IpAddr::V4(ip)) => {
                prefix_match(&base.octets(), &ip.octets(), self.prefix)
            }
            (IpAddr::V6(base), IpAddr::V6(ip)) => {
                prefix_match(&base.octets(), &ip.octets(), self.prefix)
            }
            // Families never match across each other. Normalization above has
            // already folded v4-mapped v6 down to v4, so a rule for 127.0.0.0/8
            // still catches `::ffff:127.0.0.1`.
            _ => false,
        }
    }
}

/// Compare the first `prefix` bits of two addresses.
fn prefix_match(base: &[u8], ip: &[u8], prefix: u8) -> bool {
    let max = (base.len() * 8) as u8;
    // A prefix longer than the address would silently match nothing useful;
    // clamping keeps a malformed rule from becoming an accidental allow-all in
    // the other direction.
    let prefix = prefix.min(max);
    let full = (prefix / 8) as usize;
    if base[..full] != ip[..full] {
        return false;
    }
    let rem = prefix % 8;
    if rem == 0 {
        return true;
    }
    let mask = 0xFFu8 << (8 - rem);
    base[full] & mask == ip[full] & mask
}

/// Fold an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) down to plain IPv4.
///
/// WITHOUT THIS THE ALLOWLIST IS BYPASSABLE. `::ffff:192.168.1.10` reaches the
/// same host as `192.168.1.10`, but compares equal to neither an IPv4 rule nor
/// any sane IPv6 rule — so a deny-by-default list would let it through as
/// "no rule matched" if the check were written the other way round, and even
/// here it would slip past a correct `192.168.0.0/16` rule.
fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

/// Whether tunnelling is permitted at all, and to where.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelPolicy {
    /// OFF BY DEFAULT. A remote-desktop feature that silently also forwards
    /// ports is not something a user consented to by enabling remote desktop.
    #[serde(default)]
    pub enabled: bool,
    /// Where the host may be asked to connect. Empty means nowhere.
    #[serde(default)]
    pub allowed: Vec<TargetRule>,
    /// Set when the host runs with machine-wide privilege (the SYSTEM service).
    /// Tunnelling there is refused unless `armed_for_elevated` is also set: a
    /// pivot from a SYSTEM process is a materially worse outcome than a pivot
    /// from a user session, and it should take a second, separate decision.
    #[serde(default)]
    pub elevated_host: bool,
    #[serde(default)]
    pub armed_for_elevated: bool,
}

impl Default for TunnelPolicy {
    /// Disabled, and scoped to the loopback interface if it is ever enabled.
    ///
    /// Loopback-only is the conservative default most remote-desktop tools ship, and covers the
    /// motivating case (forward 3389 and RDP into the host itself) without
    /// granting anything on the host's LAN.
    fn default() -> Self {
        Self {
            enabled: false,
            allowed: vec![
                TargetRule {
                    base: IpAddr::V4(Ipv4Addr::new(127, 0, 0, 0)),
                    prefix: 8,
                    ports: Vec::new(),
                },
                TargetRule {
                    base: IpAddr::V6(Ipv6Addr::LOCALHOST),
                    prefix: 128,
                    ports: Vec::new(),
                },
            ],
            elevated_host: false,
            armed_for_elevated: false,
        }
    }
}

/// Why a tunnel was refused. Distinct variants because the UI must explain the
/// reason — "denied" with no cause is what makes people disable the allowlist.
#[derive(Debug, PartialEq)]
pub enum TunnelDenied {
    Disabled,
    ElevatedNotArmed,
    NotAllowed(SocketAddr),
    Unroutable(String),
}

impl std::fmt::Display for TunnelDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelDenied::Disabled => {
                write!(f, "port forwarding is turned off for this device")
            }
            TunnelDenied::ElevatedNotArmed => write!(
                f,
                "this host runs with machine-wide privilege; port forwarding must be \
                 armed separately before it can be used"
            ),
            TunnelDenied::NotAllowed(a) => write!(
                f,
                "{a} is not in this device's list of permitted forwarding targets"
            ),
            TunnelDenied::Unroutable(why) => write!(f, "{why}"),
        }
    }
}

/// THE GATE. Every tunnel must pass this, with the address actually being dialled.
///
/// A valid device session is NOT sufficient authorization — that is the whole
/// point. Session membership says who may drive the screen; this says where the
/// machine may be pointed.
pub fn check_target(policy: &TunnelPolicy, addr: SocketAddr) -> Result<(), TunnelDenied> {
    if !policy.enabled {
        return Err(TunnelDenied::Disabled);
    }
    if policy.elevated_host && !policy.armed_for_elevated {
        return Err(TunnelDenied::ElevatedNotArmed);
    }

    let ip = normalize(addr.ip());
    // Refused regardless of the allowlist. These are not useful forwarding
    // targets and each is a known way to reach something unintended: port 0 is
    // "any port", the unspecified address means "this host" on some stacks, and
    // multicast/broadcast turn one connection into many.
    if addr.port() == 0 {
        return Err(TunnelDenied::Unroutable("port 0 is not a real destination".into()));
    }
    if ip.is_unspecified() {
        return Err(TunnelDenied::Unroutable(format!(
            "{ip} is the unspecified address, not a destination"
        )));
    }
    if ip.is_multicast() {
        return Err(TunnelDenied::Unroutable(format!("{ip} is multicast")));
    }
    if let IpAddr::V4(v4) = ip {
        if v4.is_broadcast() {
            return Err(TunnelDenied::Unroutable(format!("{v4} is a broadcast address")));
        }
    }

    let target = SocketAddr::new(ip, addr.port());
    if policy.allowed.iter().any(|r| r.contains(&target)) {
        Ok(())
    } else {
        Err(TunnelDenied::NotAllowed(target))
    }
}

/// Resolve a target and return the address that is BOTH reachable and permitted.
///
/// The returned `SocketAddr` is the one the caller must connect to — by
/// address, never by name again. Re-resolving after the check is the whole
/// vulnerability: DNS is free to answer differently the second time, so a name
/// that passed the allowlist can become an address that never would have.
///
/// When several addresses resolve, the first PERMITTED one wins rather than the
/// first returned. A host with both an allowed and a disallowed address is a
/// normal dual-stack situation, not an attack, and refusing it outright would
/// break `localhost` on most machines.
pub fn resolve_target(
    host: &str,
    port: u16,
    policy: &TunnelPolicy,
) -> Result<SocketAddr, TunnelDenied> {
    use std::net::ToSocketAddrs;

    // Cheap checks first, so a disabled policy never triggers a DNS lookup. A
    // refused request should not become an observable network side effect.
    if !policy.enabled {
        return Err(TunnelDenied::Disabled);
    }
    if policy.elevated_host && !policy.armed_for_elevated {
        return Err(TunnelDenied::ElevatedNotArmed);
    }

    let candidates: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| TunnelDenied::Unroutable(format!("cannot resolve {host}: {e}")))?
        .collect();
    if candidates.is_empty() {
        return Err(TunnelDenied::Unroutable(format!("{host} resolved to no addresses")));
    }

    let mut last = None;
    for addr in &candidates {
        match check_target(policy, *addr) {
            Ok(()) => return Ok(SocketAddr::new(normalize(addr.ip()), addr.port())),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or(TunnelDenied::NotAllowed(candidates[0])))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn sa(s: &str) -> SocketAddr {
        SocketAddr::from_str(s).expect(s)
    }

    fn enabled(rules: Vec<TargetRule>) -> TunnelPolicy {
        TunnelPolicy { enabled: true, allowed: rules, ..Default::default() }
    }

    #[test]
    fn the_default_policy_forwards_nothing() {
        // The single most important assertion in this file. If tunnelling ever
        // defaults to on, every existing device gains a lateral-movement
        // primitive on upgrade without anyone choosing it.
        let p = TunnelPolicy::default();
        assert!(!p.enabled);
        assert_eq!(check_target(&p, sa("127.0.0.1:3389")), Err(TunnelDenied::Disabled));
        assert_eq!(check_target(&p, sa("192.168.1.10:445")), Err(TunnelDenied::Disabled));
    }

    #[test]
    fn enabling_the_default_policy_grants_loopback_only() {
        let p = TunnelPolicy { enabled: true, ..Default::default() };
        assert!(check_target(&p, sa("127.0.0.1:3389")).is_ok());
        assert!(check_target(&p, sa("127.5.6.7:22")).is_ok(), "all of 127/8 is loopback");
        assert!(check_target(&p, sa("[::1]:3389")).is_ok());
        // The motivating misuse: enabling "forward a port" must not silently
        // grant the host's LAN.
        assert_eq!(
            check_target(&p, sa("192.168.1.10:445")),
            Err(TunnelDenied::NotAllowed(sa("192.168.1.10:445"))),
        );
        assert!(check_target(&p, sa("8.8.8.8:53")).is_err());
    }

    #[test]
    fn an_ipv4_mapped_ipv6_address_cannot_slip_past_an_ipv4_rule() {
        // ::ffff:192.168.1.10 reaches the same machine as 192.168.1.10. If
        // normalization were missing, this would compare against no IPv4 rule
        // at all and the deny would depend on rule ORDER rather than on policy.
        let p = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::new(10, 0, 0, 0)),
            prefix: 8,
            ports: Vec::new(),
        }]);
        assert!(check_target(&p, sa("10.1.2.3:80")).is_ok());
        assert!(
            check_target(&p, sa("[::ffff:192.168.1.10]:80")).is_err(),
            "a mapped address outside the rule must still be refused",
        );
        // And the allow direction: a mapped address INSIDE the rule is allowed,
        // proving the fold happens rather than everything mapped being denied.
        assert!(
            check_target(&p, sa("[::ffff:10.1.2.3]:80")).is_ok(),
            "a mapped address inside the rule must be recognised as that address",
        );
    }

    #[test]
    fn prefix_boundaries_are_exact() {
        // An off-by-one in the mask is the classic allowlist bug: /24 that
        // behaves as /16 quietly grants 255 extra subnets.
        let p = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::new(192, 168, 1, 0)),
            prefix: 24,
            ports: Vec::new(),
        }]);
        assert!(check_target(&p, sa("192.168.1.0:80")).is_ok());
        assert!(check_target(&p, sa("192.168.1.255:80")).is_ok());
        assert!(check_target(&p, sa("192.168.2.0:80")).is_err(), "/24 must not reach .2.x");
        assert!(check_target(&p, sa("192.168.0.255:80")).is_err(), "/24 must not reach .0.x");

        // A non-byte-aligned prefix exercises the partial-byte mask.
        let p20 = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::new(10, 16, 0, 0)),
            prefix: 20,
            ports: Vec::new(),
        }]);
        assert!(check_target(&p20, sa("10.16.0.1:80")).is_ok());
        assert!(check_target(&p20, sa("10.16.15.255:80")).is_ok(), "top of a /20");
        assert!(check_target(&p20, sa("10.16.16.0:80")).is_err(), "first address past a /20");
    }

    #[test]
    fn a_port_restricted_rule_refuses_other_ports() {
        let p = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::LOCALHOST),
            prefix: 32,
            ports: vec![3389],
        }]);
        assert!(check_target(&p, sa("127.0.0.1:3389")).is_ok());
        assert!(
            check_target(&p, sa("127.0.0.1:22")).is_err(),
            "a rule pinned to RDP must not also grant SSH",
        );
    }

    #[test]
    fn an_elevated_host_refuses_until_separately_armed() {
        // A pivot from a SYSTEM process is categorically worse than one from a
        // user session, so enabling tunnelling must not be enough on its own.
        let mut p = TunnelPolicy {
            enabled: true,
            elevated_host: true,
            ..Default::default()
        };
        assert_eq!(
            check_target(&p, sa("127.0.0.1:3389")),
            Err(TunnelDenied::ElevatedNotArmed),
            "even a loopback target is refused on an unarmed elevated host",
        );
        p.armed_for_elevated = true;
        assert!(check_target(&p, sa("127.0.0.1:3389")).is_ok());
        // Arming must not widen the allowlist.
        assert!(check_target(&p, sa("192.168.1.10:445")).is_err());
    }

    #[test]
    fn unroutable_destinations_are_refused_even_when_allowlisted() {
        // A wildcard rule is a user's own foot-gun, but it must still not
        // produce a connection to a broadcast or multicast address — one
        // request would become traffic to every host on the segment.
        let wildcard = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            prefix: 0,
            ports: Vec::new(),
        }]);
        assert!(check_target(&wildcard, sa("1.2.3.4:80")).is_ok(), "the wildcard does allow");

        for bad in ["0.0.0.0:80", "255.255.255.255:80", "224.0.0.1:80"] {
            match check_target(&wildcard, sa(bad)) {
                Err(TunnelDenied::Unroutable(_)) => {}
                other => panic!("{bad} should be unroutable, got {other:?}"),
            }
        }
        match check_target(&wildcard, sa("127.0.0.1:0")) {
            Err(TunnelDenied::Unroutable(_)) => {}
            other => panic!("port 0 should be unroutable, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_allowlist_allows_nothing_even_when_enabled() {
        let p = enabled(Vec::new());
        assert!(check_target(&p, sa("127.0.0.1:3389")).is_err());
        assert!(check_target(&p, sa("[::1]:3389")).is_err());
    }

    #[test]
    fn a_rule_is_not_matched_across_address_families() {
        // An IPv6 rule must not be read as covering IPv4 or vice versa; a
        // family confusion here is an allow where the user wrote a deny.
        let v6only = enabled(vec![TargetRule {
            base: IpAddr::V6(Ipv6Addr::LOCALHOST),
            prefix: 128,
            ports: Vec::new(),
        }]);
        assert!(check_target(&v6only, sa("[::1]:80")).is_ok());
        assert!(
            check_target(&v6only, sa("127.0.0.1:80")).is_err(),
            "an ::1 rule must not grant 127.0.0.1",
        );
    }

    #[test]
    fn policy_round_trips_through_json() {
        // The policy is persisted per device; a serde change that silently
        // drops `allowed` would re-open the machine on the next load.
        let p = TunnelPolicy {
            enabled: true,
            allowed: vec![TargetRule::host(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)))],
            elevated_host: true,
            armed_for_elevated: true,
        };
        let back: TunnelPolicy =
            serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back.allowed, p.allowed);
        assert!(back.enabled && back.elevated_host && back.armed_for_elevated);
        assert!(check_target(&back, sa("10.0.0.5:22")).is_ok());
        assert!(check_target(&back, sa("10.0.0.6:22")).is_err());
    }

    #[test]
    fn a_missing_enabled_field_deserializes_as_off() {
        // Old stored policies, and hand-written ones, must fail CLOSED.
        let p: TunnelPolicy = serde_json::from_str("{}").unwrap();
        assert!(!p.enabled);
        assert!(p.allowed.is_empty(), "no allowlist means no targets, not the default list");
        assert_eq!(check_target(&p, sa("127.0.0.1:3389")), Err(TunnelDenied::Disabled));
    }

    #[test]
    fn a_disabled_policy_refuses_before_resolving_anything() {
        // A refused request must not become an observable DNS lookup: that
        // would leak which hosts a controller is probing for, from the host's
        // own resolver, before any authorization succeeded.
        let p = TunnelPolicy::default();
        assert_eq!(
            resolve_target("localhost", 3389, &p),
            Err(TunnelDenied::Disabled),
        );
    }

    #[test]
    fn resolve_returns_the_permitted_address_not_merely_the_first() {
        // localhost commonly resolves to BOTH ::1 and 127.0.0.1. With only the
        // IPv4 loopback allowed, resolution must pick that one rather than
        // failing on whichever the resolver happened to list first.
        let p = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::new(127, 0, 0, 0)),
            prefix: 8,
            ports: Vec::new(),
        }]);
        let got = resolve_target("localhost", 3389, &p).expect("localhost must resolve");
        assert!(got.ip().is_ipv4(), "expected the permitted v4 address, got {got}");
        assert_eq!(got.port(), 3389);
    }

    #[test]
    fn resolve_refuses_a_literal_outside_the_allowlist() {
        // An IP literal still goes through resolution, so this proves the gate
        // is applied on that path too and not only on the name path.
        let p = enabled(vec![TargetRule::host(IpAddr::V4(Ipv4Addr::LOCALHOST))]);
        assert!(resolve_target("127.0.0.1", 3389, &p).is_ok());
        match resolve_target("192.168.1.10", 3389, &p) {
            Err(TunnelDenied::NotAllowed(_)) => {}
            other => panic!("expected NotAllowed, got {other:?}"),
        }
    }

    #[test]
    fn resolve_normalizes_a_mapped_address_before_returning_it() {
        // The caller connects to exactly what is returned, so a v4-mapped form
        // must be folded here too -- otherwise the address that was CHECKED and
        // the address that gets DIALLED differ in representation, which is how
        // a checked-then-changed bug creeps back in.
        let p = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::new(127, 0, 0, 0)),
            prefix: 8,
            ports: Vec::new(),
        }]);
        let got = resolve_target("::ffff:127.0.0.1", 22, &p).expect("mapped loopback");
        assert_eq!(got.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST), "must be folded to plain v4");
    }

    #[test]
    fn an_unresolvable_name_is_an_unroutable_error_not_a_silent_allow() {
        let p = enabled(vec![TargetRule {
            base: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            prefix: 0,
            ports: Vec::new(),
        }]);
        match resolve_target("no-such-host.invalid", 80, &p) {
            Err(TunnelDenied::Unroutable(_)) => {}
            other => panic!("expected Unroutable, got {other:?}"),
        }
    }
}

/// The multiplexing wire format that rides ONE `'tunnel'` data channel.
///
/// A single tunnel session carries many independent forwarded TCP connections at
/// once — open three RDP windows and there are three. Rather than a data channel
/// per connection (which multiplies negotiation and teardown), every byte is
/// tagged with a `stream` id and rides the one channel. This module is only the
/// framing; the sockets and the pump live above it. Kept pure so the parser can
/// be fuzzed by unit tests against exactly the malformed input a remote peer can
/// send — the frame decoder is attacker-facing.
///
/// One data-channel MESSAGE is one frame. SCTP preserves message boundaries, so
/// a `Data` frame needs no length prefix on its payload: the message end IS the
/// payload end. The sender chunks payloads larger than the channel's max message
/// size into several `Data` frames before they reach here.
pub mod frame {
    /// One framed message. `stream` identifies which forwarded connection it
    /// belongs to; ids are chosen by the controller (the side that accepts the
    /// local socket) and are unique for the life of the tunnel session.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum TunnelFrame {
        /// Controller -> host: open a connection to `host:port` for `stream`.
        /// `host` is a name or IP literal; the host resolves and POLICY-CHECKS it
        /// (see `resolve_target`) before dialling — the id being valid is not
        /// authority to connect anywhere.
        Open { stream: u32, host: String, port: u16 },
        /// Host -> controller: the dial for `stream` succeeded, or failed with a
        /// reason. Until this arrives the controller holds the local socket open
        /// but sends nothing it cannot take back.
        OpenResult { stream: u32, ok: bool, error: String },
        /// Either direction: payload bytes for `stream`.
        Data { stream: u32, payload: Vec<u8> },
        /// Either direction: `stream` is finished (EOF or reset). Idempotent — a
        /// second Close for a stream already gone is ignored by the pump.
        Close { stream: u32 },
    }

    const TAG_OPEN: u8 = 1;
    const TAG_OPEN_RESULT: u8 = 2;
    const TAG_DATA: u8 = 3;
    const TAG_CLOSE: u8 = 4;

    /// Largest `host`/`error` string we will emit or accept. A name longer than
    /// this is not a real DNS name; capping it stops a peer describing a 4 GiB
    /// "hostname" that must be buffered before it can be rejected.
    const MAX_STR: usize = 255;

    impl TunnelFrame {
        /// Serialise to a single data-channel message.
        pub fn encode(&self) -> Vec<u8> {
            let mut out = Vec::new();
            match self {
                TunnelFrame::Open { stream, host, port } => {
                    out.push(TAG_OPEN);
                    out.extend_from_slice(&stream.to_le_bytes());
                    out.extend_from_slice(&port.to_le_bytes());
                    // host len as u16 — MAX_STR fits, and the decoder rejects more.
                    out.extend_from_slice(&(host.len() as u16).to_le_bytes());
                    out.extend_from_slice(host.as_bytes());
                }
                TunnelFrame::OpenResult { stream, ok, error } => {
                    out.push(TAG_OPEN_RESULT);
                    out.extend_from_slice(&stream.to_le_bytes());
                    out.push(if *ok { 1 } else { 0 });
                    out.extend_from_slice(&(error.len() as u16).to_le_bytes());
                    out.extend_from_slice(error.as_bytes());
                }
                TunnelFrame::Data { stream, payload } => {
                    out.push(TAG_DATA);
                    out.extend_from_slice(&stream.to_le_bytes());
                    // No length: the rest of the message IS the payload.
                    out.extend_from_slice(payload);
                }
                TunnelFrame::Close { stream } => {
                    out.push(TAG_CLOSE);
                    out.extend_from_slice(&stream.to_le_bytes());
                }
            }
            out
        }

        /// Parse one data-channel message. Every malformed input is an `Err`, not
        /// a panic: this runs on bytes a remote peer chose.
        pub fn decode(buf: &[u8]) -> Result<TunnelFrame, FrameError> {
            let (&tag, rest) = buf.split_first().ok_or(FrameError::Empty)?;
            let stream = take_u32(rest).ok_or(FrameError::Truncated)?;
            let after_stream = &rest[4..];
            match tag {
                TAG_OPEN => {
                    let port = take_u16(after_stream).ok_or(FrameError::Truncated)?;
                    let after_port = &after_stream[2..];
                    let host_len = take_u16(after_port).ok_or(FrameError::Truncated)? as usize;
                    let host_bytes = &after_port[2..];
                    if host_len > MAX_STR {
                        return Err(FrameError::StringTooLong);
                    }
                    if host_bytes.len() != host_len {
                        // EXACT, not >=: trailing bytes after the declared host
                        // mean a confused/hostile frame, not extra data to ignore.
                        return Err(FrameError::LengthMismatch);
                    }
                    let host = std::str::from_utf8(host_bytes)
                        .map_err(|_| FrameError::NotUtf8)?
                        .to_string();
                    Ok(TunnelFrame::Open { stream, host, port })
                }
                TAG_OPEN_RESULT => {
                    let &ok_byte = after_stream.first().ok_or(FrameError::Truncated)?;
                    let after_ok = &after_stream[1..];
                    let err_len = take_u16(after_ok).ok_or(FrameError::Truncated)? as usize;
                    let err_bytes = &after_ok[2..];
                    if err_len > MAX_STR {
                        return Err(FrameError::StringTooLong);
                    }
                    if err_bytes.len() != err_len {
                        return Err(FrameError::LengthMismatch);
                    }
                    let error = std::str::from_utf8(err_bytes)
                        .map_err(|_| FrameError::NotUtf8)?
                        .to_string();
                    Ok(TunnelFrame::OpenResult { stream, ok: ok_byte != 0, error })
                }
                TAG_DATA => Ok(TunnelFrame::Data { stream, payload: after_stream.to_vec() }),
                TAG_CLOSE => {
                    if !after_stream.is_empty() {
                        return Err(FrameError::LengthMismatch);
                    }
                    Ok(TunnelFrame::Close { stream })
                }
                other => Err(FrameError::UnknownTag(other)),
            }
        }
    }

    /// Why a frame could not be parsed.
    #[derive(Debug, PartialEq, Eq)]
    pub enum FrameError {
        Empty,
        Truncated,
        UnknownTag(u8),
        StringTooLong,
        LengthMismatch,
        NotUtf8,
    }

    fn take_u16(b: &[u8]) -> Option<u16> {
        b.get(..2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }

    fn take_u32(b: &[u8]) -> Option<u32> {
        b.get(..4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn roundtrip(f: TunnelFrame) {
            let bytes = f.encode();
            assert_eq!(TunnelFrame::decode(&bytes), Ok(f), "round-trip must be lossless");
        }

        #[test]
        fn every_frame_kind_round_trips() {
            roundtrip(TunnelFrame::Open { stream: 1, host: "192.168.1.10".into(), port: 3389 });
            roundtrip(TunnelFrame::Open { stream: 7, host: "localhost".into(), port: 22 });
            roundtrip(TunnelFrame::OpenResult { stream: 1, ok: true, error: String::new() });
            roundtrip(TunnelFrame::OpenResult {
                stream: 2,
                ok: false,
                error: "connection refused".into(),
            });
            roundtrip(TunnelFrame::Data { stream: 9, payload: vec![0, 1, 2, 253, 254, 255] });
            roundtrip(TunnelFrame::Close { stream: 42 });
        }

        #[test]
        fn an_empty_data_payload_round_trips() {
            // A zero-length Data frame is legal (a flush marker); it must not be
            // confused with a Close or mis-parsed as truncated.
            roundtrip(TunnelFrame::Data { stream: 3, payload: Vec::new() });
        }

        #[test]
        fn data_uses_the_whole_message_as_payload() {
            // No length prefix on Data: a payload that happens to start with
            // another frame's tag byte must still be treated as opaque bytes.
            let f = TunnelFrame::Data { stream: 5, payload: vec![TAG_OPEN, TAG_CLOSE, 0xFF] };
            roundtrip(f);
        }

        #[test]
        fn a_truncated_stream_id_is_an_error_not_a_panic() {
            // Tag present, fewer than 4 bytes of stream id.
            assert_eq!(TunnelFrame::decode(&[TAG_DATA, 0, 0]), Err(FrameError::Truncated));
            assert_eq!(TunnelFrame::decode(&[]), Err(FrameError::Empty));
        }

        #[test]
        fn an_unknown_tag_is_refused() {
            let mut bytes = TunnelFrame::Close { stream: 1 }.encode();
            bytes[0] = 99;
            assert_eq!(TunnelFrame::decode(&bytes), Err(FrameError::UnknownTag(99)));
        }

        #[test]
        fn a_host_longer_than_declared_is_a_length_mismatch() {
            // Declared host len 4 but 6 bytes follow: a confused or hostile frame.
            let mut bytes = vec![TAG_OPEN];
            bytes.extend_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&3389u16.to_le_bytes());
            bytes.extend_from_slice(&4u16.to_le_bytes());
            bytes.extend_from_slice(b"abcdef");
            assert_eq!(TunnelFrame::decode(&bytes), Err(FrameError::LengthMismatch));
        }

        #[test]
        fn a_host_shorter_than_declared_is_a_length_mismatch() {
            // Declared host len 10 but only 3 bytes follow. The exact-length check
            // rejects it as a mismatch -- the same verdict as too-long, since both
            // mean the frame's own length field disagrees with its body.
            let mut bytes = vec![TAG_OPEN];
            bytes.extend_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&3389u16.to_le_bytes());
            bytes.extend_from_slice(&10u16.to_le_bytes());
            bytes.extend_from_slice(b"abc");
            assert_eq!(TunnelFrame::decode(&bytes), Err(FrameError::LengthMismatch));
        }

        #[test]
        fn a_close_with_trailing_bytes_is_rejected() {
            // Close is exactly tag+stream; trailing bytes signal a framing bug or
            // an attempt to smuggle data past the pump.
            let mut bytes = TunnelFrame::Close { stream: 1 }.encode();
            bytes.push(0);
            assert_eq!(TunnelFrame::decode(&bytes), Err(FrameError::LengthMismatch));
        }

        #[test]
        fn a_non_utf8_host_is_refused() {
            let mut bytes = vec![TAG_OPEN];
            bytes.extend_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&80u16.to_le_bytes());
            bytes.extend_from_slice(&2u16.to_le_bytes());
            bytes.extend_from_slice(&[0xFF, 0xFE]);
            assert_eq!(TunnelFrame::decode(&bytes), Err(FrameError::NotUtf8));
        }

        #[test]
        fn an_over_long_host_is_refused_without_allocating_it() {
            // Declares a 300-byte host but supplies none: the cap must trip on the
            // DECLARED length, before trying to read 300 bytes that are not there.
            let mut bytes = vec![TAG_OPEN];
            bytes.extend_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&80u16.to_le_bytes());
            bytes.extend_from_slice(&300u16.to_le_bytes());
            assert_eq!(TunnelFrame::decode(&bytes), Err(FrameError::StringTooLong));
        }
    }
}
