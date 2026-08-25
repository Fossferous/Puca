//! Wake-on-LAN magic packets.
//!
//! A magic packet is a LAN BROADCAST, and a machine that is off has no
//! WebSocket connection — so this can only ever be sent by a DIFFERENT device
//! that is awake on the same subnet. That constraint is the feature's real
//! shape, not an implementation detail: without a second always-on device on
//! the same network there is nothing that can wake anything, and the UI has to
//! say so rather than offering a button that silently does nothing.
//!
//! What this cannot do, and what the UI must not imply it can:
//!   * cross subnets — a broadcast does not route;
//!   * work over Wi-Fi in most cases — WoWLAN is rarely enabled;
//!   * survive Windows Fast Startup, which frequently leaves the NIC unable to
//!     wake the machine.

//! WHY THIS LIVES IN THE SERVICE CRATE. It began in the Tauri app, which was
//! the only Windows thing that ever needed it. The SYSTEM service now needs it
//! too — it is online as its own device whenever the console is locked, so
//! `planWake` can and does choose it as the broadcaster, and a chosen device
//! with no responder is the exact bug `wake.ts:44-52` documents: a button that
//! reports success and wakes nothing. Copying the file would have made three
//! implementations of one wire format on two platforms, so the pure half moved
//! here and the app kept only its adapter discovery.
//!
//! `send_from` takes its addresses rather than discovering them, which is what
//! made the move possible: adapter enumeration is `crate::lan` in the app and
//! config in the waker, and neither belongs in the packet code.

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

/// Parse `AA:BB:CC:DD:EE:FF` (or `-`/`.`-separated, or bare hex) into 6 bytes.
pub(crate) fn parse_mac(mac: &str) -> Result<[u8; 6], String> {
    let cleaned: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if cleaned.len() != 12 {
        return Err("a MAC address must be 6 hex bytes".to_string());
    }
    let mut out = [0u8; 6];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&cleaned[i * 2..i * 2 + 2], 16)
            .map_err(|_| "invalid hex in MAC address".to_string())?;
    }
    Ok(out)
}

/// 6 bytes of 0xFF followed by the target MAC repeated 16 times.
pub(crate) fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(102);
    packet.extend_from_slice(&[0xFF; 6]);
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    packet
}

/// May this address be used as a wake destination?
///
/// The destination arrives from the SERVER, in a `DeviceWakeRequested` relay
/// that the responder acts on without asking anyone. Before this check any
/// parseable IPv4 was accepted, which handed the server an unauthenticated
/// "send UDP to an address of my choosing" primitive on every online desktop —
/// aimed anywhere on the internet, or at anything inside the user's LAN that
/// the server could never otherwise reach.
///
/// Waking a machine is inherently a LAN operation: the magic packet has to be
/// on the target's own broadcast domain to do anything. So restricting this to
/// private space costs nothing real and removes the primitive.
///
/// Link-local (169.254/16) is NOT allowed despite being "local": it contains
/// the cloud instance-metadata address 169.254.169.254, and a wake packet has
/// no business there.
pub(crate) fn is_local_wake_target(addr: Ipv4Addr) -> bool {
    !addr.is_loopback()
        && !addr.is_multicast()
        && !addr.is_link_local()
        && !addr.is_unspecified()
        && addr.is_private()
}

/// Where to aim, most-specific first.
///
/// `local_bcast` is THIS machine's own subnet-directed broadcast, derived from
/// the physical adapter (`lan::collect`). It is deliberately NOT passed through
/// `is_local_wake_target`: that gate exists to stop the SERVER naming an
/// arbitrary destination, and this address is self-derived. The collector is
/// what bounds it instead — a private IPv4 with a prefix no wider than /8 —
/// which is why a hostile DHCP lease cannot turn this into a public target.
///
/// `requested` is the server-relayed address and stays gated.
///
/// The limited broadcast comes LAST and is the least reliable of the three: it
/// is not routed, and on a machine with a full-tunnel VPN it follows the
/// routing table into the tunnel. It is kept because a stale `local_bcast`
/// (laptop moved networks since it last recorded) would otherwise leave nothing.
pub(crate) fn wake_targets(local_bcast: Option<Ipv4Addr>, requested: Option<&str>) -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = Vec::with_capacity(3);
    let mut push = |addr: Ipv4Addr| {
        if !out.contains(&addr) {
            out.push(addr);
        }
    };
    if let Some(b) = local_bcast {
        push(b);
    }
    if let Some(addr) = requested.and_then(|b| b.parse::<Ipv4Addr>().ok()) {
        if is_local_wake_target(addr) {
            push(addr);
        }
    }
    push(Ipv4Addr::BROADCAST);
    out
}

/// Broadcast a magic packet for `mac`, from a caller-supplied adapter address.
///
/// Sent to this machine's own subnet broadcast, the server-supplied one, and
/// 255.255.255.255 — because which one works depends on the network: some
/// routers drop the global broadcast, and a subnet-directed address is wrong if
/// the sender's view of the subnet is stale. Ports 9 and 7 are both attempted
/// for the same reason — NICs differ, and a packet that is ignored costs
/// nothing.
///
/// THE SOCKET IS BOUND TO THE PHYSICAL ADAPTER'S OWN IPv4, never 0.0.0.0. An
/// unbound socket lets the routing table choose the source interface, and on
/// any machine running a full-tunnel VPN that choice is the tunnel — a device
/// with no broadcast domain and no NIC behind it. Every packet this function
/// sent on such a machine went into the tunnel and vanished, with `sent`
/// cheerfully reporting 4. Binding pins the send to the card that is actually
/// on the target's LAN.
///
/// The returned count is how many datagrams the OS accepted. It is NOT a health
/// signal: `send_to` on a bound, broadcast-enabled socket essentially never
/// fails synchronously, so 4 is the normal result even when nothing on the
/// network could possibly wake. Only the target reconnecting proves anything,
/// which is why the caller waits for it rather than treating this as "done".
pub fn send_from(
    bind_ip: Ipv4Addr,
    local_bcast: Option<Ipv4Addr>,
    mac: &str,
    broadcast: Option<&str>,
) -> Result<u32, String> {
    let parsed = parse_mac(mac)?;
    let packet = magic_packet(parsed);

    let socket = UdpSocket::bind(SocketAddrV4::new(bind_ip, 0))
        .map_err(|e| format!("cannot open a UDP socket: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("cannot enable broadcast: {e}"))?;

    let mut sent = 0;
    for addr in wake_targets(local_bcast, broadcast) {
        for port in [9u16, 7u16] {
            if socket.send_to(&packet, SocketAddrV4::new(addr, port)).is_ok() {
                sent += 1;
            }
        }
    }
    if sent == 0 {
        return Err("could not send the wake packet on this network".to_string());
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_wake_targets_outside_the_lan() {
        // The exact primitive this closes: the server naming any host it likes.
        assert!(!is_local_wake_target("8.8.8.8".parse().unwrap()));
        assert!(!is_local_wake_target("1.2.3.4".parse().unwrap()));
        // Cloud instance metadata — link-local, and the reason link-local is out.
        assert!(!is_local_wake_target("169.254.169.254".parse().unwrap()));
        assert!(!is_local_wake_target("127.0.0.1".parse().unwrap()));
        assert!(!is_local_wake_target("224.0.0.1".parse().unwrap()));
        assert!(!is_local_wake_target("0.0.0.0".parse().unwrap()));
    }

    #[test]
    fn allows_the_lan_broadcasts_that_actually_wake_machines() {
        // These must keep working, or the feature is broken rather than secured.
        assert!(is_local_wake_target("192.168.0.255".parse().unwrap()));
        assert!(is_local_wake_target("192.168.1.42".parse().unwrap()));
        assert!(is_local_wake_target("10.0.0.255".parse().unwrap()));
        assert!(is_local_wake_target("172.16.5.255".parse().unwrap()));
    }

    #[test]
    fn the_local_broadcast_is_tried_first_and_is_not_subject_to_the_server_gate() {
        // Most-specific first: the card's own subnet broadcast is the one that
        // actually reaches the target's segment.
        let local: Ipv4Addr = "192.168.0.255".parse().unwrap();
        let t = wake_targets(Some(local), Some("192.168.0.255"));
        assert_eq!(t[0], local);
        assert_eq!(t.len(), 2, "the duplicate request must not be sent twice: {t:?}");
        assert_eq!(t[1], Ipv4Addr::BROADCAST);

        // The two sources are gated differently, and that asymmetry is the
        // point: a self-derived address is trusted (the collector bounds it),
        // the server's is not. 172.16/12 is private so it passes both; the
        // contrast that matters is tested in the next case.
        let other: Ipv4Addr = "172.16.4.255".parse().unwrap();
        assert!(wake_targets(Some(other), None).contains(&other));
    }

    #[test]
    fn a_server_supplied_target_outside_the_lan_is_still_refused() {
        // The whole point of is_local_wake_target: the relay must never become
        // "make this desktop send UDP to an address of my choosing".
        let t = wake_targets(Some("192.168.0.255".parse().unwrap()), Some("8.8.8.8"));
        assert!(!t.iter().any(|a| a.to_string() == "8.8.8.8"));
    }

    #[test]
    fn there_is_always_something_to_send_to() {
        // A machine with no recorded adapter (collect() returned None) must
        // still fall back to the limited broadcast rather than sending nothing.
        assert_eq!(wake_targets(None, None), vec![Ipv4Addr::BROADCAST]);
    }

    #[test]
    fn parses_the_usual_separators() {
        let want = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];
        assert_eq!(parse_mac("AA:BB:CC:DD:EE:FF").unwrap(), want);
        assert_eq!(parse_mac("aa-bb-cc-dd-ee-ff").unwrap(), want);
        assert_eq!(parse_mac("aabb.ccdd.eeff").unwrap(), want);
        assert_eq!(parse_mac("AABBCCDDEEFF").unwrap(), want);
    }

    #[test]
    fn rejects_anything_that_is_not_six_bytes() {
        // A short MAC silently zero-padded would produce a packet that wakes
        // nothing, with no error to explain why.
        assert!(parse_mac("AA:BB:CC").is_err());
        assert!(parse_mac("AA:BB:CC:DD:EE:FF:00").is_err());
        assert!(parse_mac("").is_err());
        assert!(parse_mac("ZZ:BB:CC:DD:EE:FF").is_err());
    }

    /// The wire format is fixed and unforgiving: 6 × 0xFF then the MAC 16 times,
    /// 102 bytes total. A NIC that does not see exactly this ignores it, and the
    /// failure is invisible — the machine simply never wakes.
    #[test]
    fn magic_packet_has_the_exact_documented_shape() {
        let mac = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
        let p = magic_packet(mac);
        assert_eq!(p.len(), 102, "6 sync bytes + 16 * 6 MAC bytes");
        assert_eq!(&p[..6], &[0xFF; 6]);
        for i in 0..16 {
            let at = 6 + i * 6;
            assert_eq!(&p[at..at + 6], &mac, "repetition {i} must be the MAC");
        }
    }
}
