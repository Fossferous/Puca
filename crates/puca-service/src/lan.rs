//! Which network card will still be listening for a magic packet after this
//! machine powers off.
//!
//! This is deliberately NOT "the interface with the default route". On a
//! machine running a full-tunnel VPN the default route is the tunnel — a
//! virtual device with no MAC and no broadcast domain. Both of the obvious
//! shortcuts return it (`UdpSocket::connect("8.8.8.8:53")` then `local_addr()`,
//! and `GetBestRoute2` toward `0.0.0.0`), and both are wrong for this purpose.
//!
//! "What will wake this machine" is a HARDWARE question, so it is answered from
//! the adapter's own driver-reported properties: a real Ethernet or Wi-Fi
//! interface, operationally up, with a 6-byte MAC and a private IPv4. The
//! result is ranked so a wired card with a gateway wins over a virtual bridge
//! that happens to satisfy the same predicates.
//!
//! Everything here is best-effort and observable: the chosen interface's
//! friendly name is returned so the UI can show WHICH card was recorded. A
//! wrong guess is then a visible wrong name rather than a silent failure to
//! wake months later.

//! WHY THIS LIVES IN THE SERVICE CRATE. It moved with `wol`, which is its only
//! consumer: the SYSTEM service answers wake requests while the console is
//! locked, and a magic packet MUST be sent from the physical adapter's own IPv4
//! — binding 0.0.0.0 lets the routing table pick, and on a machine with a
//! full-tunnel VPN that pick is the tunnel, where every packet vanishes while
//! the send count cheerfully reports success. Adapter discovery is therefore not
//! a nicety the service could skip.
//!
//! It asks a HARDWARE question (adapter flags, gateway presence), never a
//! routing one, for that same reason.

/// This machine's LAN identity, as stored (client-sealed) in `devices.lan_info`.
///
/// Field names are single words and are serialised verbatim — JS reads exactly
/// these keys.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LanInfo {
    /// Schema version of the sealed blob. Readers must ignore an unknown
    /// version rather than guessing at its shape.
    pub v: u8,
    /// `10:7C:61:46:69:BD` — uppercase, colon-separated.
    pub mac: String,
    /// `192.168.0.77`
    pub ip: String,
    /// The on-link prefix length, e.g. 24.
    pub prefix: u8,
    /// `192.168.0` — the /24 comparison key. Kept as three octets (NOT CIDR)
    /// because `wake.ts` compares it against `subnetOf(ip)`, which returns the
    /// same shape, and a mismatch there silently disables every waker.
    pub subnet: String,
    /// `192.168.0.255` — the subnet-directed broadcast for this interface.
    pub broadcast: String,
    /// Ethernet rather than Wi-Fi. A magic packet almost never wakes a machine
    /// over Wi-Fi, so the UI warns when this is false.
    pub wired: bool,
    /// Adapter friendly name, for display and diagnosis only.
    pub iface: String,
}

/// The LAN interface most likely to be able to wake this machine, or `None`
/// when nothing suitable exists (and on every non-Windows target).
pub fn collect() -> Option<LanInfo> {
    collect_impl()
}

/// Broadcast address for `ip` under `prefix`, e.g. 192.168.0.77/24 ->
/// 192.168.0.255. Split out so it can be tested without any OS calls.
fn broadcast_for(ip: std::net::Ipv4Addr, prefix: u8) -> std::net::Ipv4Addr {
    // A /0 would shift by 32 and panic in debug; a /32 has no broadcast. Both
    // are nonsense for a LAN adapter, so clamp rather than pretend.
    if prefix == 0 || prefix > 32 {
        return std::net::Ipv4Addr::BROADCAST;
    }
    let host_bits = 32 - u32::from(prefix);
    let mask: u32 = if host_bits == 32 { 0 } else { u32::MAX << host_bits };
    std::net::Ipv4Addr::from(u32::from(ip) | !mask)
}

/// The `a.b.c` comparison key `wake.ts::subnetOf` produces. Deliberately /24
/// shaped regardless of the real prefix: it is only ever used to ask "do these
/// two devices look like they are on the same home network", and both sides
/// must compute it the same way.
fn subnet_key(ip: std::net::Ipv4Addr) -> String {
    let o = ip.octets();
    format!("{}.{}.{}", o[0], o[1], o[2])
}

fn format_mac(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Ranking key for a candidate adapter — higher is better.
///
/// A machine can legitimately present several adapters that all pass the
/// hardware predicates (a docking station, a Hyper-V bridge over the real NIC,
/// a second NIC on a different subnet). Preferring "has a default gateway"
/// picks the one actually carrying traffic, and wired-over-wireless picks the
/// one that can actually be woken.
fn rank(wired: bool, has_gateway: bool) -> u8 {
    (u8::from(has_gateway) << 1) | u8::from(wired)
}

#[cfg(windows)]
fn collect_impl() -> Option<LanInfo> {
    use std::net::Ipv4Addr;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
        GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

    // MIB_IF_TYPE / IANA ifType values. windows-rs exposes these as loose
    // constants in several modules depending on version, so they are spelled
    // out here rather than imported — they are IANA-assigned and frozen.
    const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
    const IF_TYPE_IEEE80211: u32 = 71;

    // GetAdaptersAddresses wants a buffer it can grow into. 16 KiB holds a
    // typical machine's adapter list; the loop below retries once on overflow
    // rather than assuming.
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u8> = Vec::new();
    let flags = GAA_FLAG_INCLUDE_GATEWAYS
        | GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_DNS_SERVER;

    // Tracked explicitly rather than inferred from `buf` being non-empty:
    // after a failed call the buffer is allocated but full of zeroes, and
    // walking it would be reading a linked list the OS never wrote. It happens
    // to terminate immediately (a zeroed `Next` is null), but relying on that
    // is relying on an accident.
    let mut populated = false;
    for _ in 0..3 {
        buf.clear();
        buf.resize(size as usize, 0);
        let ret = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_UNSPEC.0),
                flags,
                None,
                Some(buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>()),
                &mut size,
            )
        };
        // ERROR_SUCCESS
        if ret == 0 {
            populated = true;
            break;
        }
        // ERROR_BUFFER_OVERFLOW: `size` now holds what is actually needed, so
        // the next pass allocates it. Any other code is a real failure.
        if ret == 111 {
            continue;
        }
        return None;
    }
    if !populated {
        return None;
    }

    let mut best: Option<(u8, LanInfo)> = None;
    let mut adapter = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;

    while !adapter.is_null() {
        let a = unsafe { &*adapter };
        adapter = a.Next;

        // Operationally up. A disconnected TAP/VPN adapter is Down and would
        // otherwise look like a perfectly good Ethernet card.
        if a.OperStatus != IfOperStatusUp {
            continue;
        }
        // A real card, not a tunnel/loopback/virtual-prop interface.
        let if_type = a.IfType;
        let wired = if_type == IF_TYPE_ETHERNET_CSMACD;
        if !wired && if_type != IF_TYPE_IEEE80211 {
            continue;
        }
        // A magic packet addresses a 6-byte MAC. Anything else cannot be woken.
        if a.PhysicalAddressLength != 6 {
            continue;
        }
        let mac = format_mac(&a.PhysicalAddress[..6]);

        // First private IPv4 on this adapter, with its on-link prefix.
        let mut ipv4: Option<(Ipv4Addr, u8)> = None;
        let mut uni = a.FirstUnicastAddress;
        while !uni.is_null() {
            let u = unsafe { &*uni };
            uni = u.Next;
            let sa = u.Address.lpSockaddr;
            if sa.is_null() || unsafe { (*sa).sa_family } != AF_INET {
                continue;
            }
            let sin = unsafe { &*(sa as *const SOCKADDR_IN) };
            let addr = Ipv4Addr::from(u32::from_be(unsafe { sin.sin_addr.S_un.S_addr }));
            // Only a private address can be a home LAN. A public address on a
            // physical NIC is a datacentre box, where waking is meaningless.
            if !addr.is_private() {
                continue;
            }
            // The prefix comes from DHCP, and the broadcast derived from it is
            // sent UNGATED (it is self-derived, so `is_local_wake_target` is
            // deliberately not applied). A hostile DHCP server on a network the
            // user joins could hand out 10.0.0.5/2, whose "broadcast" is
            // 63.255.255.255 — a public address — reopening in miniature the
            // exact send-anywhere primitive that gate exists to close. No home
            // network is wider than a /8.
            if u.OnLinkPrefixLength < 8 || u.OnLinkPrefixLength > 32 {
                continue;
            }
            ipv4 = Some((addr, u.OnLinkPrefixLength));
            break;
        }
        let Some((ip, prefix)) = ipv4 else { continue };

        // GAA_FLAG_INCLUDE_GATEWAYS populates this. A Hyper-V/Docker/VirtualBox
        // host-only bridge is Up with a real MAC and a private IP, but has no
        // gateway — which is exactly what separates it from the card the user's
        // traffic actually leaves by.
        let has_gateway = !a.FirstGatewayAddress.is_null();

        let iface = unsafe { widestring_from_ptr(a.FriendlyName.0) };
        let score = rank(wired, has_gateway);
        let info = LanInfo {
            v: 1,
            mac,
            ip: ip.to_string(),
            prefix,
            subnet: subnet_key(ip),
            broadcast: broadcast_for(ip, prefix).to_string(),
            wired,
            iface,
        };
        // `match` rather than `Option::is_none_or`: that method stabilised in
        // Rust 1.82 and this crate declares rust-version 1.77.2, so using it
        // would quietly break the MSRV the manifest promises.
        //
        // Strictly `>`, so the FIRST adapter at a given rank wins. Windows
        // returns adapters in a stable order, and preferring the earlier one
        // keeps the choice from flapping between two equally-ranked cards
        // between runs — which would re-PATCH lan_info every attestation.
        let better = match &best {
            None => true,
            Some((current, _)) => score > *current,
        };
        if better {
            best = Some((score, info));
        }
    }

    best.map(|(_, info)| info)
}

/// Read a NUL-terminated UTF-16 string. `FriendlyName` is a plain `PWSTR` into
/// the same buffer the adapter list lives in.
#[cfg(windows)]
unsafe fn widestring_from_ptr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    // Bound checked BEFORE the dereference: the other order reads index 512 of
    // an unterminated string before deciding to stop.
    let mut len = 0usize;
    while len < 512 && *p.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

/// Collection is Windows-only in v1: it is the only desktop platform Puca
/// ships an installer for. A device on another platform simply never records
/// LAN details, so `planWake` reports it as un-wakeable rather than offering a
/// button that cannot work.
#[cfg(not(windows))]
fn collect_impl() -> Option<LanInfo> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn broadcast_for_the_usual_home_prefixes() {
        let ip: Ipv4Addr = "192.168.0.77".parse().unwrap();
        assert_eq!(broadcast_for(ip, 24), "192.168.0.255".parse::<Ipv4Addr>().unwrap());
        assert_eq!(broadcast_for(ip, 16), "192.168.255.255".parse::<Ipv4Addr>().unwrap());
        let ten: Ipv4Addr = "10.1.2.3".parse().unwrap();
        assert_eq!(broadcast_for(ten, 8), "10.255.255.255".parse::<Ipv4Addr>().unwrap());
        // /23 spans two /24s — the broadcast is at the top of the PAIR.
        let odd: Ipv4Addr = "192.168.4.5".parse().unwrap();
        assert_eq!(broadcast_for(odd, 23), "192.168.5.255".parse::<Ipv4Addr>().unwrap());
    }

    #[test]
    fn nonsense_prefixes_do_not_panic() {
        // A /0 shifts by 32, which panics in debug builds if written naively.
        let ip: Ipv4Addr = "192.168.0.77".parse().unwrap();
        assert_eq!(broadcast_for(ip, 0), Ipv4Addr::BROADCAST);
        assert_eq!(broadcast_for(ip, 33), Ipv4Addr::BROADCAST);
        // /32 is a host route: no broadcast, and it must not shift by 32 either.
        assert_eq!(broadcast_for(ip, 32), ip);
    }

    #[test]
    fn subnet_key_matches_the_shape_wake_ts_compares_against() {
        // wake.ts::subnetOf returns "a.b.c". If this ever returns CIDR instead,
        // every same-network comparison silently fails and no waker is eligible.
        assert_eq!(subnet_key("192.168.0.77".parse().unwrap()), "192.168.0");
        assert_eq!(subnet_key("10.0.0.1".parse().unwrap()), "10.0.0");
    }

    #[test]
    fn mac_is_uppercase_colon_separated() {
        assert_eq!(format_mac(&[0x10, 0x7c, 0x61, 0x46, 0x69, 0xbd]), "10:7C:61:46:69:BD");
        // Leading zeroes must survive: 0x0A is "0A", never "A".
        assert_eq!(format_mac(&[0x0a, 0x00, 0xff, 0x01, 0x02, 0x03]), "0A:00:FF:01:02:03");
    }

    /// Diagnostic, not a gate: prints what THIS machine reports so a wrong
    /// choice is inspectable rather than mysterious. `#[ignore]` because the
    /// answer is machine-specific and CI has no LAN worth asking about.
    ///
    ///   cargo test --lib lan::tests::what_this_machine_reports -- --ignored --nocapture
    #[test]
    #[ignore]
    fn what_this_machine_reports() {
        match collect() {
            Some(info) => println!("SELECTED: {info:#?}"),
            None => println!("SELECTED: none — no adapter passed the predicates"),
        }
    }

    #[test]
    fn a_wired_card_with_a_gateway_outranks_every_other_candidate() {
        // The real ordering problem on this machine: a Hyper-V/Docker bridge is
        // Up, has a MAC and a private IP, and differs ONLY in having no gateway.
        let wired_gw = rank(true, true);
        let wifi_gw = rank(false, true);
        let wired_nogw = rank(true, false);
        let wifi_nogw = rank(false, false);
        assert!(wired_gw > wifi_gw, "ethernet beats wi-fi when both route");
        assert!(wifi_gw > wired_nogw, "a routing wi-fi card beats a bridge that routes nothing");
        assert!(wired_nogw > wifi_nogw);
    }
}
