//! Measure the caret APIs on real hardware, before trusting any of them.
//!
//! Unit tests can prove the fractions arithmetic and the hysteresis; they cannot
//! tell you which Win32 API answers for Windows Terminal, whether
//! `MapWindowPoints` or `LogicalToPhysicalPointForPerMonitorDPI` puts the caret
//! where it visibly is on a 150%-scaled monitor, or whether this desk's GDI and
//! DXGI rectangles agree at all. Same argument as
//! `puca-capture/examples/cursor_probe.rs`, and the same discipline: the
//! output of a run belongs in the PR.
//!
//!   cargo run --example caret_probe --features caret               # one shot
//!   cargo run --example caret_probe --features caret -- --watch    # 20Hz, on change
//!
//! Run it against, at least: Notepad, Explorer's rename box, Chrome and Edge
//! (address bar AND a textarea), VS Code, Windows Terminal, the PowerShell
//! console, an app started with `__COMPAT_LAYER=DpiUnaware` on a scaled monitor,
//! and an elevated app (expect a refusal as a user-flavour agent would see it).
//! Then lock the workstation with `--watch` running: tier 1 must report NOTHING
//! rather than the Default desktop's stale caret.
//!
//! It prints CLASS NAMES, never window titles: a title carries whatever the user
//! is working on, and knowing that Notepad answered needs only the class.

#[cfg(all(windows, feature = "caret"))]
mod probe {
    use puca_input::caret::{
        oleacc_module_path, probe_set_thread_desktop_after_com, probe_tier1, probe_tier2,
        probe_tier3, CaretRect, CaretSource, POLL_INTERVAL,
    };
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::HiDpi::{
        GetAwarenessFromDpiAwarenessContext, GetThreadDpiAwarenessContext,
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    /// The blink flag, whose VALUE this probe exists to settle: it is the
    /// caret's blink state, not "a caret exists", and the sampler deliberately
    /// does not gate on it. Watch it toggle here before believing either claim.
    const GUI_CARETBLINKING: u32 = 0x0000_0001;

    fn class_of(hwnd: isize) -> String {
        if hwnd == 0 {
            return "-".to_string();
        }
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(HWND(hwnd as *mut core::ffi::c_void), &mut buf) };
        if n <= 0 {
            return "?".to_string();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    /// What a DPI awareness context actually MEANS.
    ///
    /// `GetThreadDpiAwarenessContext` does not return the sentinel it was set
    /// with — measured on this desk it returns 24592 before and 34 after, both
    /// opaque handles — so the value must be interrogated rather than compared.
    /// Note that PER_MONITOR_AWARE_V2 reports as PER_MONITOR_AWARE (2): the
    /// enum has no V2 member, which is exactly the sort of thing that makes a
    /// hand-rolled comparison of raw handles lie.
    fn dpi_awareness_name(ctx: DPI_AWARENESS_CONTEXT) -> &'static str {
        match unsafe { GetAwarenessFromDpiAwarenessContext(ctx) }.0 {
            0 => "UNAWARE",
            1 => "SYSTEM_AWARE",
            2 => "PER_MONITOR_AWARE (V1 or V2)",
            -1 => "INVALID",
            _ => "<unknown>",
        }
    }

    fn show(rect: Option<CaretRect>) -> String {
        match rect {
            Some(r) => format!("({},{}) {}x{}", r.left, r.top, r.width, r.height),
            None => "-".to_string(),
        }
    }

    pub fn run() {
        let watch = std::env::args().any(|a| a == "--watch");

        // BEFORE the DPI context is changed: on a scaled desk these GDI rects
        // are virtualised, and the divergence from DXGI below is the whole
        // reason the caret mapping uses DXGI rectangles and injection does not.
        let gdi_before = puca_input::list_monitors();
        let ctx_before = unsafe { GetThreadDpiAwarenessContext() };
        let ctx_prev =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let ctx_after = unsafe { GetThreadDpiAwarenessContext() };
        println!("== DPI ==");
        println!(
            "thread awareness before = {} (handle {:?}), after = {} (handle {:?})",
            dpi_awareness_name(ctx_before),
            ctx_before.0,
            dpi_awareness_name(ctx_after),
            ctx_after.0,
        );
        if unsafe { GetAwarenessFromDpiAwarenessContext(ctx_prev) }.0
            == unsafe { GetAwarenessFromDpiAwarenessContext(ctx_after) }.0
            && unsafe { GetAwarenessFromDpiAwarenessContext(ctx_before) }.0 != 2
        {
            println!("WARNING: SetThreadDpiAwarenessContext did not change anything");
        }

        let gdi_after = puca_input::list_monitors();
        let dxgi = puca_capture::outputs();
        println!();
        println!("== MONITORS ==");
        println!(
            "GDI virtual desktop: before ({},{}) {}x{}   after ({},{}) {}x{}",
            gdi_before.virt_left,
            gdi_before.virt_top,
            gdi_before.virt_width,
            gdi_before.virt_height,
            gdi_after.virt_left,
            gdi_after.virt_top,
            gdi_after.virt_width,
            gdi_after.virt_height,
        );
        println!("{:<6} {:<28} {:<28} {:<10} {}", "hmon", "DXGI (physical)", "GDI (this thread)", "scale", "rotation");
        for m in &gdi_after.monitors {
            let d = dxgi.iter().find(|o| o.hmonitor != 0 && o.hmonitor == m.hmonitor);
            let dxgi_cell = match d {
                Some(o) => format!("[{}] ({},{}) {}x{}", o.index, o.left, o.top, o.width, o.height),
                None => "<no DXGI join>".to_string(),
            };
            println!(
                "{:<#6x} {:<28} {:<28} {:<10} {}",
                m.hmonitor,
                dxgi_cell,
                format!("({},{}) {}x{}", m.left, m.top, m.width, m.height),
                format!("{:.2}", m.scale),
                d.map(|o| format!("{:?}", o.rotation)).unwrap_or_default(),
            );
        }
        // Outputs with no GDI partner would otherwise be invisible in the table
        // above, and a gap in `outputs()` is a real shape on real hardware.
        for o in &dxgi {
            if !gdi_after.monitors.iter().any(|m| m.hmonitor == o.hmonitor) {
                println!(
                    "{:<#6x} [{}] ({},{}) {}x{}   <no GDI join>",
                    o.hmonitor, o.index, o.left, o.top, o.width, o.height
                );
            }
        }

        println!();
        println!("== oleacc.dll ==");
        match oleacc_module_path() {
            // MUST be C:\Windows\System32\oleacc.dll. Anything else means the
            // LOAD_LIBRARY_SEARCH_SYSTEM32 load did not do what it says, and a
            // planted DLL would be loading into a LocalSystem process.
            Some(p) => println!("loaded from {p}"),
            None => println!("could not be loaded (tier 2 is unavailable)"),
        }

        println!();
        println!("== SetThreadDesktop after CoInitializeEx(MTA), on a scratch thread ==");
        // The measurement the two-thread split rests on. If this SUCCEEDS the
        // split is insurance rather than necessity; if it fails, a single-thread
        // sampler would silently lose the lock screen.
        match probe_set_thread_desktop_after_com() {
            Ok(name) => println!("succeeded, attached to '{name}'"),
            Err(e) => println!("REFUSED: {e}"),
        }

        // This thread now takes an apartment of its own so tiers 2 and 3 can be
        // exercised from here. The shipped sampler keeps COM on a SEPARATE
        // thread; see the module header in caret.rs for why.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        println!("CoInitializeEx(MTA) on the probe thread: {hr:?}");

        println!();
        println!("== SAMPLES ==");
        let mut last = String::new();
        loop {
            let line = sample_line(&dxgi);
            if !watch {
                println!("{line}");
                break;
            }
            if line != last {
                println!("{line}");
                last = line;
            }
            // Faster than the sampler's own 10Hz on purpose: the blink flag
            // toggles at ~530ms and this is the only place its behaviour can be
            // observed at all.
            std::thread::sleep(Duration::from_millis(50).min(POLL_INTERVAL));
        }
    }

    fn sample_line(dxgi: &[puca_capture::OutputInfo]) -> String {
        let t0 = Instant::now();
        let (tier1, focus, flags, alt) = probe_tier1();
        let t1 = t0.elapsed();

        let t0 = Instant::now();
        let tier2 = probe_tier2();
        let t2 = t0.elapsed();

        let t0 = Instant::now();
        let tier3 = probe_tier3();
        let t3 = t0.elapsed();

        let winner = tier1
            .or_else(|| tier2.map(|r| (r, CaretSource::Msaa)))
            .or(tier3);

        let mut out = format!(
            "focus={:#x} class={:<24} flags={:#06x}{} \n  \
             tier1 win32 {:<26} {:>7.2?}   [alt LogicalToPhysical {}]\n  \
             tier2 msaa  {:<26} {:>7.2?}\n  \
             tier3       {:<26} {:>7.2?}",
            focus,
            class_of(focus),
            flags,
            if flags & GUI_CARETBLINKING != 0 { " CARETBLINKING" } else { "" },
            show(tier1.map(|(r, _)| r)),
            t1,
            show(alt),
            show(tier2),
            t2,
            tier3
                .map(|(r, s)| format!("{} {}", s.wire(), show(Some(r))))
                .unwrap_or_else(|| "-".to_string()),
            t3,
        );

        match winner {
            Some((r, src)) => {
                // Which screen it is on, and the fractions the agent would send.
                // The SHIPPED mapping is `caret_fractions` in
                // puca-agent/src/session.rs (pure, and tested with
                // hand-derived numbers); this is the same arithmetic on the
                // rects this machine really reports, which is the part no test
                // can fabricate.
                let on = dxgi.iter().find(|o| {
                    r.left >= o.left
                        && r.left < o.left + o.width
                        && r.top >= o.top
                        && r.top < o.top + o.height
                });
                match on {
                    Some(o) => out.push_str(&format!(
                        "\n  -> {} on DXGI[{}]: x={:.5} y={:.5} w={:.5} h={:.5}",
                        src.wire(),
                        o.index,
                        (r.left - o.left) as f64 / o.width as f64,
                        (r.top - o.top) as f64 / o.height as f64,
                        r.width as f64 / o.width as f64,
                        r.height as f64 / o.height as f64,
                    )),
                    None => out.push_str("\n  -> off every DXGI surface (the agent sends vis:false)"),
                }
            }
            None => out.push_str("\n  -> no caret (the agent sends vis:false)"),
        }
        out
    }
}

#[cfg(all(windows, feature = "caret"))]
fn main() {
    probe::run();
}

#[cfg(not(all(windows, feature = "caret")))]
fn main() {
    eprintln!(
        "caret_probe measures Win32 caret APIs on real hardware. Build it on Windows with \
         --features caret; there is nothing to probe otherwise."
    );
}
