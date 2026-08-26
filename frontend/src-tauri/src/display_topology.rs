//! TEMPORARILY DETACH the non-primary displays from the desktop — and put
//! them back.
//!
//! This is a different physics from `display_power.rs` and deliberately a
//! different file: SC_MONITORPOWER and DDC/CI turn PANELS dark while Windows
//! keeps extending the desktop onto them — windows stay parked there and the
//! pointer wanders into screens nobody can see. Detaching removes the
//! displays from the TOPOLOGY: windows re-arrange onto the primary, the
//! pointer cannot leave it, and the remote picture is the whole desktop.
//!
//! REVERSIBILITY IS THE WHOLE DESIGN. A dark panel self-heals (any physical
//! input relights it), so "always stay as set" was safe for power. A detached
//! topology is NOT self-healing: it survives this process's death, and a user
//! stranded with screens Windows thinks are gone has only Settings → Display
//! to dig themselves out. So:
//!  - the change is applied WITHOUT `SDC_SAVE_TO_DATABASE` — the CCD database
//!    keeps the real layout, and restoring is asking Windows to re-apply the
//!    database's CURRENT topology (SDC_USE_DATABASE_CURRENT — never a forced
//!    extend, which would un-mirror a clone-mode machine);
//!  - a MARKER FILE is written before the detach and removed after a
//!    successful reattach, and app startup restores if it finds one (the
//!    crash case);
//!  - session teardown restores unconditionally (`on_session_end`) — the
//!    opposite of display_power's stay-as-set, on purpose.
//!
//! The OS calls live behind `backend`, and tests never reach them — blanking
//! or re-arranging the developer's monitors from `cargo test` is the same
//! class of harm as shutting their machine down (display_power.rs's rule).

use std::sync::Mutex;

/// What `detach_others` decided, decided without touching the OS.
#[derive(Debug, PartialEq, Eq)]
pub enum DetachPlan {
    /// Fewer than two active displays: answer ok, do nothing.
    NothingToDetach,
    /// Deactivate these path indices (everything but the first primary).
    Detach { keep: usize, drop: Vec<usize> },
    /// No path renders the desktop origin — refuse rather than guess, since
    /// guessing wrong turns EVERY screen off.
    NoPrimary,
}

/// Pure: which paths to deactivate, given which of the active paths renders
/// the primary (desktop-origin) source. The FIRST primary is kept — clone
/// groups can render the origin twice, and keeping both would detach nothing
/// on a mirrored pair.
pub fn plan_detach(is_primary: &[bool]) -> DetachPlan {
    if is_primary.len() < 2 {
        return DetachPlan::NothingToDetach;
    }
    let Some(keep) = is_primary.iter().position(|p| *p) else {
        return DetachPlan::NoPrimary;
    };
    let drop = (0..is_primary.len()).filter(|i| *i != keep).collect();
    DetachPlan::Detach { keep, drop }
}

pub const NO_PRIMARY_REFUSAL: &str =
    "could not identify the primary display, so nothing was detached";
pub const NOTHING_TO_DETACH: &str = "This machine has only one display — nothing to disable.";

/// Process-wide topology state. Managed by tauri (lib.rs) exactly like
/// `DisplayPower`.
#[derive(Default)]
pub struct DisplayTopology {
    /// The active configuration captured at detach, for the faithful restore.
    /// None once restored — and None after an app restart, where the marker
    /// file plus the database-current restore (the CCD database still holds
    /// the real layout) is the path instead.
    saved: Mutex<Option<backend::Snapshot>>,
    /// Whether THIS process believes a detach is in force — drives the
    /// session-end restore without a disk read.
    detached: Mutex<bool>,
}

impl DisplayTopology {
    /// Detach every non-primary display. Returns the honest human detail line.
    pub fn detach_others(&self) -> Result<String, String> {
        let (snapshot, plan) = backend::query_active()?;
        let outcome = match plan {
            DetachPlan::NothingToDetach => return Ok(NOTHING_TO_DETACH.to_string()),
            DetachPlan::NoPrimary => return Err(NO_PRIMARY_REFUSAL.to_string()),
            DetachPlan::Detach { keep: _, ref drop } => {
                // The marker goes down BEFORE the OS call: a crash between the
                // two restores from the database — which still holds the real
                // layout, because nothing was changed yet — where the other
                // order strands a changed topology with no marker. A FAILED
                // call removes it again: an orphaned marker would make the
                // next startup re-apply the database topology to a desktop
                // this process never touched.
                marker::write()?;
                let dropped = drop.len();
                if let Err(e) = backend::apply_detached(&snapshot, drop) {
                    marker::remove();
                    return Err(e);
                }
                dropped
            }
        };
        *self.saved.lock().unwrap() = Some(snapshot);
        *self.detached.lock().unwrap() = true;
        Ok(format!("Disabled {outcome} other display(s) — they come back when the session ends"))
    }

    /// Put every display back. A NO-OP when nothing is detached: "Re-enable
    /// displays" is an unconditional menu entry, and re-applying even the
    /// database topology to a desktop this process never touched is a layout
    /// change nobody asked for (the first version applied SDC_TOPOLOGY_EXTEND
    /// here, which would have un-mirrored a clone-mode machine on a stray
    /// tap). The marker check covers a detach a CRASHED run left behind.
    pub fn reattach(&self) -> Result<(), String> {
        let saved = self.saved.lock().unwrap().take();
        if saved.is_none() && !*self.detached.lock().unwrap() && !marker::present() {
            return Ok(());
        }
        let result = backend::restore(saved);
        if result.is_ok() {
            *self.detached.lock().unwrap() = false;
            marker::remove();
        }
        result
    }

    /// Session teardown: the unconditional restore (see the header — topology
    /// is deliberately NOT stay-as-set). Quiet when nothing is detached.
    pub fn on_session_end(&self) {
        if !*self.detached.lock().unwrap() {
            return;
        }
        if let Err(e) = self.reattach() {
            eprintln!("[display-topology] session-end restore failed: {e}");
        }
    }

    /// App startup: a marker with no live state is a crash's leftovers —
    /// restore from the CCD database and clear it.
    pub fn restore_if_marked(&self) {
        if !marker::present() {
            return;
        }
        eprintln!("[display-topology] startup found a detach marker — restoring the display layout");
        match backend::restore(None) {
            Ok(()) => marker::remove(),
            Err(e) => eprintln!("[display-topology] startup restore failed: {e}"),
        }
    }
}

/// The crash-restore marker. Same directory as the unattended-access record
/// (unattended_store.rs) — this process's one durable state corner.
mod marker {
    fn path() -> Result<std::path::PathBuf, String> {
        #[cfg(windows)]
        let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
        #[cfg(not(windows))]
        let base = std::env::var("HOME")
            .map(|h| format!("{h}/.local/share"))
            .map_err(|_| "HOME is not set".to_string())?;
        let dir = std::path::Path::new(&base).join("com.sovereign.chat").join("device");
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
        Ok(dir.join("display-topology-detached"))
    }

    pub fn write() -> Result<(), String> {
        let p = path()?;
        std::fs::write(&p, b"a detach is in force; restored on reattach or next startup\n")
            .map_err(|e| format!("could not write the restore marker {p:?}: {e}"))
    }

    pub fn present() -> bool {
        path().map(|p| p.exists()).unwrap_or(false)
    }

    pub fn remove() {
        if let Ok(p) = path() {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(all(windows, not(test)))]
mod backend {
    use super::{plan_detach, DetachPlan};
    use windows::Win32::Devices::Display::{
        GetDisplayConfigBufferSizes, QueryDisplayConfig, SetDisplayConfig,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE, DISPLAYCONFIG_PATH_INFO,
        QDC_ONLY_ACTIVE_PATHS, SDC_ALLOW_CHANGES, SDC_APPLY, SDC_USE_DATABASE_CURRENT,
        SDC_USE_SUPPLIED_DISPLAY_CONFIG,
    };
    use windows::Win32::Foundation::ERROR_SUCCESS;

    /// wingdi.h macros the windows crate does not re-export.
    const DISPLAYCONFIG_PATH_ACTIVE: u32 = 0x0000_0001;
    const DISPLAYCONFIG_PATH_MODE_IDX_INVALID: u32 = 0xFFFF_FFFF;

    /// The active paths + modes as Windows reported them — reapplying this
    /// verbatim is the highest-fidelity restore (clone groups, rotations and
    /// refresh rates survive exactly).
    pub struct Snapshot {
        paths: Vec<DISPLAYCONFIG_PATH_INFO>,
        modes: Vec<DISPLAYCONFIG_MODE_INFO>,
    }

    /// Query the active configuration and decide what a detach would do.
    pub fn query_active() -> Result<(Snapshot, DetachPlan), String> {
        unsafe {
            let (mut n_paths, mut n_modes) = (0u32, 0u32);
            let rc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, &mut n_modes);
            if rc != ERROR_SUCCESS {
                return Err(format!("GetDisplayConfigBufferSizes failed: {rc:?}"));
            }
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); n_paths as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); n_modes as usize];
            let rc = QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut n_paths, paths.as_mut_ptr(),
                &mut n_modes, modes.as_mut_ptr(),
                None,
            );
            if rc != ERROR_SUCCESS {
                return Err(format!("QueryDisplayConfig failed: {rc:?}"));
            }
            paths.truncate(n_paths as usize);
            modes.truncate(n_modes as usize);

            // The primary renders the desktop origin: its SOURCE mode sits at
            // position (0,0). Without QDC_VIRTUAL_MODE_AWARE the union member
            // is the plain modeInfoIdx.
            let is_primary: Vec<bool> = paths.iter().map(|p| {
                let idx = p.sourceInfo.Anonymous.modeInfoIdx as usize;
                modes.get(idx).is_some_and(|m| {
                    m.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE && {
                        let sm = m.Anonymous.sourceMode;
                        sm.position.x == 0 && sm.position.y == 0
                    }
                })
            }).collect();
            let plan = plan_detach(&is_primary);
            Ok((Snapshot { paths, modes }, plan))
        }
    }

    /// Apply the snapshot with the given path indices deactivated. NOT saved
    /// to the database — the database is the restore.
    pub fn apply_detached(snap: &Snapshot, drop: &[usize]) -> Result<(), String> {
        let mut paths = snap.paths.clone();
        for &i in drop {
            let p = &mut paths[i];
            p.flags &= !DISPLAYCONFIG_PATH_ACTIVE;
            // An inactive path must not reference a mode.
            p.sourceInfo.Anonymous.modeInfoIdx = DISPLAYCONFIG_PATH_MODE_IDX_INVALID;
            p.targetInfo.Anonymous.modeInfoIdx = DISPLAYCONFIG_PATH_MODE_IDX_INVALID;
        }
        unsafe {
            let rc = SetDisplayConfig(
                Some(&paths), Some(&snap.modes),
                SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES,
            );
            if rc != 0 {
                return Err(format!("SetDisplayConfig(detach) failed with {rc}"));
            }
        }
        Ok(())
    }

    /// Restore: the saved snapshot verbatim when this process still holds it,
    /// else ask Windows to re-apply the CCD database's CURRENT topology for
    /// the attached displays (which the detach never wrote to).
    /// SDC_USE_DATABASE_CURRENT, NOT SDC_TOPOLOGY_EXTEND: the extend flag
    /// SELECTS the extended topology, which would convert a clone/duplicate
    /// or single-active-display machine to extended — a layout this feature
    /// promised never to invent. The database-current form reproduces
    /// whatever mode the user actually had.
    pub fn restore(saved: Option<Snapshot>) -> Result<(), String> {
        unsafe {
            if let Some(snap) = saved {
                let rc = SetDisplayConfig(
                    Some(&snap.paths), Some(&snap.modes),
                    SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES,
                );
                if rc == 0 {
                    return Ok(());
                }
                eprintln!("[display-topology] snapshot restore failed with {rc}; falling back to the database");
            }
            let rc = SetDisplayConfig(None, None, SDC_APPLY | SDC_USE_DATABASE_CURRENT);
            if rc != 0 {
                return Err(format!("SetDisplayConfig(database restore) failed with {rc}"));
            }
        }
        Ok(())
    }
}

#[cfg(all(not(windows), not(test)))]
mod backend {
    use super::{DetachPlan};
    pub struct Snapshot;
    pub fn query_active() -> Result<(Snapshot, DetachPlan), String> {
        Err("display topology is only implemented on Windows".to_string())
    }
    pub fn apply_detached(_s: &Snapshot, _drop: &[usize]) -> Result<(), String> {
        Err("display topology is only implemented on Windows".to_string())
    }
    pub fn restore(_saved: Option<Snapshot>) -> Result<(), String> {
        Err("display topology is only implemented on Windows".to_string())
    }
}

/// A recorder, so the state machine above is testable without this test run
/// re-arranging the developer's monitors.
#[cfg(test)]
mod backend {
    use super::DetachPlan;
    use std::sync::Mutex;
    pub struct Snapshot;
    static CALLS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    static NEXT_PLAN: Mutex<Option<DetachPlan>> = Mutex::new(None);
    static FAIL_APPLY: Mutex<bool> = Mutex::new(false);
    pub fn set_next_plan(p: DetachPlan) { *NEXT_PLAN.lock().unwrap() = Some(p); }
    pub fn fail_next_apply() { *FAIL_APPLY.lock().unwrap() = true; }
    pub fn take() -> Vec<&'static str> { std::mem::take(&mut CALLS.lock().unwrap()) }
    pub fn query_active() -> Result<(Snapshot, DetachPlan), String> {
        CALLS.lock().unwrap().push("query");
        let plan = NEXT_PLAN.lock().unwrap().take()
            .unwrap_or(DetachPlan::Detach { keep: 0, drop: vec![1, 2] });
        Ok((Snapshot, plan))
    }
    pub fn apply_detached(_s: &Snapshot, _drop: &[usize]) -> Result<(), String> {
        CALLS.lock().unwrap().push("apply");
        if std::mem::take(&mut *FAIL_APPLY.lock().unwrap()) {
            return Err("SetDisplayConfig(detach) failed with 87".to_string());
        }
        Ok(())
    }
    pub fn restore(saved: Option<Snapshot>) -> Result<(), String> {
        CALLS.lock().unwrap().push(if saved.is_some() { "restore-snapshot" } else { "restore-database" });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marker file and the recorder are process-global, so the stateful
    /// tests serialise on this. `into_inner` on poison: one failed test must
    /// not cascade into every later one failing on the lock.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn the_plan_keeps_the_first_primary_and_drops_the_rest() {
        assert_eq!(plan_detach(&[false, true, false]),
            DetachPlan::Detach { keep: 1, drop: vec![0, 2] });
        // A mirrored pair can render the origin twice: keep ONE.
        assert_eq!(plan_detach(&[true, true]),
            DetachPlan::Detach { keep: 0, drop: vec![1] });
        assert_eq!(plan_detach(&[true]), DetachPlan::NothingToDetach);
        assert_eq!(plan_detach(&[]), DetachPlan::NothingToDetach);
        // No origin found: refuse — guessing wrong detaches every screen.
        assert_eq!(plan_detach(&[false, false]), DetachPlan::NoPrimary);
    }

    // The marker file is process-global state (LOCALAPPDATA), so these run
    // serially and clean up after themselves.

    #[test]
    fn detach_then_session_end_restores_and_clears_the_marker() {
        let _s = serial();
        let t = DisplayTopology::default();
        backend::take();
        let detail = t.detach_others().unwrap();
        assert!(detail.starts_with("Disabled 2"), "{detail}");
        assert!(marker::present(), "the crash marker must be down before the OS call");
        assert_eq!(backend::take(), vec!["query", "apply"]);

        t.on_session_end();
        assert_eq!(backend::take(), vec!["restore-snapshot"],
            "a live process restores from its own snapshot");
        assert!(!marker::present());
        // A second session end is quiet: nothing is detached any more.
        t.on_session_end();
        assert_eq!(backend::take(), Vec::<&str>::new());
    }

    #[test]
    fn a_single_display_machine_answers_ok_and_arms_nothing() {
        let _s = serial();
        let t = DisplayTopology::default();
        backend::set_next_plan(DetachPlan::NothingToDetach);
        backend::take();
        assert_eq!(t.detach_others().unwrap(), NOTHING_TO_DETACH);
        assert!(!marker::present(), "nothing was changed, nothing to restore");
        assert_eq!(backend::take(), vec!["query"]);
        t.on_session_end();
        assert_eq!(backend::take(), Vec::<&str>::new());
    }

    #[test]
    fn no_identifiable_primary_refuses_rather_than_guessing() {
        let _s = serial();
        let t = DisplayTopology::default();
        backend::set_next_plan(DetachPlan::NoPrimary);
        backend::take();
        assert_eq!(t.detach_others().unwrap_err(), NO_PRIMARY_REFUSAL);
        assert!(!marker::present());
        assert_eq!(backend::take(), vec!["query"]);
    }

    #[test]
    fn startup_restore_only_acts_on_a_leftover_marker() {
        let _s = serial();
        let t = DisplayTopology::default();
        backend::take();
        t.restore_if_marked();
        assert_eq!(backend::take(), Vec::<&str>::new(), "no marker, no OS call");

        // A crash left the marker behind: the fresh process restores from the
        // database (it has no snapshot) and clears it.
        marker::write().unwrap();
        t.restore_if_marked();
        assert_eq!(backend::take(), vec!["restore-database"]);
        assert!(!marker::present());
    }

    #[test]
    fn explicit_reattach_restores_and_disarms() {
        let _s = serial();
        let t = DisplayTopology::default();
        backend::take();
        t.detach_others().unwrap();
        backend::take();
        t.reattach().unwrap();
        assert_eq!(backend::take(), vec!["restore-snapshot"]);
        assert!(!marker::present());
        // Reattach with nothing detached is a NO-OP: re-applying even the
        // database topology to a desktop this process never touched is a
        // layout change nobody asked for (a stray tap of "Re-enable displays"
        // must not un-mirror a clone-mode machine).
        t.reattach().unwrap();
        assert_eq!(backend::take(), Vec::<&str>::new());
    }

    #[test]
    fn a_failed_detach_cleans_its_marker_up() {
        let _s = serial();
        let t = DisplayTopology::default();
        backend::take();
        backend::fail_next_apply();
        assert!(t.detach_others().is_err());
        // An orphaned marker would make the NEXT startup re-apply the
        // database topology to a desktop this run never changed.
        assert!(!marker::present());
        t.on_session_end();
        assert_eq!(backend::take(), vec!["query", "apply"], "and nothing restores");
    }
}
