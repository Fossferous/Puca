//! Display-topology self-heal: the pure decision logic, kept off the
//! Windows-only `stream` module so Linux CI compiles and tests it.
//!
//! Nothing notifies the stream loop when Windows re-shapes the desktop under a
//! live capture: a monitor DPMS-sleeps and DETACHES after the user walks away,
//! or a GPU drops and re-adds outputs on wake. The old duplication then serves
//! a stale or black surface, and until this the only way back was the
//! controller poking `display_topology_changed` — i.e. a human rejigging the
//! monitor config by hand after every idle reconnect (field report
//! 2026-09-07). The stream loop compares the live output enumeration against
//! the one its capture was built on, on a slow clock, and self-drives the same
//! rebuild the poke does when they diverge. This module is that comparison.
//!
//! `stream` (Windows-only) is the sole caller; these live here because the
//! logic — a set diff, a remap, a cadence — needs no Windows API and is worth
//! testing on every CI leg, the same reason PushGate/GeofenceEngine were
//! extracted from the Android app.

// The only caller is the Windows-only `stream` module, so on a non-test Linux
// build these are unused; the tests below exercise them on every CI leg.
#![allow(dead_code)]

use std::time::{Duration, Instant};

/// How often the pump loop re-enumerates outputs to notice a topology change.
/// The caret geometry recheck already pays one enumeration on this cadence;
/// matching it keeps the added cost to nothing while nobody tracks the caret.
pub(crate) const TOPOLOGY_RECHECK_EVERY: Duration = Duration::from_secs(2);

/// A cheap, comparable fingerprint of the output enumeration: each output's
/// stable index and its desktop rectangle. A monitor detaching, re-attaching,
/// changing resolution or moving in the layout all change this; a pixel
/// changing on a still-attached monitor does not. Rotation and HMONITOR are
/// left out deliberately — a rotation surfaces as a width/height swap, and
/// HMONITOR is not stable across a detach/reattach, so including it would fire
/// the rebuild on churn the capture does not care about.
pub(crate) type OutputSig = Vec<(usize, i32, i32, i32, i32)>;

pub(crate) fn outputs_signature(outs: &[puca_capture::OutputInfo]) -> OutputSig {
    outs.iter()
        .map(|o| (o.index, o.left, o.top, o.width, o.height))
        .collect()
}

pub(crate) fn topology_differs(built: &OutputSig, now: &OutputSig) -> bool {
    built != now
}

pub(crate) fn should_recheck_topology(last: Option<Instant>, now: Instant) -> bool {
    match last {
        None => true,
        Some(t) => now.duration_since(t) >= TOPOLOGY_RECHECK_EVERY,
    }
}

/// Where a rebuild should retarget after a topology change. A whole-desktop
/// capture (`ALL_DISPLAYS`) always stays whole. A single-monitor capture whose
/// output is still present stays on it; one whose output has VANISHED lands on
/// output 0 — the same remap the controller applies client-side (session.ts:
/// "a single monitor that no longer exists lands on output 0"). `present` is
/// the set of still-live output indices, which may have GAPS (an undescribable
/// output is omitted without renumbering), so membership is tested, never a
/// bare count.
pub(crate) fn remap_monitor_for(current: usize, present: &[usize]) -> usize {
    if current == crate::composite::ALL_DISPLAYS {
        return current;
    }
    if present.contains(&current) {
        current
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(index: usize, left: i32, top: i32, width: i32, height: i32) -> puca_capture::OutputInfo {
        puca_capture::OutputInfo {
            index,
            left,
            top,
            width,
            height,
            hmonitor: 0,
            rotation: puca_capture::Rotation::None,
        }
    }

    #[test]
    fn an_unchanged_enumeration_does_not_trigger_a_rebuild() {
        let a = [out(0, 0, 0, 2560, 1440), out(1, 2560, 0, 1920, 1080)];
        let sig = outputs_signature(&a);
        assert!(!topology_differs(&sig, &outputs_signature(&a)));
    }

    #[test]
    fn a_detached_or_resized_or_moved_monitor_triggers_a_rebuild() {
        let base = outputs_signature(&[out(0, 0, 0, 2560, 1440), out(1, 2560, 0, 1920, 1080)]);
        // A second monitor detached — the AFK display-sleep case.
        assert!(topology_differs(&base, &outputs_signature(&[out(0, 0, 0, 2560, 1440)])));
        // A resolution change on the primary.
        assert!(topology_differs(&base, &outputs_signature(&[out(0, 0, 0, 1920, 1080), out(1, 2560, 0, 1920, 1080)])));
        // The secondary moved in the layout.
        assert!(topology_differs(&base, &outputs_signature(&[out(0, 0, 0, 2560, 1440), out(1, -1920, 0, 1920, 1080)])));
    }

    #[test]
    fn a_rotation_shows_up_as_a_dimension_swap_and_triggers_a_rebuild() {
        // Rotation is not in the signature, but a portrait panel reports a
        // swapped desktop rect (1440x2560), so the change is still caught.
        let landscape = outputs_signature(&[out(0, 0, 0, 2560, 1440)]);
        let portrait = outputs_signature(&[out(0, 0, 0, 1440, 2560)]);
        assert!(topology_differs(&landscape, &portrait));
    }

    #[test]
    fn remap_keeps_a_live_target_and_drops_a_vanished_one() {
        // ALL_DISPLAYS is always kept whole.
        assert_eq!(
            remap_monitor_for(crate::composite::ALL_DISPLAYS, &[0, 1]),
            crate::composite::ALL_DISPLAYS
        );
        // A still-present single monitor is kept (indices may have gaps).
        assert_eq!(remap_monitor_for(2, &[0, 2]), 2);
        // A vanished single monitor lands on 0 — matching the client remap.
        assert_eq!(remap_monitor_for(2, &[0, 1]), 0);
        assert_eq!(remap_monitor_for(1, &[0]), 0);
    }

    #[test]
    fn the_recheck_clock_fires_first_then_on_the_cadence() {
        let now = Instant::now();
        assert!(should_recheck_topology(None, now), "the first check must run");
        assert!(!should_recheck_topology(Some(now), now), "not again immediately");
        assert!(
            should_recheck_topology(Some(now - TOPOLOGY_RECHECK_EVERY), now),
            "again after the cadence"
        );
    }
}
