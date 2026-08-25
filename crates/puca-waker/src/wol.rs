//! Put a magic packet on the wire.
//!
//! A faithful port of `frontend/src-tauri/src/wol.rs`, which is the shipped and
//! reviewed implementation. Ported rather than shared because that file lives
//! inside the Tauri crate and dragging Tauri onto a headless container to reuse
//! sixty lines would be the larger change — but every rule below is that file's
//! rule, and the tests pin the same properties.
//!
//! THE ASYMMETRY THAT MATTERS. The destination in a `DeviceWakeRequested`
//! arrives from the SERVER, and this process acts on it without asking anyone.
//! Accepting any parseable IPv4 would hand the server an unauthenticated "send
//! UDP to an address of my choosing" primitive — aimed anywhere on the internet,
//! or at anything inside the LAN the server could never otherwise reach. Waking
//! is inherently a LAN operation, so restricting the target to private space
//! costs nothing real and removes the primitive entirely.

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

/// Parse `AA:BB:CC:DD:EE:FF` (or `-`/`.`-separated, or bare hex) into 6 bytes.
pub fn parse_mac(mac: &str) -> Result<[u8; 6], String> {
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
pub fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(102);
    packet.extend_from_slice(&[0xFF; 6]);
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    packet
}

/// May this server-supplied address be used as a wake destination?
///
/// Link-local (169.254/16) is NOT allowed despite being "local": it contains
/// the cloud instance-metadata address 169.254.169.254, and a wake packet has
/// no business there.
pub fn is_local_wake_target(addr: Ipv4Addr) -> bool {
    !addr.is_loopback()
        && !addr.is_multicast()
        && !addr.is_link_local()
        && !addr.is_unspecified()
        && addr.is_private()
}

/// Send the packet, returning the destinations it actually reached.
///
/// Bound to `bind_ip` — this box's real LAN address — rather than `0.0.0.0`.
/// That is not a detail: binding to the unspecified address makes the kernel
/// choose a source by the routing table, and on any machine carrying a VPN the
/// default route is the tunnel, so every packet is posted into it and nothing
/// on the LAN ever hears it. That exact bug shipped once in `wol.rs`.
///
/// Ports 9 and 7 both, because firmware disagrees about which it listens on and
/// the packet is 102 bytes.
pub fn send(bind_ip: Ipv4Addr, local_bcast: Ipv4Addr, mac: &str, requested: Option<&str>) -> Result<Vec<String>, String> {
    let parsed = parse_mac(mac)?;
    let packet = magic_packet(parsed);

    let socket = UdpSocket::bind(SocketAddrV4::new(bind_ip, 0))
        .map_err(|e| format!("could not open a UDP socket on {bind_ip}: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("could not enable broadcast: {e}"))?;

    let mut sent = Vec::new();
    for target in wake_targets(local_bcast, requested) {
        let mut ok = false;
        for port in [9u16, 7u16] {
            if socket.send_to(&packet, SocketAddrV4::new(target, port)).is_ok() {
                ok = true;
            }
        }
        if ok {
            sent.push(target.to_string());
        }
    }
    if sent.is_empty() {
        return Err("every wake destination was refused by the socket".into());
    }
    Ok(sent)
}

/// Where to aim, most-specific first, de-duplicated.
///
/// `local_bcast` is THIS machine's own subnet-directed broadcast and is
/// deliberately NOT passed through [`is_local_wake_target`]: that gate exists to
/// stop the SERVER naming a destination, and this one is derived locally.
///
/// The limited broadcast comes LAST and is the least reliable of the three: it
/// is not routed, and on a host with a full-tunnel VPN it follows the routing
/// table into the tunnel. It is kept for the same reason the two Windows copies
/// keep it (`puca-service/src/wol.rs`) — a `local_bcast` that has gone
/// stale, because this box was renumbered or its config was written for a
/// different subnet, would otherwise leave NOTHING to try. This binary is
/// typically the only always-on machine on the wire, so "nothing to try" means
/// the Wake button cannot work at all, from anywhere.
pub fn wake_targets(local_bcast: Ipv4Addr, requested: Option<&str>) -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = Vec::with_capacity(3);
    let mut push = |addr: Ipv4Addr| {
        if !out.contains(&addr) {
            out.push(addr);
        }
    };
    push(local_bcast);
    if let Some(addr) = requested.and_then(|r| r.parse::<Ipv4Addr>().ok()) {
        if is_local_wake_target(addr) {
            push(addr);
        }
    }
    push(Ipv4Addr::BROADCAST);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_packet_is_exactly_what_firmware_looks_for() {
        let mac = parse_mac("10:7c:61:46:69:bd").expect("valid MAC");
        let p = magic_packet(mac);
        assert_eq!(p.len(), 102, "6 sync bytes + the MAC 16 times");
        assert_eq!(&p[..6], &[0xFF; 6], "the sync stream");
        for i in 0..16 {
            assert_eq!(&p[6 + i * 6..12 + i * 6], &mac, "repetition {i}");
        }
    }

    #[test]
    fn macs_are_accepted_in_every_form_a_human_writes_them() {
        let want = [0x10, 0x7c, 0x61, 0x46, 0x69, 0xbd];
        for form in ["10:7c:61:46:69:bd", "10-7C-61-46-69-BD", "107c614669bd", "107c.6146.69bd"] {
            assert_eq!(parse_mac(form).expect(form), want, "{form}");
        }
        assert!(parse_mac("10:7c:61:46:69").is_err(), "too short");
        assert!(parse_mac("").is_err());
        assert!(parse_mac("zz:zz:zz:zz:zz:zz").is_err());
    }

    #[test]
    fn a_server_supplied_destination_cannot_leave_the_lan() {
        // The whole point of the gate. Each of these was reachable before it
        // existed, which made every online desktop a UDP cannon the server
        // could aim.
        for bad in ["8.8.8.8", "1.1.1.1", "127.0.0.1", "224.0.0.1", "0.0.0.0", "169.254.169.254"] {
            assert!(
                !is_local_wake_target(bad.parse().unwrap()),
                "{bad} must be refused"
            );
        }
        // 169.254.169.254 is the cloud metadata endpoint and is the reason
        // link-local is excluded despite the name.
    }

    #[test]
    fn ordinary_lan_addresses_are_still_allowed() {
        // The positive control. A gate that refused everything would pass the
        // test above while making the feature impossible.
        for good in ["192.168.0.255", "192.168.1.10", "10.0.0.255", "172.16.5.255"] {
            assert!(is_local_wake_target(good.parse().unwrap()), "{good} must be allowed");
        }
    }

    #[test]
    fn the_local_broadcast_is_always_tried_and_never_duplicated() {
        let local: Ipv4Addr = "192.168.0.255".parse().unwrap();
        let all = Ipv4Addr::BROADCAST;

        // No request: still aim at our own subnet, then the limited broadcast.
        assert_eq!(wake_targets(local, None), vec![local, all]);

        // A public request is dropped, but ours still fires — a hostile
        // destination must not cost us the legitimate one.
        assert_eq!(wake_targets(local, Some("8.8.8.8")), vec![local, all]);

        // A different private subnet is added after ours.
        let other: Ipv4Addr = "10.0.0.255".parse().unwrap();
        assert_eq!(wake_targets(local, Some("10.0.0.255")), vec![local, other, all]);

        // Asking for exactly our own broadcast must not send it twice.
        assert_eq!(wake_targets(local, Some("192.168.0.255")), vec![local, all]);

        // Garbage is ignored rather than fatal.
        assert_eq!(wake_targets(local, Some("not-an-address")), vec![local, all]);
    }

    #[test]
    fn a_stale_configured_broadcast_still_leaves_something_to_try() {
        // THE FALLBACK THIS CRATE WAS MISSING while both Windows copies had it.
        // `local_bcast` comes from a config file written when the waker was
        // provisioned; if this box is renumbered, or that file was written for
        // the wrong subnet, every packet goes to an address nothing listens on.
        // The limited broadcast is the last resort — and on the only always-on
        // machine on the wire, "no last resort" means the Wake button cannot
        // work from anywhere.
        let stale: Ipv4Addr = "10.9.9.255".parse().unwrap();
        let targets = wake_targets(stale, None);
        assert!(
            targets.contains(&Ipv4Addr::BROADCAST),
            "255.255.255.255 must remain as a last resort: {targets:?}"
        );
        assert_eq!(targets[0], stale, "the specific address is still tried first");
    }

    #[test]
    fn the_limited_broadcast_is_not_sent_twice_when_it_is_also_the_local_one() {
        // Degenerate but reachable: a config naming 255.255.255.255 directly.
        assert_eq!(
            wake_targets(Ipv4Addr::BROADCAST, Some("255.255.255.255")),
            vec![Ipv4Addr::BROADCAST]
        );
    }
}
