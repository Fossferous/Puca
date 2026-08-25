//! Wake-on-LAN, from this app's own network adapter.
//!
//! The packet itself, the destination gate and the target list moved to
//! `puca_service::wol` when the SYSTEM service needed to answer wake
//! requests too — see that module's header for why. What stayed here is the
//! only part that was ever app-specific: asking `crate::lan` which adapter this
//! machine is actually on.
//!
//! THE SOCKET MUST BIND THE PHYSICAL ADAPTER'S IPv4, never 0.0.0.0, and that is
//! why the discovery cannot simply be dropped in favour of a default bind. On a
//! machine running a full-tunnel VPN the routing table chooses the tunnel — a
//! device with no broadcast domain and no NIC behind it — and every packet
//! vanishes while the send count cheerfully reports 4.

use std::net::Ipv4Addr;

/// Broadcast a magic packet for `mac` from whichever adapter this machine is on.
///
/// The returned count is how many datagrams the OS accepted. It is NOT a health
/// signal: `send_to` on a bound, broadcast-enabled socket essentially never
/// fails synchronously, so 4 is the normal result even when nothing on the
/// network could possibly wake. Only the target reconnecting proves anything,
/// which is why the caller waits for it rather than treating this as "done".
pub fn send(mac: &str, broadcast: Option<&str>) -> Result<u32, String> {
    let local = crate::lan::collect();
    let bind_ip = local
        .as_ref()
        .and_then(|l| l.ip.parse::<Ipv4Addr>().ok())
        .unwrap_or(Ipv4Addr::UNSPECIFIED);
    let local_bcast = local
        .as_ref()
        .and_then(|l| l.broadcast.parse::<Ipv4Addr>().ok());

    puca_service::wol::send_from(bind_ip, local_bcast, mac, broadcast)
}

#[cfg(test)]
mod tests {
    /// The behaviour tests for the packet, the destination gate and the target
    /// list live with the code, in `puca_service::wol`. Re-asserting them
    /// here would be two copies of one contract, which is what the move existed
    /// to remove.
    ///
    /// What is worth pinning HERE is the wiring, because it is the half that
    /// stayed behind and the half that can silently regress: if this stops
    /// consulting `crate::lan`, the bind falls back to 0.0.0.0 and the VPN bug
    /// returns with no test going red.
    #[test]
    fn the_send_path_still_binds_a_discovered_adapter() {
        // SCANNED WITHOUT THE TEST MODULE. `include_str!` of this file includes
        // the assertions below, so every string searched for is present in the
        // test's own source and the check passes whatever the real code says.
        // Four tests in this change were written that way and could not fail.
        let src = include_str!("wol.rs").split("#[cfg(test)]").next().unwrap();
        assert!(src.contains("crate::lan::collect()"), "adapter discovery must stay");
        assert!(
            src.contains("puca_service::wol::send_from"),
            "the packet must come from the one shared implementation"
        );
        // 0.0.0.0 may appear ONLY as the last-resort fallback when discovery
        // fails, never as the thing we bind by choice.
        assert!(src.contains("unwrap_or(Ipv4Addr::UNSPECIFIED)"));
    }
}
