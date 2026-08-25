//! SPIKE S5 — can a process follow the input desktop onto Winlogon, and capture it?
//!
//! The plan calls desktop-following the single biggest schedule risk in Phase 8:
//! "if this takes more than a day, plan the SYSTEM service as a quarter, not a
//! sprint." This is that day's work, reduced to a binary that reports what it
//! can actually do rather than what the documentation says it should.
//!
//! WHY IT MATTERS. Windows puts UAC prompts, the lock screen and the login
//! screen on a SEPARATE DESKTOP ("Winlogon"). `SendInput` and every capture API
//! operate on the calling THREAD's desktop, so a process on the ordinary
//! "Default" desktop cannot see or touch any of them — the boundary
//! docs/REMOTE_CONTROL.md already documents as out of scope. Crossing it means
//! noticing the switch and re-attaching, on a fresh thread, as SYSTEM.
//!
//! THE SESSION-0 TRAP, learned the hard way (2026-07-28). A `schtasks /ru SYSTEM`
//! task runs in SESSION 0, on the non-interactive window station
//! `Service-0x0-3e7$`, which has NO input desktop. There `OpenInputDesktop`
//! fails with 0x80070001 ("Incorrect function") on every call — before UAC is
//! even relevant. Running as SYSTEM is necessary but NOT sufficient; the process
//! must also be in the INTERACTIVE console session on `winsta0\default`. So this
//! spike now RELAUNCHES ITSELF there, using the exact token-retargeting the real
//! service will use (`WTSGetActiveConsoleSessionId` -> `DuplicateTokenEx` ->
//! `SetTokenInformation(TokenSessionId)` -> `CreateProcessAsUserW` with
//! `lpDesktop = winsta0\default`). Proving that path here retires a Phase 8 risk
//! directly.
//!
//! RUN IT AS SYSTEM (needs admin to create the task):
//!   schtasks /create /tn SpikeS5 /tr "<path>\spike-s5.exe --log <file> --seconds 90" ^
//!            /sc once /st 00:00 /ru SYSTEM /rl HIGHEST /f
//!   schtasks /run /tn SpikeS5
//!   (trigger a UAC prompt within the window: Start-Process notepad -Verb RunAs)
//!   schtasks /delete /tn SpikeS5 /f
//! and read <file>. The session-0 parent relaunches itself into the console
//! session; the CHILD (marked `--relaunched-interactive`) does the real work and
//! APPENDS to the same log.
//!
//! It writes to a log file (`--log`) as well as stdout, because a SYSTEM task
//! has no console to read.

#[cfg(not(windows))]
fn main() {
    eprintln!("spike-s5 is Windows-only: it exists to test Windows desktop isolation.");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    windows_impl::run();
}

#[cfg(windows)]
mod windows_impl {
    use std::io::Write;
    use std::time::{Duration, Instant};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LUID};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::Security::{
        AdjustTokenPrivileges, DuplicateTokenEx, GetTokenInformation, LookupPrivilegeValueW,
        SetTokenInformation, SecurityImpersonation, TokenPrimary, TokenSessionId, TokenUser,
        LUID_AND_ATTRIBUTES, SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME,
        SE_PRIVILEGE_ENABLED, TOKEN_ACCESS_MASK, TOKEN_ADJUST_PRIVILEGES, TOKEN_DUPLICATE,
        TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::RemoteDesktop::{
        ProcessIdToSessionId, WTSGetActiveConsoleSessionId,
    };
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
        DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, HDESK, UOI_NAME,
    };
    use windows::Win32::System::SystemServices::{MAXIMUM_ALLOWED, SECURITY_LOCAL_SYSTEM_RID};
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcess, GetCurrentProcessId, OpenProcessToken,
        WaitForSingleObject, CREATE_NO_WINDOW, PROCESS_INFORMATION, STARTUPINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    /// Marks the relaunched child, so it does NOT try to relaunch again.
    const RELAUNCH_FLAG: &str = "--relaunched-interactive";

    struct Log(Option<std::fs::File>);

    impl Log {
        /// Open the log for APPENDING. Always append, never truncate.
        ///
        /// Parent and child are two processes sharing one `--log` path. If
        /// either truncated, or wrote at a stale position, it would erase the
        /// other's lines — and the parent writing (at its old offset) *after*
        /// the child has appended would overwrite the child's header, which is
        /// exactly the decisive output. O_APPEND makes every write seek to the
        /// true end first, so the two interleave cleanly at line granularity.
        /// The single truncation happens once in `run()` before anyone writes.
        fn open(path: Option<&str>) -> Self {
            let file =
                path.and_then(|p| std::fs::OpenOptions::new().append(true).create(true).open(p).ok());
            Log(file)
        }

        fn say(&mut self, msg: &str) {
            println!("{msg}");
            if let Some(f) = self.0.as_mut() {
                let _ = writeln!(f, "{msg}");
                let _ = f.flush();
            }
        }
    }

    /// Choose a log path that is actually WRITABLE, trying the requested path
    /// first and falling back.
    ///
    /// The first elevated run wrote nothing because the SYSTEM session-0 parent
    /// could not create the file under a user's `%TEMP%`, and a SYSTEM task has
    /// no console — so the failure was completely silent. This makes silence
    /// impossible: it probes each candidate by actually opening it, and returns
    /// the first that works. `C:\Users\Public` is reliably writable by SYSTEM
    /// and readable by the user, which the per-user temp is not.
    ///
    /// Determinism matters: the parent passes the CHOSEN path to the child via
    /// `--log`, so both converge on one file instead of re-picking separately.
    fn pick_log_path(requested: Option<&str>) -> Option<String> {
        let mut candidates: Vec<String> = Vec::new();
        if let Some(r) = requested {
            candidates.push(r.to_string());
        }
        candidates.push("C:\\Users\\Public\\s5-system.log".to_string());
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("s5-system.log").to_string_lossy().into_owned());
            }
        }
        candidates
            .into_iter()
            .find(|c| std::fs::OpenOptions::new().append(true).create(true).open(c).is_ok())
    }

    /// Is this process running as LocalSystem?
    ///
    /// Checked rather than assumed: the whole spike hinges on the privilege
    /// level, and mislabelling the run would invert the result.
    fn running_as_system() -> bool {
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut len = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut _),
                len,
                &mut len,
            )
            .is_ok();
            let mut is_system = false;
            if ok {
                let tu = &*(buf.as_ptr() as *const TOKEN_USER);
                let sid = tu.User.Sid;
                // S-1-5-18. Compare the last sub-authority rather than
                // string-formatting the SID. (Weak in general — only sound here
                // because 18 is unique as a final RID — so not a pattern to reuse.)
                let count = *windows::Win32::Security::GetSidSubAuthorityCount(sid);
                if count >= 1 {
                    let last =
                        *windows::Win32::Security::GetSidSubAuthority(sid, (count - 1) as u32);
                    is_system = last == SECURITY_LOCAL_SYSTEM_RID as u32;
                }
            }
            let _ = CloseHandle(token);
            is_system
        }
    }

    /// The session id this process runs in. 0 is the isolated service session.
    fn current_session() -> Option<u32> {
        unsafe {
            let mut sid = 0u32;
            ProcessIdToSessionId(GetCurrentProcessId(), &mut sid).ok()?;
            Some(sid)
        }
    }

    /// Enable a named privilege on our own process token.
    ///
    /// `CreateProcessAsUserW` consumes `SeAssignPrimaryTokenPrivilege` and
    /// `SeIncreaseQuotaPrivilege`, and checks them on the CALLING process. A
    /// real SYSTEM token HOLDS both, but whether a `schtasks /ru SYSTEM` token
    /// has them ENABLED is the one thing the research could not settle — so
    /// enable them defensively and report, rather than assume. Returns whether
    /// the privilege ended up actually enabled.
    fn enable_privilege(name: windows::core::PCWSTR) -> bool {
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                &mut token,
            )
            .is_err()
            {
                return false;
            }
            let mut luid = LUID::default();
            let found = LookupPrivilegeValueW(None, name, &mut luid).is_ok();
            let mut enabled = false;
            if found {
                let tp = TOKEN_PRIVILEGES {
                    PrivilegeCount: 1,
                    Privileges: [LUID_AND_ATTRIBUTES {
                        Luid: luid,
                        Attributes: SE_PRIVILEGE_ENABLED,
                    }],
                };
                let called = AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None).is_ok();
                // AdjustTokenPrivileges returns Ok even when it could not enable
                // a privilege the token does not hold; the truth is in the last
                // error, which is ERROR_NOT_ALL_ASSIGNED (1300) in that case.
                enabled = called
                    && windows::Win32::Foundation::GetLastError() == windows::Win32::Foundation::WIN32_ERROR(0);
            }
            let _ = CloseHandle(token);
            enabled
        }
    }

    /// If we are SYSTEM stuck in session 0, relaunch ourselves as SYSTEM in the
    /// interactive console session and return true (the caller must then exit).
    ///
    /// Returns false when no relaunch is needed or possible — the caller then
    /// runs the desktop loop directly. Every refusal is logged with its reason,
    /// because "the parent silently fell through and the loop failed on session
    /// 0" is the confusing outcome this whole path exists to prevent.
    fn relaunch_into_console_session(log: &mut Log, log_path: Option<&str>, seconds: u64) -> bool {
        let session = match current_session() {
            Some(s) => s,
            None => {
                log.say("[relaunch] could not determine current session; not relaunching");
                return false;
            }
        };
        log.say(&format!("[relaunch] current session = {session}, SYSTEM = {}", running_as_system()));

        // Only session 0 needs escaping. A SYSTEM process already interactive
        // (e.g. launched by psexec -s -i) is where we want to be.
        if session != 0 {
            return false;
        }
        if !running_as_system() {
            // An ordinary user in session 0 is not a real scenario, but never
            // try to cross sessions without the privilege to do it.
            return false;
        }

        let console = unsafe { WTSGetActiveConsoleSessionId() };
        if console == 0xFFFF_FFFF {
            log.say(
                "[relaunch] WTSGetActiveConsoleSessionId = 0xFFFFFFFF: no console session \
                 attached (nobody logged in at the physical console). Cannot relaunch; the \
                 session-0 run below will not see any desktop.",
            );
            return false;
        }
        if console == 0 || console == session {
            log.say(&format!(
                "[relaunch] console session = {console}: no separate interactive session to \
                 relaunch into (headless or console IS session 0)."
            ));
            return false;
        }
        log.say(&format!("[relaunch] active console session = {console}; relaunching there"));

        // Enable the two privileges CreateProcessAsUserW needs. Report if either
        // could not be enabled — that is itself the finding if the relaunch then
        // fails.
        let p1 = enable_privilege(SE_ASSIGNPRIMARYTOKEN_NAME);
        let p2 = enable_privilege(SE_INCREASE_QUOTA_NAME);
        if !p1 || !p2 {
            log.say(&format!(
                "[relaunch] WARNING: privilege enable — SeAssignPrimaryToken={p1}, \
                 SeIncreaseQuota={p2}. If CreateProcessAsUser fails below, this is why."
            ));
        }

        unsafe {
            let mut src = HANDLE::default();
            if let Err(e) = OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
                &mut src,
            ) {
                log.say(&format!("[relaunch] OpenProcessToken failed: {e}"));
                return false;
            }

            let mut dup = HANDLE::default();
            let dup_ok = DuplicateTokenEx(
                src,
                TOKEN_ACCESS_MASK(MAXIMUM_ALLOWED),
                None,
                SecurityImpersonation,
                TokenPrimary,
                &mut dup,
            );
            if let Err(e) = dup_ok {
                log.say(&format!("[relaunch] DuplicateTokenEx failed: {e}"));
                let _ = CloseHandle(src);
                return false;
            }

            // Retarget the primary token at the console session. Needs
            // SeTcbPrivilege (a genuine SYSTEM token has it) and
            // TOKEN_ADJUST_SESSIONID on the duplicate (granted by MAXIMUM_ALLOWED).
            let sid = console;
            if let Err(e) = SetTokenInformation(
                dup,
                TokenSessionId,
                &sid as *const u32 as *const core::ffi::c_void,
                core::mem::size_of::<u32>() as u32,
            ) {
                log.say(&format!(
                    "[relaunch] SetTokenInformation(TokenSessionId={sid}) failed: {e} \
                     (SeTcbPrivilege missing?)"
                ));
                let _ = CloseHandle(dup);
                let _ = CloseHandle(src);
                return false;
            }

            // Child command line. current_exe(), the same log path, the same
            // duration, plus the recursion guard.
            let exe = match std::env::current_exe() {
                Ok(p) => p,
                Err(e) => {
                    log.say(&format!("[relaunch] current_exe failed: {e}"));
                    let _ = CloseHandle(dup);
                    let _ = CloseHandle(src);
                    return false;
                }
            };
            let mut cmd = format!("\"{}\" {RELAUNCH_FLAG} --seconds {seconds}", exe.display());
            if let Some(p) = log_path {
                cmd.push_str(&format!(" --log \"{p}\""));
            }
            let mut cmd_w: Vec<u16> = cmd.encode_utf16().chain(std::iter::once(0)).collect();

            // Run the child on the interactive desktop. This is the line the
            // whole spike turns on.
            let mut desktop: Vec<u16> =
                "winsta0\\default".encode_utf16().chain(std::iter::once(0)).collect();
            let mut si = STARTUPINFOW::default();
            si.cb = core::mem::size_of::<STARTUPINFOW>() as u32;
            si.lpDesktop = PWSTR(desktop.as_mut_ptr());
            let mut pi = PROCESS_INFORMATION::default();

            let created = CreateProcessAsUserW(
                dup,
                None,
                PWSTR(cmd_w.as_mut_ptr()),
                None,
                None,
                false,
                CREATE_NO_WINDOW,
                None,
                None,
                &si,
                &mut pi,
            );

            let relaunched = match created {
                Ok(()) => {
                    log.say(&format!(
                        "[relaunch] CreateProcessAsUser OK: child pid {} in session {console}. \
                         Waiting for it so the task lifetime covers the child.",
                        pi.dwProcessId
                    ));
                    // Wait, bounded, so the scheduled task stays alive until the
                    // child's log is complete — then a caller's Get-Content sees
                    // the decisive lines rather than racing them.
                    let _ = WaitForSingleObject(pi.hProcess, ((seconds + 12) * 1000) as u32);
                    let _ = CloseHandle(pi.hProcess);
                    let _ = CloseHandle(pi.hThread);
                    log.say("[relaunch] child finished; parent exiting");
                    true
                }
                Err(e) => {
                    log.say(&format!("[relaunch] CreateProcessAsUser failed: {e}"));
                    false
                }
            };

            let _ = CloseHandle(dup);
            let _ = CloseHandle(src);
            relaunched
        }
    }

    /// Name of the desktop currently receiving input ("Default", "Winlogon", ...).
    fn input_desktop_name() -> Result<(HDESK, String), String> {
        unsafe {
            // 0x0001 READOBJECTS + 0x0002 CREATEWINDOW + 0x0100 SWITCHDESKTOP.
            // READOBJECTS is added on the research's advice for the read/capture
            // path — cheap, and it is NOT the cause of the session-0 failure.
            let desk = OpenInputDesktop(
                DESKTOP_CONTROL_FLAGS(0),
                false,
                DESKTOP_ACCESS_FLAGS(0x0001 | 0x0002 | 0x0100),
            )
            .map_err(|e| format!("OpenInputDesktop failed: {e}"))?;
            let mut buf = [0u16; 256];
            let mut needed = 0u32;
            GetUserObjectInformationW(
                windows::Win32::Foundation::HANDLE(desk.0),
                UOI_NAME,
                Some(buf.as_mut_ptr() as *mut _),
                (buf.len() * 2) as u32,
                Some(&mut needed),
            )
            .map_err(|e| format!("GetUserObjectInformationW failed: {e}"))?;
            let name = String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string();
            Ok((desk, name))
        }
    }

    /// One capture of the current thread's desktop.
    struct Shot {
        w: u32,
        h: u32,
        /// Whether the sampled strip has any pixel variation. A uniform buffer —
        /// including an all-black one a driver may return for the secure desktop
        /// — reads as false.
        varies: bool,
        /// FNV-1a of the sampled strip, so two captures can be compared. Used to
        /// catch a driver returning a STALE previous-desktop frame: if the
        /// Winlogon strip is byte-identical to the last Default strip, "varies"
        /// is not evidence the secure UI was actually seen.
        hash: u64,
    }

    fn fnv1a(bytes: &[u8]) -> u64 {
        let mut h = 0xcbf2_9ce4_8422_2325u64;
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }

    /// Capture a horizontal strip across the CENTRE of the screen with GDI.
    ///
    /// Centre, not the top: a UAC consent dialog is centred, and the original
    /// spike sampled the top 64 rows — which on the secure desktop is a uniform
    /// dim field, so a perfectly good BitBlt reported `varies=false`. The centre
    /// strip is where the dialog's pixels actually are.
    ///
    /// GDI rather than DXGI, on a premise that turned out to be FALSE.
    ///
    /// This said "duplication cannot touch the secure desktop at all". It was
    /// never tested — and `probe_dxgi` above, added to test it, showed a SYSTEM
    /// process attached to Winlogon duplicating a live UAC prompt at full
    /// resolution. The BitBlt path is kept because it is a second, independent
    /// witness on the same question, and two disagreeing methods would be worth
    /// knowing about; it is no longer the only option believed to exist.
    /// THE QUESTION THIS SPIKE EXISTS TO ANSWER NOW.
    ///
    /// The comment below `capture_centre_strip` asserts that "duplication
    /// cannot touch the secure desktop at all", and `puca-capture` repeats
    /// it as fact. NOBODY EVER TESTED IT. If it is wrong, the shipping DXGI
    /// path works on Winlogon and the login-screen feature is a week of
    /// plumbing; if it is right, the whole capture stack needs a GDI fallback
    /// backend, which is a different and much larger project.
    ///
    /// Uses the real `puca_capture::ScreenCapture` rather than a
    /// hand-rolled duplication, because a bespoke probe that succeeded where
    /// the shipping code fails would send the design down the wrong road.
    fn probe_dxgi() -> String {
        match puca_capture::ScreenCapture::new(0) {
            Err(e) => format!("DuplicateOutput REFUSED: {e:?}"),
            Ok(mut cap) => {
                // MORE THAN ONE FRAME, and report a COUNT rather than a
                // boolean. DXGI's first frame after DuplicateOutput is
                // routinely empty — it accumulates CHANGES, so a static screen
                // yields a blank frame or a timeout. Reporting that as
                // "uniform" would make a perfectly working capture on Default
                // indistinguishable from a genuinely black Winlogon, which is
                // exactly the false negative that would send this design the
                // wrong way. Five attempts over ~5s: on any live desktop the
                // clock alone changes within that.
                let mut best = 0usize;
                let mut got = 0;
                let mut dims = (0u32, 0u32);
                let mut last_err = String::from("no attempt made");
                for attempt in 1..=5 {
                    match cap.next_frame(1000) {
                        Ok(f) => {
                            got = attempt;
                            dims = (f.width, f.height);
                            let mut seen = std::collections::HashSet::new();
                            for px in f.bgra.chunks_exact(4).step_by(997).take(8192) {
                                seen.insert([px[0], px[1], px[2]]);
                            }
                            best = best.max(seen.len());
                            if best > 8 {
                                break;
                            }
                        }
                        Err(e) => last_err = format!("{e:?}"),
                    }
                }
                if got == 0 {
                    return format!("opened, but NO FRAME in 5 attempts: {last_err}");
                }
                format!(
                    "CAPTURED {}x{} (first frame on attempt {got}), distinct_colours={best} -> {}",
                    dims.0,
                    dims.1,
                    if best > 8 { "REAL PIXELS" } else { "UNIFORM/BLACK - suspect" }
                )
            }
        }
    }

    /// Does injected input reach this desktop?
    ///
    /// A ONE-PIXEL relative mouse move: small enough that it cannot answer a
    /// dialog or otherwise act on whatever is under the cursor, but a REAL
    /// SendInput call, which a zero-distance move never was.
    ///
    /// THIS PROBE USED TO SEND `Rmove { dx: 0.0, dy: 0.0 }`, and every result it
    /// ever reported was worthless. `puca_input::inject`'s `Rmove` handler
    /// splits the delta into `<=4000px` steps with `while dx != 0 || dy != 0 {
    /// ... }` — for a zero delta that loop body never runs, so `SendInput` is
    /// never called at all, and the function returns `Ok(())` unconditionally
    /// regardless of which desktop the thread is attached to. The doc comment
    /// that used to sit here claimed "it is inserted or refused exactly like
    /// any other event" and was wrong: a probe that cannot fail measured
    /// nothing, and the "SendInput accepted on Winlogon" claim this spike
    /// produced was carried into `puca-input/src/desktop.rs`'s own header
    /// as a real measurement. It was not one.
    ///
    /// Goes through `puca_input::inject`, which as of the secure-desktop
    /// fixes returns an error when SendInput reports zero.
    fn probe_input() -> String {
        match puca_input::inject(puca_input::ControlInput::Rmove { dx: 1.0, dy: 0.0 }) {
            Ok(()) => "SendInput ACCEPTED (a 1px move was inserted)".to_string(),
            Err(e) => format!("SendInput REFUSED: {e}"),
        }
    }

    fn capture_centre_strip() -> Result<Shot, String> {
        unsafe {
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            if w <= 0 || h <= 0 {
                return Err("no screen metrics on this desktop".into());
            }
            let strip = h.min(96);
            let src_y = (h - strip) / 2;

            let screen = GetDC(HWND(std::ptr::null_mut()));
            if screen.is_invalid() {
                return Err("GetDC failed".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, strip);
            let old = SelectObject(mem, bmp);

            // Copy only the centre strip straight from the screen DC.
            let blt = BitBlt(mem, 0, 0, w, strip, screen, 0, src_y, SRCCOPY);

            let mut bits = vec![0u8; (w * strip * 4) as usize];
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -strip, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let got = GetDIBits(
                mem,
                bmp,
                0,
                strip as u32,
                Some(bits.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            );

            SelectObject(mem, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(mem);
            ReleaseDC(HWND(std::ptr::null_mut()), screen);

            if blt.is_err() {
                return Err("BitBlt failed".into());
            }
            // Require ALL requested rows: a partial fill leaves zero-initialised
            // tail rows that read as variation, a false positive.
            if got as i32 != strip {
                return Err(format!("GetDIBits filled {got}/{strip} rows"));
            }
            let first = &bits[..4];
            let varies = bits.chunks_exact(4).any(|px| px != first);
            Ok(Shot { w: w as u32, h: h as u32, varies, hash: fnv1a(&bits) })
        }
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        let relaunched = args.iter().any(|a| a == RELAUNCH_FLAG);
        let requested_log = args
            .iter()
            .position(|a| a == "--log")
            .and_then(|i| args.get(i + 1))
            .cloned();
        // Resolve to a path we can actually write, so a SYSTEM parent that can't
        // touch the requested location falls back instead of failing silently.
        let log_path = pick_log_path(requested_log.as_deref());
        // Default 60s: a human needs time to trigger a UAC prompt, and a window
        // that expires first produces a "no result" run that reads as failure.
        let seconds: u64 = args
            .iter()
            .position(|a| a == "--seconds")
            .and_then(|i| args.get(i + 1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);

        // Truncate ONCE, and only the parent, before anyone writes. From here
        // on both processes append (see `Log::open`), so neither can clobber the
        // other's lines regardless of who writes when.
        if !relaunched {
            if let Some(p) = log_path.as_deref() {
                let _ = std::fs::File::create(p);
            }
        }
        let mut log = Log::open(log_path.as_deref());

        if !relaunched {
            log.say("=== SPIKE S5: desktop following ===");
            log.say(&format!(
                "log path: {} (requested: {})",
                log_path.as_deref().unwrap_or("<NONE WRITABLE>"),
                requested_log.as_deref().unwrap_or("<none>"),
            ));
            if relaunch_into_console_session(&mut log, log_path.as_deref(), seconds) {
                // The child does the real work and appended it below this line.
                return;
            }
            log.say("[relaunch] proceeding in THIS process (no relaunch performed)");
        } else {
            log.say("\n=== SPIKE S5 (child, interactive session) ===");
            log.say(&format!("log path: {}", log_path.as_deref().unwrap_or("<NONE WRITABLE>")));
        }

        let system = running_as_system();
        let session = current_session();
        log.say(&format!(
            "running as SYSTEM: {}   session: {}   (the comparison IS the result)",
            if system { "YES" } else { "no - ordinary user" },
            session.map(|s| s.to_string()).unwrap_or_else(|| "?".into()),
        ));
        log.say(&format!(
            "Trigger a UAC prompt now if you can; watching for {seconds}s.\n"
        ));

        let mut last_name = String::new();
        let mut seen_winlogon = false;
        let mut winlogon_attached = false;
        let mut winlogon_pixels = false;
        let mut winlogon_uniform = false;
        let mut winlogon_stale_suspect = false;
        // Hash of the most recent Default-desktop capture, to catch a driver
        // handing back a stale Default frame while we believe we are on Winlogon.
        let mut last_default_hash: Option<u64> = None;
        let deadline = Instant::now() + Duration::from_secs(seconds);

        while Instant::now() < deadline {
            match input_desktop_name() {
                Ok((desk, name)) => {
                    if name != last_name {
                        log.say(&format!("[desktop] input desktop is now: {name}"));
                        last_name = name.clone();
                        let is_winlogon = name.eq_ignore_ascii_case("Winlogon");
                        if is_winlogon {
                            seen_winlogon = true;
                        }

                        // SetThreadDesktop must run on a thread owning no windows
                        // or hooks. This thread has none, which is why the real
                        // service will need a FRESH thread per switch.
                        unsafe {
                            match SetThreadDesktop(desk) {
                                Ok(()) => {
                                    log.say(&format!("[desktop]   SetThreadDesktop({name}) OK"));
                                    if is_winlogon {
                                        winlogon_attached = true;
                                    }
                                    match capture_centre_strip() {
                                        Ok(shot) => {
                                            log.say(&format!(
                                                "[desktop]   capture {}x{} varied_pixels={}",
                                                shot.w, shot.h, shot.varies
                                            ));
                                            if is_winlogon {
                                                if shot.varies {
                                                    winlogon_pixels = true;
                                                    if Some(shot.hash) == last_default_hash {
                                                        winlogon_stale_suspect = true;
                                                        log.say(
                                                            "[desktop]   NOTE: Winlogon strip is \
                                                             byte-identical to the last Default \
                                                             strip — possible STALE frame, treat \
                                                             'varies' with suspicion",
                                                        );
                                                    }
                                                } else {
                                                    winlogon_uniform = true;
                                                    log.say(
                                                        "[desktop]   NOTE: attached to Winlogon \
                                                         and BitBlt succeeded, but the strip is \
                                                         UNIFORM (blank or driver-black)",
                                                    );
                                                }
                                            } else if name.eq_ignore_ascii_case("Default") {
                                                last_default_hash = Some(shot.hash);
                                            }
                                        }
                                        Err(e) => {
                                            log.say(&format!("[desktop]   capture FAILED: {e}"))
                                        }
                                    }
                                    // Both probes run on EVERY desktop, so the
                                    // Default-desktop result is the positive
                                    // control: "refused on Winlogon" only means
                                    // something if the same call succeeded on
                                    // Default moments earlier.
                                    log.say(&format!("[dxgi ]   {}", probe_dxgi()));
                                    log.say(&format!("[input]   {}", probe_input()));
                                }
                                Err(e) => log.say(&format!(
                                    "[desktop]   SetThreadDesktop({name}) FAILED: {e}"
                                )),
                            }
                        }
                    }
                    unsafe {
                        let _ = CloseDesktop(desk);
                    }
                }
                Err(e) => {
                    if last_name != "<denied>" {
                        log.say(&format!("[desktop] OpenInputDesktop denied: {e}"));
                        last_name = "<denied>".to_string();
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }

        log.say("\n=== RESULT ===");
        log.say(&format!("ran as SYSTEM ............ {system}"));
        log.say(&format!(
            "in interactive session .. {}",
            session.map(|s| s != 0).unwrap_or(false)
        ));
        log.say(&format!("saw the Winlogon desktop . {seen_winlogon}"));
        log.say(&format!("attached to Winlogon ..... {winlogon_attached}"));
        log.say(&format!("captured Winlogon pixels . {winlogon_pixels}"));
        if winlogon_uniform {
            log.say("  (capture succeeded but returned a UNIFORM/black strip)");
        }
        if winlogon_stale_suspect {
            log.say("  (WARNING: the 'varies' frame may be a stale Default capture)");
        }

        // The load-bearing distinction: "never got onto Winlogon" (a relaunch or
        // trigger problem) vs "got onto Winlogon but no usable pixels" (the real
        // secure-desktop-capture finding that makes Phase 8 expensive).
        if session == Some(0) {
            log.say(
                "\nStill in SESSION 0 — the relaunch did not happen (see [relaunch] lines\n\
                 above for why). OpenInputDesktop cannot work here; fix the relaunch\n\
                 precondition and re-run. This is NOT the capture finding.",
            );
        } else if !seen_winlogon {
            log.say(
                "\nNo Winlogon switch observed, so the decisive case was never exercised.\n\
                 Either no UAC prompt fired during the window, or the secure desktop is\n\
                 disabled by policy (PromptOnSecureDesktop=0) and the prompt rendered on\n\
                 Default. Re-run, confirm the policy, and trigger an elevation.",
            );
        } else if winlogon_attached && winlogon_pixels && !winlogon_stale_suspect {
            log.say(
                "\nDESKTOP FOLLOWING WORKS at this privilege level: the switch was\n\
                 detected, the thread re-attached, and the secure desktop yielded real,\n\
                 non-stale pixels. Phase 8 is a sprint, not a quarter.",
            );
        } else {
            log.say(
                "\nReached Winlogon but did NOT get usable pixels (uniform/black, stale,\n\
                 or attach failed). Session isolation is SOLVED; secure-desktop CAPTURE is\n\
                 the remaining Phase 8 cost, exactly the finding that makes it expensive.",
            );
        }
    }
}
