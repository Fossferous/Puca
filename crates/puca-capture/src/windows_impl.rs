//! DXGI Desktop Duplication.
//!
//! The flow, and the parts that are easy to get subtly wrong:
//!
//!  1. Create a D3D11 device, find the adapter output for the wanted monitor,
//!     and `DuplicateOutput` it.
//!  2. `AcquireNextFrame` gives a GPU texture. It CANNOT be read directly — it
//!     lives in GPU memory with no CPU access — so it is copied into a STAGING
//!     texture and mapped. Forgetting the staging copy is the usual first
//!     failure, and it presents as a cryptic E_INVALIDARG from Map.
//!  3. `ReleaseFrame` must be called for every successful acquire, or the next
//!     acquire fails forever. It is easy to leak on an early return, so the
//!     release here happens on every path.

use super::{CaptureError, Frame, OutputInfo, Rotation};
use windows::core::Interface;
use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT,
    DXGI_MODE_ROTATION, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource,
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, DXGI_ERROR_SESSION_DISCONNECTED,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME,
};

pub struct ScreenCapture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: Option<IDXGIOutputDuplication>,
    monitor: usize,
    /// What must be undone to put the captured surface into desktop
    /// orientation. Read once at open: a display cannot rotate without the
    /// duplication being lost and rebuilt.
    rotation: Rotation,
    /// Reused between frames — allocating a staging texture per frame is a
    /// GPU allocation 30 times a second for no reason.
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    /// The host's real mouse pointer, which DXGI deliberately leaves OUT of the
    /// captured surface and reports separately.
    cursor: CursorState,
    /// Whether that pointer is blended back in. Off while a controller owns
    /// the cursor and draws its own — see set_draw_cursor.
    draw_cursor: bool,
}

/// The pointer as DXGI last described it.
///
/// Every field is STICKY on purpose. DXGI reports the shape only when it
/// changes and the position only when it moves, so a frame that says nothing
/// about the pointer means "unchanged", not "no pointer" — clearing this on
/// such a frame makes the cursor flicker at exactly the moment the user stops
/// moving it and looks at where it is.
#[derive(Default)]
struct CursorState {
    /// Raw shape bytes, whose meaning depends on `kind`.
    shape: Vec<u8>,
    width: u32,
    /// For a monochrome cursor this is the height of BOTH stacked masks; the
    /// drawn cursor is half as tall.
    height: u32,
    pitch: u32,
    kind: u32,
    /// Top-left of the shape in the captured surface's own coordinates. This is
    /// NOT the hotspot: DXGI already accounts for it, and subtracting it again
    /// shifts every cursor up and left by its own hotspot.
    x: i32,
    y: i32,
    visible: bool,
}

/// Open a duplication for `monitor` on WHICHEVER adapter can actually do it.
///
/// WHY THIS IS NOT SIMPLY "THE ADAPTER THAT OWNS THE OUTPUT". On a machine with
/// two GPUs, Windows lets a user pin an application to one of them — Settings ->
/// Display -> Graphics, or `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`,
/// where `GpuPreference=1` means "power saving", the integrated GPU. That
/// preference changes what DXGI enumerates INSIDE THAT PROCESS: the preferred
/// adapter comes first and lists the monitors, even though it is not the GPU
/// driving them.
///
/// Desktop duplication only works on the GPU actually driving the display, so
/// in a pinned process the first adapter to claim a monitor is exactly the one
/// that cannot duplicate it, and every monitor fails with
/// `DXGI_ERROR_UNSUPPORTED` (0x887A0004). Measured on the reporter's machine on
/// 2026-09-09: Puca pinned to "power saving", all three monitors refused, and
/// the error named `AMD Radeon(TM) Graphics` while the displays are driven by
/// the discrete card.
///
/// So: try every adapter that exposes this monitor, matched by HMONITOR rather
/// than by index (indices are per-walk and differ between adapters), and take
/// the first that duplicates. An explicit adapter is always usable regardless
/// of the preference — the preference only picks the DEFAULT.
fn open_duplication(
    monitor: usize,
) -> Result<(ID3D11Device, ID3D11DeviceContext, IDXGIOutputDuplication, String), CaptureError> {
    let target = outputs()
        .into_iter()
        .find(|o| o.index == monitor)
        .map(|o| o.hmonitor)
        .ok_or_else(|| CaptureError::Failed(format!("no monitor at index {monitor}")))?;

    let mut refused: Vec<String> = Vec::new();
    // Every adapter the walk SAW, refusal or not. Without this the failure
    // message can only describe adapters that got as far as being asked, and
    // the most confusing case — nothing exposes this monitor at all — read
    // "tried 0: " with an empty list.
    let mut enumerated: Vec<String> = Vec::new();
    let mut transient = false;
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()
            .map_err(|e| CaptureError::Failed(format!("CreateDXGIFactory1 failed: {e}")))?;
        let mut adapter_index = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
            adapter_index += 1;
            let name = adapter
                .GetDesc1()
                .map(|d| String::from_utf16_lossy(&d.Description).trim_end_matches('\0').trim().to_string())
                .unwrap_or_else(|_| "<unnamed adapter>".to_string());
            enumerated.push(name.clone());

            let mut output_index = 0u32;
            while let Ok(output) = adapter.EnumOutputs(output_index) {
                output_index += 1;
                let is_target = output
                    .GetDesc()
                    .map(|d| d.Monitor.0 as isize == target)
                    .unwrap_or(false);
                if !is_target {
                    continue;
                }
                let Ok(output1) = output.cast::<IDXGIOutput1>() else {
                    refused.push(format!("{name}: no IDXGIOutput1"));
                    continue;
                };
                // D3D_DRIVER_TYPE_UNKNOWN is REQUIRED with an explicit adapter;
                // HARDWARE with a non-null adapter is E_INVALIDARG.
                let mut device: Option<ID3D11Device> = None;
                let mut context: Option<ID3D11DeviceContext> = None;
                let hr = D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    None,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                );
                let (Some(()), Some(device), Some(context)) = (hr.ok(), device, context) else {
                    refused.push(format!("{name}: no D3D11 device"));
                    continue;
                };
                match output1.DuplicateOutput(&device) {
                    Ok(dup) => return Ok((device, context, dup, name)),
                    Err(e) if e.code() == E_ACCESSDENIED || is_transient_display_state(e.code()) => {
                        // The secure desktop, a sleeping panel, or another
                        // duplication of this output. Not this adapter's fault
                        // and not a reason to try a different GPU — remember it
                        // so the caller still gets AccessLost rather than a
                        // hard failure naming every adapter.
                        transient = true;
                        refused.push(format!("{name}: {e}"));
                    }
                    Err(e) => refused.push(format!("{name}: {e}")),
                }
            }
        }
    }
    if transient {
        return Err(CaptureError::AccessLost);
    }
    if refused.is_empty() {
        // NOT ONE adapter exposed this monitor — yet `outputs()` listed it a
        // moment ago, from this same enumeration. The topology changed between
        // the two walks: the panel went to sleep, or a link detached. That is
        // "not right now", so it must surface as AccessLost and let the
        // caller's retry loop wake it, exactly as a mid-session loss does.
        //
        // A monitor that is permanently gone cannot reach here: the lookup at
        // the top of this function fails first with "no monitor at index N",
        // which keeps this from becoming a forever-retry.
        return Err(CaptureError::AccessLost);
    }
    Err(CaptureError::Failed(format!(
        "no adapter could duplicate monitor {monitor} — refused by {}: {} (adapters seen: {})",
        refused.len(),
        refused.join("; "),
        enumerated.join(", ")
    )))
}

/// Visit every output across every adapter, in the ONE order this crate calls
/// the monitor index.
///
/// Factored out because it used to be written three times — `duplicate`,
/// `monitor_count`, and (in the agent) a GDI walk standing in for it. Three
/// copies of an enumeration is three chances for them to disagree about which
/// screen index N is, and they did.
///
/// `f` returning `Some` stops the walk and yields that value.
unsafe fn each_output<T>(
    mut f: impl FnMut(usize, &windows::Win32::Graphics::Dxgi::IDXGIOutput) -> Option<T>,
) -> Option<T> {
    let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
    let mut seen = 0usize;
    let mut adapter_index = 0u32;
    // Walk adapters AND their outputs: monitor N is not adapter N. A two-GPU
    // machine with one screen each would otherwise capture the wrong screen, or
    // nothing.
    while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
        let mut output_index = 0u32;
        while let Ok(output) = adapter.EnumOutputs(output_index) {
            if let Some(v) = f(seen, &output) {
                return Some(v);
            }
            seen += 1;
            output_index += 1;
        }
        adapter_index += 1;
    }
    None
}

/// Every capturable output with its desktop rectangle, in capture-index order.
///
/// The geometry comes from `DXGI_OUTPUT_DESC`, so it is the rectangle belonging
/// to the very output `ScreenCapture::new(index)` duplicates — not a same-named
/// entry from a different enumeration. That identity is the whole point: it is
/// what lets injected input be aimed at the screen actually being captured.
///
/// `index` is the position in the WALK, not in the returned vector: an output
/// whose description cannot be read is omitted rather than renumbering the ones
/// after it. Look entries up by `OutputInfo::index`, never by position — this
/// list can have gaps, and quietly closing them would recreate the very
/// off-by-one-screen bug this type exists to prevent.
pub fn outputs() -> Vec<OutputInfo> {
    let mut out = Vec::new();
    unsafe {
        each_output::<()>(|index, output| {
            if let Ok(desc) = output.GetDesc() {
                let r = desc.DesktopCoordinates;
                out.push(OutputInfo {
                    index,
                    left: r.left,
                    top: r.top,
                    width: r.right - r.left,
                    height: r.bottom - r.top,
                    hmonitor: desc.Monitor.0 as isize,
                    rotation: rotation_from_dxgi(desc.Rotation),
                });
            }
            None
        });
    }
    out
}

/// Re-duplicate `monitor` on a device we ALREADY have, creating nothing.
///
/// WHY THIS EXISTS, given `open_duplication` does a better job. A rebuild is
/// not rare: `next_frame` drops the duplication on every ACCESS_LOST, and a
/// locked screen or a sleeping panel returns ACCESS_LOST on EVERY tick for as
/// long as it lasts. Clips stay armed for hours precisely while nobody is at
/// the desk, so "the whole walk, every tick" is the common case, not the edge
/// one — at 60 fps that is a DXGI factory, a full adapter enumeration and a
/// fresh `D3D11CreateDevice` sixty times a second, thrown away each time,
/// where the code this replaced created no device at all.
///
/// So: try the device in hand first. The monitor is still matched by HMONITOR
/// (never by walk position), and a cross-adapter attempt is CHEAP to fail —
/// DXGI answers immediately without allocating. Only a real adapter change
/// falls through to the walk.
fn reduplicate_on(
    device: &ID3D11Device,
    monitor: usize,
) -> Result<IDXGIOutputDuplication, CaptureError> {
    let target = outputs()
        .into_iter()
        .find(|o| o.index == monitor)
        .map(|o| o.hmonitor)
        .ok_or_else(|| CaptureError::Failed(format!("no monitor at index {monitor}")))?;
    unsafe {
        let found = each_output(|_, output| {
            let is_target = output
                .GetDesc()
                .map(|d| d.Monitor.0 as isize == target)
                .unwrap_or(false);
            if !is_target {
                return None;
            }
            Some(output.cast::<IDXGIOutput1>())
        });
        match found {
            Some(Ok(output1)) => output1.DuplicateOutput(device).map_err(|e| {
                if e.code() == E_ACCESSDENIED || is_transient_display_state(e.code()) {
                    // The secure desktop, a sleeping panel, or another
                    // duplication of this output. Nothing about a different
                    // GPU would help, so this must NOT fall through to the
                    // walk — that is the allocation storm this avoids.
                    CaptureError::AccessLost
                } else {
                    // Anything else (a cross-adapter DXGI_ERROR_UNSUPPORTED
                    // after a MUX switch, say) means this device is the wrong
                    // one for this screen. The caller re-opens properly.
                    CaptureError::Failed(format!("re-duplicate on held device failed: {e}"))
                }
            }),
            // No IDXGIOutput1, or the monitor is not in this walk any more.
            // Both are the caller's cue to do the full walk, which decides
            // between "gone for now" and "gone for good".
            _ => Err(CaptureError::Failed(format!(
                "monitor {monitor} not duplicable on the held device"
            ))),
        }
    }
}

// `duplicate(device, monitor)` LIVED HERE and is deliberately gone. It resolved
// a monitor by its position in the output walk and duplicated it against a
// device it was handed, which made it a second, disagreeing answer to "which
// screen is N, and which GPU drives it". `open_duplication` is the only answer
// now; see the rebuild in `next_frame`.

/// Display-state HRESULTs that mean "not right now", not "never": the output
/// is asleep, detaching, or the session is disconnected. Deliberately NOT
/// including DXGI_ERROR_DEVICE_REMOVED/RESET — those kill the ID3D11Device
/// itself, which re-duplicating the same device can never recover — and NOT
/// DXGI_ERROR_UNSUPPORTED either: on some hybrid-GPU configurations that is
/// a PERMANENT capability verdict, and classing it transient would turn an
/// honest "this machine cannot duplicate that output" into a silent
/// forever-retry mid-session. (At session START the open-retry loop retries
/// every error kind for its bounded window regardless, so a sleeping panel
/// that surfaces UNSUPPORTED at open still gets its wake-and-retry.)
fn is_transient_display_state(code: windows::core::HRESULT) -> bool {
    code == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
        || code == DXGI_ERROR_SESSION_DISCONNECTED
        // DXGI_ERROR_INVALID_CALL. Documented as "AcquireNextFrame was called
        // without releasing the previous frame", which reads like a bug in the
        // caller — and this caller releases on every path out, verified by
        // reading them all. In the field it also appears when a duplication is
        // left in a state the driver will not serve: observed here around
        // secure-desktop switches and display changes.
        //
        // Whatever the cause, ENDING THE SESSION IS THE WRONG ANSWER, and that
        // is what it did — seven times in one log, each one a remote session
        // that stopped and did not come back, where a freeze would at least
        // have recovered. A duplication in a bad state is exactly what the
        // rebuild path exists for. If it is genuinely unrecoverable the rebuild
        // fails and the session ends anyway, one tick later, with a better
        // message; nothing is lost by trying.
        || code == windows::core::HRESULT(0x887A0001u32 as i32)
}

impl ScreenCapture {
    /// Start capturing `monitor` (0 = the first enumerated output).
    pub fn new(monitor: usize) -> Result<Self, CaptureError> {
        // The error this returns names every adapter it tried and why each
        // refused: this crate deliberately has no logging dependency, and when
        // duplication fails the first question is always which GPU was asked.
        let (device, context, duplication, _adapter) = open_duplication(monitor)?;
        let rotation = rotation_of(monitor);
        Ok(Self {
            device,
            context,
            duplication: Some(duplication),
            monitor,
            rotation,
            staging: None,
            // SEEDED, not empty: DXGI only reports the shape on CHANGE, so an
            // empty start meant no pointer in any frame until the host's own
            // mouse moved — "invisible but still working" after every capture
            // rebuild (file browser detour, lock/unlock, monitor switch).
            // Failure falls back to the old empty state.
            cursor: seed_cursor(monitor),
            // ON unless a controller takes ownership: every other consumer of
            // a captured frame (a viewer that draws no cursor of its own, a
            // still grab) expects to see the pointer.
            draw_cursor: true,
        })
    }

    /// Whether the host's own pointer is blended into captured frames.
    ///
    /// A controller that draws the cursor LOCALLY — from the same coordinates
    /// that drive its camera — gets a pointer that moves in lockstep with the
    /// finger, because both come from one source with no round trip between
    /// them. That is only true if exactly one cursor is on screen, so the
    /// controller asks the host to stop drawing its own first. The default
    /// stays ON: a host that is never asked behaves exactly as before.
    pub fn set_draw_cursor(&mut self, on: bool) {
        self.draw_cursor = on;
    }

    /// How many outputs are available across all adapters.
    ///
    /// Counts the WALK, over the same iterator `duplicate` indexes — deliberately
    /// not `outputs().len()`, which omits any output whose description could not
    /// be read and would therefore report a count smaller than the largest index
    /// that actually captures.
    pub fn monitor_count() -> usize {
        let mut count = 0usize;
        unsafe {
            each_output::<()>(|index, _| {
                count = index + 1;
                None
            });
        }
        count
    }

    /// Ensure a staging texture matching `desc`, reusing the existing one.
    fn staging_for(&mut self, desc: &D3D11_TEXTURE2D_DESC) -> Result<ID3D11Texture2D, CaptureError> {
        if let Some((tex, w, h)) = &self.staging {
            if *w == desc.Width && *h == desc.Height {
                return Ok(tex.clone());
            }
        }
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: desc.Width,
            Height: desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            // STAGING + CPU_ACCESS_READ is the whole point: the acquired
            // texture is GPU-only and cannot be mapped.
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe {
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut tex))
                .map_err(|e| CaptureError::Failed(format!("staging texture failed: {e}")))?;
        }
        let tex = tex.ok_or_else(|| CaptureError::Failed("no staging texture".into()))?;
        self.staging = Some((tex.clone(), desc.Width, desc.Height));
        Ok(tex)
    }

    /// Grab the next frame, waiting up to `timeout_ms` for the screen to change.
    ///
    /// `Timeout` means nothing moved — repeat the previous frame rather than
    /// treating it as a failure. `AccessLost` means the desktop changed; the
    /// duplication is dropped here and rebuilt on the next call, which is what
    /// makes alt-tabbing into a fullscreen game survivable.
    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<Frame, CaptureError> {
        if self.duplication.is_none() {
            // REBUILD THE WAY THE OPEN DID, ADAPTER AND ALL.
            //
            // This used to call a helper that found the output by its position
            // in the walk and duplicated it against the device already held.
            // Both halves of that are wrong once two GPUs are in play, which is
            // the whole reason `open_duplication` exists:
            //
            //   - position vs HMONITOR. The open matches the monitor by its
            //     HMONITOR; a walk index is not the same key, and `outputs()`
            //     is documented to have gaps. The two can name DIFFERENT
            //     screens, so a rebuild could silently start capturing another
            //     one mid-session.
            //   - the device. The open deliberately lands on whichever adapter
            //     can actually duplicate this monitor. Handing that device an
            //     output owned by a different adapter is a cross-adapter call,
            //     which is DXGI_ERROR_UNSUPPORTED (0x887A0004) and NOT in the
            //     transient family — so it ends the session outright.
            //
            // On a machine whose low-power GPU drives no display, the index and
            // the HMONITOR happen to agree and this never bites. On a laptop
            // whose iGPU drives the internal panel while the discrete card
            // drives an external one, they do not — and that is precisely the
            // hardware `open_duplication` was written for. A rebuild happens on
            // every alt-tab into a fullscreen game, so getting this wrong would
            // mean capture that opens fine and dies on first use.
            //
            // COST. The walk creates a D3D11 device per candidate adapter, and
            // this branch runs on EVERY tick for as long as the desktop stays
            // unavailable — a locked screen can hold it for hours while clips
            // sit armed. So the device in hand is tried first, which allocates
            // nothing; the walk happens only when that device turns out to be
            // the wrong one for this screen, which is a MUX switch, not a lock.
            match reduplicate_on(&self.device, self.monitor) {
                Ok(dup) => self.duplication = Some(dup),
                // "Not right now" is the lock screen and the sleeping panel.
                // Re-opening cannot help, and must not be attempted 60 times a
                // second.
                Err(CaptureError::AccessLost) => return Err(CaptureError::AccessLost),
                Err(_) => {
                    let (device, context, dup, _adapter) = open_duplication(self.monitor)?;
                    // Adopt the rebuilt device. A texture belongs to the device
                    // that created it, so the staging buffer cannot outlive a
                    // swap — it is reallocated on the next frame.
                    self.device = device;
                    self.context = context;
                    self.staging = None;
                    self.duplication = Some(dup);
                }
            }
            // RE-READ THE ROTATION WITH THE NEW DUPLICATION.
            //
            // Reading it once at open was justified by "a display cannot rotate
            // without the duplication being lost and rebuilt" — which is true,
            // and is exactly why it has to be read again HERE. Rotating a
            // screen mid-session raises DXGI_ERROR_ACCESS_LOST, this branch
            // silently rebuilds, and the frames that follow arrive in the new
            // orientation while a stale correction is applied to them: a
            // landscape screen turned portrait streamed sideways for the rest
            // of the session, and the reverse came out sideways AND the wrong
            // shape, which the encoder then refuses outright.
            self.rotation = rotation_of(self.monitor);
        }
        let dup = self.duplication.clone().expect("just ensured");

        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        let acquired = unsafe { dup.AcquireNextFrame(timeout_ms, &mut info, &mut resource) };

        if let Err(e) = acquired {
            return match e.code() {
                c if c == DXGI_ERROR_WAIT_TIMEOUT => Err(CaptureError::Timeout),
                c if c == DXGI_ERROR_ACCESS_LOST || is_transient_display_state(c) => {
                    // The transient family joins ACCESS_LOST: a panel going
                    // to sleep mid-session surfaces here on some machines,
                    // and it must rebuild-and-retry, not end the session.
                    self.duplication = None;
                    Err(CaptureError::AccessLost)
                }
                _ => {
                    self.duplication = None;
                    Err(CaptureError::Failed(format!("AcquireNextFrame failed: {e}")))
                }
            };
        }

        // The pointer must be read BEFORE the frame is released, and it is
        // reported through the frame info rather than being drawn into the
        // surface — DXGI excludes the cursor from the desktop image, which is
        // why a naive screen-share shows no mouse at all.
        self.update_cursor(&dup, &info);

        // A FRAME IS NOT NECESSARILY A PICTURE.
        //
        // `AcquireNextFrame` succeeds for POINTER news as well as for desktop
        // news, and `LastPresentTime == 0` is DXGI saying "nothing was
        // presented; this is a mouse update". The surface handed back with it
        // holds no new desktop image, and on this machine it comes back
        // uniform — so copying it out yields a blank frame.
        //
        // MEASURED 2026-09-10: with this check absent, the live capture test
        // failed 5 runs out of 5 with "no frame with any pixel variation after
        // 40 attempts" on an ordinary desktop. An idle screen with a moving
        // mouse generates a steady stream of pointer-only updates, so almost
        // every acquire was one, and the ~1-in-5 run that passed was the one
        // where a real present happened to land inside the window. Nothing
        // about the desktop was blank; the code was photographing the mouse.
        //
        // Treating it as `Timeout` is exactly right: it is the existing "the
        // screen did not change, repeat the previous frame" path, and the
        // cursor news above has already been folded in, so a pointer that
        // moves over a still screen still moves for the viewer.
        if info.LastPresentTime == 0 {
            unsafe {
                let _ = dup.ReleaseFrame();
            }
            return Err(CaptureError::Timeout);
        }

        // From here every exit MUST release the frame, or the next acquire
        // fails forever.
        let result = self.copy_out(resource);
        unsafe {
            let _ = dup.ReleaseFrame();
        }
        result
    }

    /// Fold this frame's pointer news into the sticky state.
    ///
    /// Two independent signals, and reading either one unconditionally is
    /// wrong: `LastMouseUpdateTime == 0` means the position field is stale
    /// rubbish, and `PointerShapeBufferSize == 0` means the shape has not
    /// changed since we last asked, not that there is no shape.
    fn update_cursor(&mut self, dup: &IDXGIOutputDuplication, info: &DXGI_OUTDUPL_FRAME_INFO) {
        if info.LastMouseUpdateTime != 0 {
            self.cursor.x = info.PointerPosition.Position.x;
            self.cursor.y = info.PointerPosition.Position.y;
            self.cursor.visible = info.PointerPosition.Visible.as_bool();
        }
        if info.PointerShapeBufferSize == 0 {
            return;
        }
        let mut buf = vec![0u8; info.PointerShapeBufferSize as usize];
        let mut required = 0u32;
        let mut shape = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
        let got = unsafe {
            dup.GetFramePointerShape(
                buf.len() as u32,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                &mut required,
                &mut shape,
            )
        };
        // A failure here costs the cursor, not the frame. Keep the old shape.
        if got.is_ok() {
            buf.truncate(required as usize);
            self.cursor.shape = buf;
            self.cursor.width = shape.Width;
            self.cursor.height = shape.Height;
            self.cursor.pitch = shape.Pitch;
            self.cursor.kind = shape.Type;
        }
    }

    fn copy_out(&mut self, resource: Option<IDXGIResource>) -> Result<Frame, CaptureError> {
        let resource = resource.ok_or_else(|| CaptureError::Failed("no frame resource".into()))?;
        let texture: ID3D11Texture2D = resource
            .cast()
            .map_err(|e| CaptureError::Failed(format!("frame is not a texture: {e}")))?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };

        static LAST_LOGGED_FORMAT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let cur_fmt = desc.Format.0 as u32;
        if LAST_LOGGED_FORMAT.swap(cur_fmt, std::sync::atomic::Ordering::Relaxed) != cur_fmt {
            let fmt_name = match desc.Format {
                DXGI_FORMAT_R16G16B16A16_FLOAT => "DXGI_FORMAT_R16G16B16A16_FLOAT",
                DXGI_FORMAT_B8G8R8A8_UNORM => "DXGI_FORMAT_B8G8R8A8_UNORM",
                _ => "<other format>",
            };
            // STDERR, and never stdout. Two reasons, both learned the hard
            // way. Release builds are windows_subsystem = "windows", so there
            // is no console and a failed write PANICS — on the capture thread,
            // which would take clips down for a diagnostic line; hence the
            // ignored result. And the clip capture host streams ENCODED FRAMES
            // on its stdout, so a line printed there is not a log message, it
            // is corruption in the middle of an H.264 bitstream. Measured:
            // this line landed 8 bytes into the stream and the parent could
            // not parse a single frame.
            use std::io::Write as _;
            let _ = writeln!(
                std::io::stderr(),
                "Acquired frame texture format: {fmt_name} ({cur_fmt})"
            );
        }

        let staging = self.staging_for(&desc)?;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context.CopyResource(&staging, &texture);
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| CaptureError::Failed(format!("Map failed: {e}")))?;
        }

        let mapped_len = mapped.RowPitch as usize * desc.Height as usize;
        let mapped_slice = unsafe {
            std::slice::from_raw_parts(mapped.pData as *const u8, mapped_len)
        };
        let raw = frame_from_staging(
            desc.Format,
            desc.Width,
            desc.Height,
            mapped.RowPitch as usize,
            mapped_slice,
        );
        unsafe {
            self.context.Unmap(&staging, 0);
        }

        // Rotate the pixels, then drop the cursor on top UNTRANSFORMED.
        //
        // The two do not share a coordinate space and it is not obvious which
        // way round that falls, so it was measured. With the pointer parked at
        // the centre of a portrait 1440x2560 output whose captured surface is
        // 2560x1440, DXGI reported (710,1272): the DESKTOP position, already
        // upright. The surface needs rotating; the pointer does not, and the
        // transform this code first applied to it put the arrow a thousand
        // pixels away — visible, plausible, and wrong.
        let mut out = rotate_to_desktop(raw, self.rotation);
        // CURSOR OWNERSHIP. When the controller draws its own pointer, ours
        // must not be in the picture: two cursors separate under latency and
        // the viewer cannot tell which one their finger is steering. See
        // set_draw_cursor.
        if self.draw_cursor {
            draw_cursor(&mut out, &self.cursor, self.cursor.x, self.cursor.y);
        }
        Ok(out)
    }
}

/// Blend the host's pointer into a captured frame, in place.
///
/// DXGI describes cursors in three formats and they are not variations on a
/// theme — one of them is not even a bitmap:
///
///  * COLOR is BGRA with a real alpha channel. The easy one.
///  * MASKED_COLOR reuses the alpha byte as a flag: 0 means "paint this pixel",
///    0xFF means "invert what is underneath". The I-beam over a dark editor is
///    this, which is why treating the byte as alpha makes text cursors vanish.
///  * MONOCHROME is 1 bit per pixel and the buffer holds TWO stacked masks, AND
///    then XOR, so the cursor is half as tall as the reported height. The four
///    bit combinations mean transparent, black, white and invert. Reading it as
///    one mask draws the bottom half of a cursor and a black box above it.
fn draw_cursor(frame: &mut Frame, cursor: &CursorState, left: i32, top: i32) {
    if !cursor.visible || cursor.shape.is_empty() || cursor.width == 0 {
        return;
    }
    let mono = cursor.kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32;
    let ch = if mono { cursor.height / 2 } else { cursor.height };
    // A zero pitch makes every row alias row zero — and for a monochrome
    // cursor it also makes the AND and XOR masks the SAME byte, so every pixel
    // resolves to black or to invert and the pointer becomes a solid block.
    // Nothing crashes, which is why it is worth refusing explicitly: a driver
    // reporting this would otherwise paint a rectangle over the picture and
    // look like a capture bug.
    if ch == 0 || cursor.pitch == 0 {
        return;
    }
    let pitch = cursor.pitch as usize;

    // SATURATING, not plain addition. `left`/`top` come straight from a driver
    // through DXGI's POINT, so nothing in this process guarantees they are
    // sane; `top + row` on an i32::MAX overflows, and an arithmetic overflow
    // panic here happens inside the capture loop and takes the whole agent
    // down. Saturating pushes the value past the frame instead, which the
    // bounds check below then rejects — the cursor is not drawn, which is the
    // right answer for a pointer that claims to be two billion pixels away.
    for row in 0..ch as i32 {
        let dy = top.saturating_add(row);
        if dy < 0 || dy >= frame.height as i32 {
            continue;
        }
        for col in 0..cursor.width as i32 {
            let dx = left.saturating_add(col);
            if dx < 0 || dx >= frame.width as i32 {
                continue;
            }
            let at = dy as usize * frame.stride + dx as usize * 4;
            if at + 4 > frame.bgra.len() {
                continue;
            }

            if mono {
                let byte = row as usize * pitch + col as usize / 8;
                let and_at = byte;
                let xor_at = byte + ch as usize * pitch;
                let (Some(&a), Some(&x)) = (cursor.shape.get(and_at), cursor.shape.get(xor_at))
                else {
                    continue;
                };
                let bit = 7 - (col as usize % 8);
                let and = (a >> bit) & 1;
                let xor = (x >> bit) & 1;
                match (and, xor) {
                    (1, 0) => {}                                    // transparent
                    (0, 0) => frame.bgra[at..at + 3].fill(0),       // black
                    (0, 1) => frame.bgra[at..at + 3].fill(255),     // white
                    _ => {
                        for c in 0..3 {
                            frame.bgra[at + c] = !frame.bgra[at + c];
                        }
                    }
                }
                continue;
            }

            let sat = row as usize * pitch + col as usize * 4;
            let Some(px) = cursor.shape.get(sat..sat + 4) else { continue };
            if cursor.kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 as u32 {
                if px[3] == 0 {
                    frame.bgra[at..at + 3].copy_from_slice(&px[..3]);
                } else {
                    for c in 0..3 {
                        frame.bgra[at + c] ^= px[c];
                    }
                }
            } else if cursor.kind == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32 {
                let a = px[3] as u32;
                if a == 0 {
                    continue;
                }
                for c in 0..3 {
                    let src = px[c] as u32;
                    let dst = frame.bgra[at + c] as u32;
                    frame.bgra[at + c] = ((src * a + dst * (255 - a)) / 255) as u8;
                }
            }
        }
    }
}

/// This output's rotation right now, or `None` if it cannot be read.
///
/// Deliberately re-derived rather than cached: see the rebuild path in
/// `next_frame`.
fn rotation_of(monitor: usize) -> Rotation {
    outputs()
        .iter()
        .find(|o| o.index == monitor)
        .map(|o| o.rotation)
        .unwrap_or(Rotation::None)
}

/// The rotation to apply to a captured surface, from what DXGI reports.
///
/// DXGI reports the panel's rotation, and the captured surface must be turned
/// the SAME way to reach desktop orientation — not the opposite. The previous
/// mapping inverted the quarter turns (90 -> 270, 270 -> 90); that is exactly
/// 180° wrong, and both portrait monitors on the reporting desk streamed
/// upside down with correct aspect. A dimension check cannot catch this —
/// 90° and 270° produce identical frame sizes — so the direction here is
/// pinned by that live observation, not by the docs.
fn rotation_from_dxgi(mode: DXGI_MODE_ROTATION) -> Rotation {
    match mode.0 {
        2 => Rotation::Cw90,  // ROTATE90
        3 => Rotation::Cw180,
        4 => Rotation::Cw270, // ROTATE270
        _ => Rotation::None,
    }
}

/// Turn a captured surface into the orientation the desktop describes.
///
/// Pure, so the pixel bookkeeping is testable without a display — a 90-degree
/// error is the kind that looks obviously wrong on screen and is very easy to
/// get subtly backwards in code.
pub(crate) fn rotate_to_desktop(frame: Frame, rotation: Rotation) -> Frame {
    if rotation == Rotation::None {
        return frame;
    }
    let (sw, sh) = (frame.width as usize, frame.height as usize);
    let (dw, dh) = match rotation {
        Rotation::Cw90 | Rotation::Cw270 => (sh, sw),
        _ => (sw, sh),
    };
    let dst_stride = dw * 4;
    let mut out = vec![0u8; dst_stride * dh];

    for y in 0..sh {
        let src_row = y * frame.stride;
        for x in 0..sw {
            let src = src_row + x * 4;
            let (dx, dy) = match rotation {
                Rotation::Cw90 => (sh - 1 - y, x),
                Rotation::Cw180 => (sw - 1 - x, sh - 1 - y),
                Rotation::Cw270 => (y, sw - 1 - x),
                Rotation::None => (x, y),
            };
            let dst = dy * dst_stride + dx * 4;
            if src + 4 <= frame.bgra.len() && dst + 4 <= out.len() {
                out[dst..dst + 4].copy_from_slice(&frame.bgra[src..src + 4]);
            }
        }
    }

    Frame { width: dw as u32, height: dh as u32, stride: dst_stride, bgra: out }
}

/// Convert IEEE 754 half-precision float (16-bit) to single-precision float (32-bit).
#[inline(always)]
pub fn f16_to_f32(h: u16) -> f32 {
    let s = (h >> 15) & 1;
    let e = (h >> 10) & 0x1f;
    let m = h & 0x3ff;

    if e == 0 {
        if m == 0 {
            if s != 0 { -0.0 } else { 0.0 }
        } else {
            let val = (m as f32) * (1.0 / 16777216.0);
            if s != 0 { -val } else { val }
        }
    } else if e == 31 {
        if m == 0 {
            if s != 0 { f32::NEG_INFINITY } else { f32::INFINITY }
        } else {
            f32::NAN
        }
    } else {
        let f_bits = ((s as u32) << 31) | (((e as u32) + 112) << 23) | ((m as u32) << 13);
        f32::from_bits(f_bits)
    }
}

/// Convert an scRGB linear half-float channel to an 8-bit sRGB color byte.
///
/// In scRGB:
/// - 0.0 is black
/// - 1.0 is reference SDR white (80 nits in standard scRGB / SDR 100%)
/// - Values > 1.0 are HDR highlights
/// - Values < 0.0 represent out-of-gamut colours in scRGB
///
/// Conversion steps:
/// 1. Values <= 0.0 clamp to 0.
/// 2. Highlights >= 1.0 saturate at maximum SDR white 255.
/// 3. Values in (0.0, 1.0) are transformed via the IEC 61966-2-1 sRGB transfer function:
///    L <= 0.0031308 => 12.92 * L
///    L >  0.0031308 => 1.055 * L^(1/2.4) - 0.055
/// 4. Scaled to [0, 255] and rounded.
pub fn sc_rgb_channel_to_u8(h: u16) -> u8 {
    let c = f16_to_f32(h);
    if c <= 0.0 || c.is_nan() {
        return 0;
    }
    if c >= 1.0 {
        return 255;
    }
    let s = if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Convert an scRGB linear half-float alpha channel to an 8-bit alpha byte.
pub fn sc_rgb_alpha_to_u8(h: u16) -> u8 {
    let c = f16_to_f32(h);
    if c <= 0.0 || c.is_nan() {
        0
    } else if c >= 1.0 {
        255
    } else {
        (c * 255.0).round().clamp(0.0, 255.0) as u8
    }
}

/// Lookup tables for scRGB half-float to 8-bit conversion.
///
/// 65,536 entries per table (64 KB each, 128 KB total) fit easily within the L2
/// cache of modern processors, completely eliminating expensive `powf`
/// exponentiation in the frame conversion loop (~3.68M pixels at 60 fps).
struct HdrColorLut {
    color: [u8; 65536],
    alpha: [u8; 65536],
}

impl HdrColorLut {
    fn new() -> Self {
        let mut color = [0u8; 65536];
        let mut alpha = [0u8; 65536];
        for i in 0..=65535u16 {
            color[i as usize] = sc_rgb_channel_to_u8(i);
            alpha[i as usize] = sc_rgb_alpha_to_u8(i);
        }
        Self { color, alpha }
    }
}

static HDR_LUT: std::sync::OnceLock<HdrColorLut> = std::sync::OnceLock::new();

/// Convert an scRGB R16G16B16A16_FLOAT buffer to 8-bit BGRA (4 bytes per pixel).
///
/// Swaps channel order from RGBA (half-float) to BGRA (u8) and applies the
/// sRGB transfer curve renormalised against SDR white (1.0).
pub fn hdr_sc_rgb_to_bgra8(
    src: &[u8],
    src_stride: usize,
    width: usize,
    height: usize,
    dst: &mut [u8],
    dst_stride: usize,
) {
    let lut = HDR_LUT.get_or_init(HdrColorLut::new);
    let row_bytes = width * 8;

    for y in 0..height {
        let src_row_start = y * src_stride;
        let dst_row_start = y * dst_stride;

        if src_row_start + row_bytes > src.len() || dst_row_start + width * 4 > dst.len() {
            break;
        }

        let src_row = &src[src_row_start..src_row_start + row_bytes];
        let dst_row = &mut dst[dst_row_start..dst_row_start + width * 4];

        for x in 0..width {
            let s = x * 8;
            let d = x * 4;

            let r_half = u16::from_le_bytes([src_row[s], src_row[s + 1]]);
            let g_half = u16::from_le_bytes([src_row[s + 2], src_row[s + 3]]);
            let b_half = u16::from_le_bytes([src_row[s + 4], src_row[s + 5]]);
            let a_half = u16::from_le_bytes([src_row[s + 6], src_row[s + 7]]);

            dst_row[d] = lut.color[b_half as usize];     // Blue
            dst_row[d + 1] = lut.color[g_half as usize]; // Green
            dst_row[d + 2] = lut.color[r_half as usize]; // Red
            dst_row[d + 3] = lut.alpha[a_half as usize]; // Alpha
        }
    }
}

/// Extract Frame from mapped staging texture data, converting HDR surfaces to 8-bit BGRA.
pub(crate) fn frame_from_staging(
    format: DXGI_FORMAT,
    width: u32,
    height: u32,
    row_pitch: usize,
    data: &[u8],
) -> Frame {
    if format == DXGI_FORMAT_R16G16B16A16_FLOAT {
        let w = width as usize;
        let h = height as usize;
        let dst_stride = w * 4;
        let mut bgra = vec![0u8; dst_stride * h];
        hdr_sc_rgb_to_bgra8(data, row_pitch, w, h, &mut bgra, dst_stride);
        Frame {
            width,
            height,
            stride: dst_stride,
            bgra,
        }
    } else {
        let stride = row_pitch;
        let len = stride * height as usize;
        let mut bgra = vec![0u8; len];
        let copy_len = len.min(data.len());
        bgra[..copy_len].copy_from_slice(&data[..copy_len]);
        Frame {
            width,
            height,
            stride,
            bgra,
        }
    }
}

/// A top-down device-independent bitmap pulled out of a GDI cursor.
struct CursorDib {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    pitch: u32,
}

/// Convert GDI cursor bitmaps into the CursorState `draw_cursor` consumes.
/// Pure, so the format translation is testable without Win32.
///
/// Why this exists: DXGI reports the pointer SHAPE only when it CHANGES, so a
/// freshly opened capture (session start, blocked-capture rebuild, monitor
/// switch) drew no pointer at all until the host's own mouse produced a
/// delta — reported as "the cursor is invisible but still works" after using
/// the file browser, and after lock/unlock. Seeding from GDI at open fixes
/// the blank start.
///
/// GDI and DXGI agree byte-for-byte on the two shapes involved when the DIB
/// rows are top-down:
///  * a colour cursor's 32bpp BGRA DIB is DXGI COLOR — except legacy cursors
///    whose alpha plane is all zero, where opacity lives in the AND mask
///    (mask bit 0 = opaque), the same derivation DXGI performs;
///  * a monochrome cursor's hbmMask is the SAME double-height AND-over-XOR
///    layout as DXGI's MONOCHROME shape, DWORD-aligned rows and MSB-first
///    bits included.
///
/// Position: DXGI reports the shape's top-left in output-relative,
/// desktop-upright coordinates with the hotspot already subtracted; the
/// point handed in here is desktop coordinates with no hotspot subtraction,
/// so both corrections are applied. THE CALLER MUST PASS A PHYSICAL POINT:
/// this process is deliberately DPI-unaware (see puca-agent session.rs), so
/// a raw CURSORINFO.ptScreenPos is VIRTUALISED while the DXGI rect is
/// physical — subtracting one from the other lands the pointer a scale
/// factor away (a third of the screen at 150%) and can even pick the wrong
/// output for `visible`. The shape is stored UNCONDITIONALLY;
/// `visible` is true only when the point lies inside this output's rect —
/// mirroring DXGI's per-output Visible semantics, so a pointer that wanders
/// onto this screen later has a shape waiting for it.
fn dib_to_cursor_state(
    color: Option<CursorDib>,
    mask: CursorDib,
    hotspot: (i32, i32),
    point: (i32, i32),
    showing: bool,
    rect: (i32, i32, i32, i32), // left, top, width, height
) -> CursorState {
    let (left, top, w, h) = rect;
    let inside = point.0 >= left && point.0 < left + w && point.1 >= top && point.1 < top + h;
    let (shape, width, height, pitch, kind) = match color {
        Some(mut c) => {
            // Legacy colour cursors carry an all-zero alpha plane; opacity
            // lives in the AND mask. A real alpha plane is left untouched.
            if c.bytes.chunks_exact(4).all(|px| px[3] == 0) {
                for row in 0..c.height.min(mask.height) as usize {
                    for col in 0..c.width as usize {
                        let mbyte = row * mask.pitch as usize + col / 8;
                        let Some(&m) = mask.bytes.get(mbyte) else { continue };
                        let opaque = (m >> (7 - (col % 8))) & 1 == 0;
                        let at = row * c.pitch as usize + col * 4 + 3;
                        if let Some(a) = c.bytes.get_mut(at) {
                            *a = if opaque { 255 } else { 0 };
                        }
                    }
                }
            }
            (
                c.bytes,
                c.width,
                c.height,
                c.pitch,
                DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32,
            )
        }
        None => (
            mask.bytes,
            mask.width,
            mask.height,
            mask.pitch,
            DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32,
        ),
    };
    CursorState {
        shape,
        width,
        height,
        pitch,
        kind,
        x: point.0 - hotspot.0 - left,
        y: point.1 - hotspot.1 - top,
        visible: showing && inside,
    }
}

/// Read the CURRENT cursor via GDI, for seeding a fresh capture. Any failure
/// yields the empty state — exactly the old behaviour (no pointer until the
/// first DXGI delta), never an error.
fn seed_cursor(monitor: usize) -> CursorState {
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ, RGBQUAD,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, GetIconInfo, GetPhysicalCursorPos, CURSORINFO, CURSOR_SHOWING, ICONINFO,
    };

    let Some(out) = outputs().into_iter().find(|o| o.index == monitor) else {
        return CursorState::default();
    };

    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err() || ci.hCursor.is_invalid() {
            return CursorState::default();
        }
        let showing = (ci.flags.0 & CURSOR_SHOWING.0) != 0;
        let mut ii = ICONINFO::default();
        if GetIconInfo(ci.hCursor, &mut ii).is_err() {
            return CursorState::default();
        }
        // From here BOTH bitmaps must be deleted on every path — GetIconInfo
        // hands out copies the caller owns, and a leak here is per capture
        // open, which the blocked-capture path retries every 5 seconds.
        let hdc = GetDC(None);
        let read_dib = |hbm: HBITMAP, bpp: u16| -> Option<CursorDib> {
            if hbm.is_invalid() {
                return None;
            }
            let mut bm = BITMAP::default();
            if GetObjectW(
                HGDIOBJ(hbm.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bm as *mut _ as *mut _),
            ) == 0
            {
                return None;
            }
            let width = bm.bmWidth as u32;
            let height = bm.bmHeight as u32;
            if width == 0 || height == 0 {
                return None;
            }
            // 32bpp rows are naturally aligned; 1bpp rows are DWORD-aligned —
            // the same padding DXGI's MONOCHROME pitch carries.
            let pitch = if bpp == 32 { width * 4 } else { width.div_ceil(32) * 4 };
            // A 1bpp DIB needs a 2-entry palette after the header.
            #[repr(C)]
            struct Bmi {
                header: BITMAPINFOHEADER,
                _colors: [RGBQUAD; 2],
            }
            let mut bmi = Bmi {
                header: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: bm.bmWidth,
                    // NEGATIVE height = top-down rows — the order both
                    // draw_cursor and DXGI use.
                    biHeight: -bm.bmHeight,
                    biPlanes: 1,
                    biBitCount: bpp,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                _colors: [RGBQUAD::default(); 2],
            };
            let mut bytes = vec![0u8; (pitch * height) as usize];
            let rows = GetDIBits(
                hdc,
                hbm,
                0,
                height,
                Some(bytes.as_mut_ptr() as *mut _),
                &mut bmi as *mut _ as *mut BITMAPINFO,
                DIB_RGB_COLORS,
            );
            (rows as u32 == height).then_some(CursorDib { bytes, width, height, pitch })
        };

        let color = read_dib(ii.hbmColor, 32);
        let mask = read_dib(ii.hbmMask, 1);
        let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        let _ = ReleaseDC(None, hdc);

        let Some(mask) = mask else {
            return CursorState::default();
        };
        // PHYSICAL point, not ptScreenPos: this process is deliberately
        // DPI-unaware, so CURSORINFO's point is virtualised while the DXGI
        // rect is physical — mixing them put the seeded pointer a scale
        // factor off (a third of the screen at 150%, the laptop default) and
        // could mark it visible on the wrong output. GetPhysicalCursorPos
        // exists for exactly this caller; ptScreenPos stays as the fallback,
        // which is only ever exact at 100% scale.
        let mut pt = ci.ptScreenPos;
        let mut phys = windows::Win32::Foundation::POINT::default();
        if GetPhysicalCursorPos(&mut phys).is_ok() {
            pt = phys;
        }
        dib_to_cursor_state(
            color,
            mask,
            (ii.xHotspot as i32, ii.yHotspot as i32),
            (pt.x, pt.y),
            showing,
            (out.left, out.top, out.width, out.height),
        )
    }
}

#[cfg(test)]
mod cursor_tests {
    use super::*;

    fn frame(w: u32, h: u32, fill: u8) -> Frame {
        Frame { width: w, height: h, stride: w as usize * 4, bgra: vec![fill; (w * h * 4) as usize] }
    }

    fn px(f: &Frame, x: u32, y: u32) -> [u8; 3] {
        let at = y as usize * f.stride + x as usize * 4;
        [f.bgra[at], f.bgra[at + 1], f.bgra[at + 2]]
    }

    /// Blue value of the pixel at (col, row) in the asymmetric fixture.
    const TL: u8 = 10;
    const TR: u8 = 20;
    const BL: u8 = 30;
    const BR: u8 = 40;

    /// A 2x2 opaque COLOR cursor with a DIFFERENT colour in every pixel and a
    /// PADDED pitch.
    ///
    /// Both properties are load-bearing and both were missing. A uniform
    /// fixture cannot tell a correct implementation from one that transposes
    /// the shape, swaps the destination axes, or reads rows in the wrong order
    /// — every pixel is the same, so every wrong answer is the right answer.
    /// And a pitch equal to `width * 4` lets an implementation that ignores
    /// `pitch` entirely pass, while real DXGI pads rows and would then be read
    /// with a shear through the shape.
    fn colour_cursor() -> CursorState {
        let pitch = 2 * 4 + 8; // two BGRA pixels plus real padding
        let mut shape = vec![0u8; pitch * 2];
        for (i, blue) in [TL, TR, BL, BR].into_iter().enumerate() {
            let (col, row) = (i % 2, i / 2);
            let at = row * pitch + col * 4;
            shape[at] = blue;
            shape[at + 1] = 0;
            shape[at + 2] = 0;
            shape[at + 3] = 255;
        }
        // Fill the padding with a colour that must never appear in the output.
        for row in 0..2 {
            shape[row * pitch + 8..(row + 1) * pitch].fill(0x77);
        }
        CursorState {
            shape,
            width: 2,
            height: 2,
            pitch: pitch as u32,
            kind: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32,
            x: 1,
            y: 1,
            visible: true,
        }
    }

    /// Replace the fixture's pixels while keeping its padded geometry.
    fn recolour(c: &mut CursorState, px: [u8; 4]) {
        let pitch = c.pitch as usize;
        for row in 0..2 {
            for col in 0..2 {
                let at = row * pitch + col * 4;
                c.shape[at..at + 4].copy_from_slice(&px);
            }
        }
    }

    /// Every pixel checked individually, at an ASYMMETRIC offset.
    ///
    /// The diagonal alone is not enough: with a square cursor at a symmetric
    /// offset, swapping the destination axes at the call site lands on exactly
    /// the same rectangle, and with a uniform fixture it lands on exactly the
    /// same pixels. Both were true here.
    #[test]
    fn a_colour_cursor_lands_where_it_is_told_the_right_way_round() {
        let mut f = frame(5, 4, 0);
        // x=2, y=1: distinct, so a swapped pair puts the cursor at (1,2).
        draw_cursor(&mut f, &colour_cursor(), 2, 1);

        assert_eq!(px(&f, 2, 1)[0], TL, "top-left is wrong");
        assert_eq!(px(&f, 3, 1)[0], TR, "top-right is wrong — the shape may be transposed");
        assert_eq!(px(&f, 2, 2)[0], BL, "bottom-left is wrong — the shape may be transposed");
        assert_eq!(px(&f, 3, 2)[0], BR, "bottom-right is wrong");

        for (x, y) in [(1u32, 1u32), (4, 1), (2, 0), (2, 3), (1, 2)] {
            assert_eq!(px(&f, x, y), [0, 0, 0], "painted outside its rectangle at ({x},{y})");
        }
    }

    /// The row padding between a cursor's rows must be SKIPPED, not drawn.
    ///
    /// Real DXGI pitches are padded. An implementation that walks the shape
    /// linearly instead of by pitch reads the padding as pixels and shears the
    /// cursor a little further to the left on every row.
    #[test]
    fn the_padding_between_shape_rows_is_never_drawn() {
        let c = colour_cursor();
        assert!(c.pitch as usize > c.width as usize * 4, "fixture is not actually padded");
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &c, 0, 0);
        for y in 0..4 {
            for x in 0..4 {
                assert_ne!(px(&f, x, y)[0], 0x77, "the row padding was drawn at ({x},{y})");
            }
        }
    }

    /// The alpha channel has to actually blend. A cursor drawn as if every
    /// pixel were opaque gets a black box around every anti-aliased edge, which
    /// is the most common way this looks "nearly right".
    /// Blended over a NON-BLACK desktop, which is the only way this test can
    /// see the destination term at all.
    ///
    /// It was written over a black frame, where `dst * (255 - a)` contributes
    /// exactly zero — so an implementation that dropped the destination
    /// entirely and wrote `src * a / 255` produced the same number and passed.
    /// That bug puts a dark halo around every antialiased edge of the cursor on
    /// any desktop that is not black, which is to say all of them.
    #[test]
    fn a_half_transparent_pixel_blends_with_what_is_under_it() {
        let mut c = colour_cursor();
        recolour(&mut c, [255, 255, 255, 128]);
        let mut f = frame(4, 4, 200);
        draw_cursor(&mut f, &c, 1, 1);
        let got = px(&f, 1, 1)[0];
        // 255*128/255 + 200*127/255 = 128 + 99 = 227. Ignoring the destination
        // would give 128; ignoring the source would give 200.
        assert!((222..=232).contains(&got), "expected a blend near 227, got {got}");
    }

    #[test]
    fn a_fully_transparent_pixel_leaves_the_desktop_alone() {
        let mut c = colour_cursor();
        recolour(&mut c, [255, 255, 255, 0]);
        let mut f = frame(4, 4, 77);
        draw_cursor(&mut f, &c, 1, 1);
        assert_eq!(px(&f, 1, 1), [77, 77, 77]);
    }

    /// MASKED_COLOR is not alpha. 0 paints, 0xFF inverts — that is how the
    /// I-beam stays visible over both a white page and a dark editor. Reading
    /// the byte as alpha makes the inverting half disappear entirely.
    #[test]
    fn masked_colour_paints_on_zero_and_inverts_on_ff() {
        let mut c = colour_cursor();
        c.kind = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 as u32;
        // Keep the padded pitch; only the top-left paints, so the paint and
        // invert cases sit at DIFFERENT positions and a transposed read swaps
        // which one is which.
        let pitch = c.pitch as usize;
        c.shape.fill(0);
        for row in 0..2 {
            for col in 0..2 {
                let at = row * pitch + col * 4;
                let mask = if (row, col) == (0, 0) { 0 } else { 0xFF };
                c.shape[at..at + 4].copy_from_slice(&[255, 0, 0, mask]);
            }
        }
        let mut f = frame(4, 4, 0x20);
        draw_cursor(&mut f, &c, 1, 1);
        assert_eq!(px(&f, 1, 1), [255, 0, 0], "the paint case did not paint");
        assert_eq!(px(&f, 2, 1), [0xDF, 0x20, 0x20], "the invert case did not invert");
        assert_eq!(px(&f, 1, 2), [0xDF, 0x20, 0x20], "invert missing below the painted pixel");
    }

    /// A monochrome cursor's buffer holds TWO stacked masks, so the drawn
    /// cursor is HALF the reported height. Treating `Height` as the height
    /// draws the AND mask as a solid block above the real cursor.
    #[test]
    fn a_monochrome_cursor_is_half_the_height_it_reports() {
        // 8 wide, reported height 4 => a 2-row cursor. AND then XOR.
        // Row 0: and=0 xor=0 -> black.  Row 1: and=0 xor=1 -> white.
        let c = CursorState {
            shape: vec![0b0000_0000, 0b0000_0000, 0b0000_0000, 0b1111_1111],
            width: 8,
            height: 4,
            pitch: 1,
            kind: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32,
            x: 0,
            y: 0,
            visible: true,
        };
        let mut f = frame(8, 8, 90);
        draw_cursor(&mut f, &c, 0, 0);
        assert_eq!(px(&f, 0, 0), [0, 0, 0], "row 0 should be black");
        assert_eq!(px(&f, 0, 1), [255, 255, 255], "row 1 should be white");
        assert_eq!(px(&f, 0, 2), [90, 90, 90], "it drew past half its reported height");
        assert_eq!(px(&f, 0, 3), [90, 90, 90]);
    }

    /// The transparent and invert cases, which are what an arrow's surround and
    /// an I-beam are actually made of. Measured on a real portrait monitor, the
    /// resize cursor DXGI hands back is invert pixels and nothing else — get
    /// this wrong and that cursor is simply not there.
    #[test]
    fn a_monochrome_cursor_can_be_transparent_and_can_invert() {
        let c = CursorState {
            // and=1 xor=0 -> transparent.  and=1 xor=1 -> invert.
            shape: vec![0b1111_1111, 0b1111_1111, 0b0000_0000, 0b1111_1111],
            width: 8,
            height: 4,
            pitch: 1,
            kind: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32,
            x: 0,
            y: 0,
            visible: true,
        };
        let mut f = frame(8, 8, 0x30);
        draw_cursor(&mut f, &c, 0, 0);
        assert_eq!(px(&f, 0, 0), [0x30, 0x30, 0x30], "transparent should change nothing");
        assert_eq!(px(&f, 0, 1), [0xCF, 0xCF, 0xCF], "invert should flip the desktop pixel");
    }

    /// Within a mask byte the LEFTMOST pixel is the HIGH bit. Getting this
    /// backwards mirrors the cursor in eight-pixel blocks, which on a 32-wide
    /// arrow is a recognisable-but-wrong shape rather than an obvious failure —
    /// and the all-ones/all-zeroes fixtures above cannot see it at all, since
    /// every bit in those bytes is the same.
    #[test]
    fn the_leftmost_pixel_of_a_mask_byte_is_the_high_bit() {
        let c = CursorState {
            // AND = 0111_1111: only column 0 is opaque. XOR = 0: paint it black.
            shape: vec![0b0111_1111, 0b0000_0000],
            width: 8,
            height: 2,
            pitch: 1,
            kind: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32,
            x: 0,
            y: 0,
            visible: true,
        };
        let mut f = frame(8, 8, 90);
        draw_cursor(&mut f, &c, 0, 0);
        assert_eq!(px(&f, 0, 0), [0, 0, 0], "column 0 should be the high bit and opaque");
        assert_eq!(px(&f, 7, 0), [90, 90, 90], "column 7 was drawn — the byte is reversed");
    }

    /// A zero pitch must be refused, not rendered. It would otherwise alias
    /// every row onto row zero and, for a monochrome cursor, collapse the AND
    /// and XOR masks into the same byte — a solid block over the picture.
    #[test]
    fn a_cursor_with_no_pitch_is_refused() {
        let mut c = colour_cursor();
        c.pitch = 0;
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &c, 1, 1);
        assert_eq!(f.bgra, vec![0u8; f.bgra.len()], "a pitchless shape was drawn anyway");
    }

    /// The captured surface is turned the SAME way as the panel's reported
    /// rotation, not the opposite. The inverted mapping (90 -> 270, 270 -> 90)
    /// shipped in v0.8.21 and put both portrait monitors on the reporting desk
    /// exactly 180° upside down — a defect no dimension check can see, since
    /// 90° and 270° give identical frame sizes. This test pins the direction
    /// established by that live observation. The constants are
    /// DXGI_MODE_ROTATION: 1 IDENTITY, 2 ROTATE90, 3 ROTATE180, 4 ROTATE270.
    #[test]
    fn the_dxgi_rotation_is_applied_in_the_same_sense() {
        use windows::Win32::Graphics::Dxgi::Common::DXGI_MODE_ROTATION;
        assert_eq!(rotation_from_dxgi(DXGI_MODE_ROTATION(1)), Rotation::None);
        assert_eq!(
            rotation_from_dxgi(DXGI_MODE_ROTATION(2)),
            Rotation::Cw90,
            "a panel reporting ROTATE90 is corrected by 90, not 270 — \
             inverting it renders portrait monitors upside down",
        );
        assert_eq!(rotation_from_dxgi(DXGI_MODE_ROTATION(3)), Rotation::Cw180);
        assert_eq!(
            rotation_from_dxgi(DXGI_MODE_ROTATION(4)),
            Rotation::Cw270,
            "a panel reporting ROTATE270 is corrected by 270, not 90",
        );
        // UNSPECIFIED (0) and anything unknown must not rotate.
        assert_eq!(rotation_from_dxgi(DXGI_MODE_ROTATION(0)), Rotation::None);
    }

    /// Positive control for the "nothing drawn" tests below: this fixture DOES
    /// change the frame when it is allowed to. Without this, a `draw_cursor`
    /// that had quietly stopped working would make them all pass.
    #[test]
    fn the_fixture_really_does_draw_when_it_is_visible() {
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &colour_cursor(), 1, 1);
        assert_ne!(f.bgra, vec![0u8; f.bgra.len()]);
    }

    #[test]
    fn an_invisible_or_shapeless_cursor_draws_nothing() {
        for mutate in [
            (|c: &mut CursorState| c.visible = false) as fn(&mut CursorState),
            |c: &mut CursorState| c.shape.clear(),
            |c: &mut CursorState| c.width = 0,
            |c: &mut CursorState| c.height = 0,
        ] {
            let mut c = colour_cursor();
            mutate(&mut c);
            let mut f = frame(4, 4, 0);
            draw_cursor(&mut f, &c, 1, 1);
            assert_eq!(f.bgra, vec![0u8; f.bgra.len()], "something was drawn");
        }
    }

    /// A cursor half off the edge must clip, not wrap round to the other side
    /// of the screen and not index past the end of the buffer. It is normal:
    /// the pointer sits at the very edge whenever the user is reaching for a
    /// scrollbar or another monitor.
    /// A cursor half off the edge must CLIP — draw the part that is on screen
    /// and nothing else. It is not an edge case: it is what reaching for a
    /// scrollbar or the next monitor looks like.
    ///
    /// The partial cases are the whole point and the first version of this test
    /// asserted nothing about them — its only assertion was guarded by a
    /// condition that excluded them. An implementation that gave up entirely
    /// whenever any part of the cursor was off-screen, so the pointer vanished
    /// at every screen edge, passed it.
    #[test]
    fn a_cursor_hanging_off_the_edge_still_draws_the_part_that_fits() {
        // Bottom-right corner: only the cursor's top-left pixel is on screen.
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &colour_cursor(), 3, 3);
        assert_eq!(px(&f, 3, 3)[0], TL, "the visible corner of the cursor was not drawn");

        // Top-left: only the cursor's bottom-right pixel is on screen.
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &colour_cursor(), -1, -1);
        assert_eq!(px(&f, 0, 0)[0], BR, "the visible corner of the cursor was not drawn");
        assert_eq!(px(&f, 1, 1), [0, 0, 0], "it drew more than the part that fits");
    }

    // ---- seeding (dib_to_cursor_state) -------------------------------------

    fn dib(bytes: Vec<u8>, width: u32, height: u32, pitch: u32) -> CursorDib {
        CursorDib { bytes, width, height, pitch }
    }

    /// The seeded state must be DRAWABLE by draw_cursor, not merely populated —
    /// so these tests go through the same fixture geometry the drawing tests
    /// use and assert on pixels, which is what the user actually sees.
    #[test]
    fn a_seeded_colour_cursor_with_real_alpha_draws_as_is() {
        // 1x1 opaque red BGRA pixel, real alpha — must be left untouched.
        let colour = dib(vec![0, 0, 255, 255], 1, 1, 4);
        let mask = dib(vec![0x00, 0, 0, 0], 1, 1, 4); // AND bit 0 (opaque) — must be IGNORED
        let s = dib_to_cursor_state(Some(colour), mask, (0, 0), (10, 10), true, (8, 8, 16, 16));
        assert_eq!(s.kind, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32);
        assert_eq!((s.x, s.y), (2, 2), "output-relative, hotspot-corrected");
        assert!(s.visible);
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &s, 1, 1);
        assert_eq!(px(&f, 1, 1), [0, 0, 255], "the seeded pixel must draw");
    }

    #[test]
    fn a_seeded_legacy_colour_cursor_derives_alpha_from_the_and_mask() {
        // 2x1: both pixels alpha ZERO (legacy); AND mask bit 0 for col 0
        // (opaque), 1 for col 1 (transparent) -> only col 0 draws.
        let colour = dib(vec![0, 255, 0, 0, 255, 0, 0, 0], 2, 1, 8);
        let mask = dib(vec![0b0100_0000, 0, 0, 0], 2, 1, 4);
        let s = dib_to_cursor_state(Some(colour), mask, (0, 0), (0, 0), true, (0, 0, 16, 16));
        let mut f = frame(4, 4, 0);
        draw_cursor(&mut f, &s, 0, 0);
        assert_eq!(px(&f, 0, 0), [0, 255, 0], "the mask-opaque pixel must draw");
        assert_eq!(px(&f, 1, 0), [0, 0, 0], "the mask-transparent pixel must not");
    }

    #[test]
    fn a_seeded_monochrome_cursor_keeps_the_double_height_and_xor_layout() {
        // 1x1 mono cursor: GDI's mask is 2 rows (AND over XOR), DWORD-aligned.
        // AND 0 + XOR 1 = white, per draw_cursor's own decode table.
        let mask = dib(vec![0x00, 0, 0, 0, 0x80, 0, 0, 0], 1, 2, 4);
        let s = dib_to_cursor_state(None, mask, (0, 0), (0, 0), true, (0, 0, 16, 16));
        assert_eq!(s.kind, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32);
        assert_eq!(s.height, 2, "height stays DOUBLED — draw_cursor halves it");
        let mut f = frame(2, 2, 7);
        draw_cursor(&mut f, &s, 0, 0);
        assert_eq!(px(&f, 0, 0), [255, 255, 255], "AND 0 + XOR 1 must draw white");
    }

    #[test]
    fn a_seeded_pointer_on_another_output_keeps_its_shape_but_is_not_visible() {
        // The point sits OUTSIDE this output's rect: DXGI's per-output
        // Visible semantics say not visible — but the shape must be retained
        // so a later position-only delta can light it up.
        let colour = dib(vec![0, 0, 255, 255], 1, 1, 4);
        let mask = dib(vec![0, 0, 0, 0], 1, 1, 4);
        let s = dib_to_cursor_state(Some(colour), mask, (0, 0), (100, 100), true, (0, 0, 16, 16));
        assert!(!s.visible);
        assert!(!s.shape.is_empty(), "the shape must survive for a later delta");
        // Positive control: the same point inside the rect IS visible.
        let colour = dib(vec![0, 0, 255, 255], 1, 1, 4);
        let mask = dib(vec![0, 0, 0, 0], 1, 1, 4);
        let s = dib_to_cursor_state(Some(colour), mask, (0, 0), (5, 5), true, (0, 0, 16, 16));
        assert!(s.visible);
    }

    /// LIVE: a real machine with a visible cursor must seed a non-empty
    /// shape at capture open. `--ignored` because it needs a display.
    #[test]
    #[ignore = "needs a real display and a visible cursor"]
    fn live_a_fresh_capture_is_born_with_a_cursor_shape() {
        let seeded = seed_cursor(0);
        assert!(
            !seeded.shape.is_empty(),
            "seed_cursor(0) produced no shape on a machine with a live cursor"
        );
    }

    #[test]
    fn a_cursor_entirely_off_screen_draws_nothing_and_does_not_panic() {
        for (x, y) in [(-8i32, 2i32), (2, -8), (100, 100), (-100, -100), (i32::MIN, i32::MAX)] {
            let mut f = frame(4, 4, 0);
            draw_cursor(&mut f, &colour_cursor(), x, y);
            assert_eq!(f.bgra, vec![0u8; f.bgra.len()], "something appeared from ({x},{y})");
        }
    }

    #[test]
    fn a_duplication_in_a_bad_state_is_rebuilt_not_fatal() {
        use windows::core::HRESULT;
        // THE REGRESSION THIS EXISTS TO CATCH. Each of these used to end the
        // remote session outright. A session that stops and does not come back
        // is strictly worse than one that freezes and recovers, and the rebuild
        // path already exists for exactly this shape of failure.
        for (code, name) in [
            (HRESULT(0x887A0001u32 as i32), "DXGI_ERROR_INVALID_CALL"),
            (DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, "NOT_CURRENTLY_AVAILABLE"),
            (DXGI_ERROR_SESSION_DISCONNECTED, "SESSION_DISCONNECTED"),
        ] {
            assert!(is_transient_display_state(code), "{name} must be recoverable");
        }
    }

    #[test]
    fn a_real_fault_is_still_fatal() {
        use windows::core::HRESULT;
        // The positive control. Widening the recoverable set until everything
        // is "transient" would turn a genuine, permanent failure into an
        // infinite rebuild loop that never reports anything — which is how a
        // fix for a session death becomes a session that hangs instead.
        for code in [HRESULT(0x80004005u32 as i32), HRESULT(0x8007000Eu32 as i32)] {
            assert!(!is_transient_display_state(code), "{code:?} must stay fatal");
        }
    }

    fn f32_to_f16(f: f32) -> u16 {
        let bits = f.to_bits();
        let s = (bits >> 31) & 1;
        let e = (bits >> 23) & 0xff;
        let m = bits & 0x7f_ffff;

        if e == 0 {
            (s as u16) << 15
        } else if e == 0xff {
            ((s as u16) << 15) | 0x7c00 | ((m >> 13) as u16)
        } else {
            let exp = e as i32 - 127 + 15;
            if exp >= 31 {
                ((s as u16) << 15) | 0x7c00
            } else if exp <= 0 {
                let m_sub = (m | 0x80_0000) >> (1 - exp + 13);
                ((s as u16) << 15) | (m_sub as u16)
            } else {
                ((s as u16) << 15) | ((exp as u16) << 10) | ((m >> 13) as u16)
            }
        }
    }

    #[test]
    fn synthetic_hdr_conversion_handles_sdr_white_and_highlights() {
        // Hand-made R16G16B16A16_FLOAT buffer with known values:
        // Width 4, Height 2, with row padding (pitch 48 bytes instead of 32 bytes).
        // Row 0:
        //  (0, 0): SDR white (1.0, 1.0, 1.0, 1.0)
        //  (1, 0): Highlight above 1.0 (1.5, 1.5, 1.5, 1.0)
        //  (2, 0): Pure red at SDR white (1.0, 0.0, 0.0, 1.0)
        //  (3, 0): Pure blue at SDR white (0.0, 0.0, 1.0, 1.0)
        // Row 1:
        //  (0, 1): Black (0.0, 0.0, 0.0, 1.0)
        //  (1, 1): 18% gray (0.18, 0.18, 0.18, 1.0)
        //  (2, 1): Extreme highlight (2.0, 2.0, 2.0, 1.0)
        //  (3, 1): Negative out-of-gamut (-0.5, 0.5, 0.0, 1.0)
        let width = 4u32;
        let height = 2u32;
        let pitch = 48usize; // 4 * 8 = 32 bytes + 16 bytes padding
        let mut raw = vec![0u8; pitch * height as usize];

        let put_px = |buf: &mut [u8], x: usize, y: usize, r: f32, g: f32, b: f32, a: f32| {
            let off = y * pitch + x * 8;
            buf[off..off + 2].copy_from_slice(&f32_to_f16(r).to_le_bytes());
            buf[off + 2..off + 4].copy_from_slice(&f32_to_f16(g).to_le_bytes());
            buf[off + 4..off + 6].copy_from_slice(&f32_to_f16(b).to_le_bytes());
            buf[off + 6..off + 8].copy_from_slice(&f32_to_f16(a).to_le_bytes());
        };

        // Row 0
        put_px(&mut raw, 0, 0, 1.0, 1.0, 1.0, 1.0); // SDR white
        put_px(&mut raw, 1, 0, 1.5, 1.5, 1.5, 1.0); // Highlight > 1.0
        put_px(&mut raw, 2, 0, 1.0, 0.0, 0.0, 1.0); // Pure red
        put_px(&mut raw, 3, 0, 0.0, 0.0, 1.0, 1.0); // Pure blue

        // Row 1
        put_px(&mut raw, 0, 1, 0.0, 0.0, 0.0, 1.0); // Black
        put_px(&mut raw, 1, 1, 0.18, 0.18, 0.18, 1.0); // Mid-tone
        put_px(&mut raw, 2, 1, 2.0, 2.0, 2.0, 1.0); // Extreme highlight
        put_px(&mut raw, 3, 1, -0.5, 0.5, 0.0, 1.0); // Out-of-gamut

        let frame = frame_from_staging(DXGI_FORMAT_R16G16B16A16_FLOAT, width, height, pitch, &raw);

        assert_eq!(frame.width, 4);
        assert_eq!(frame.height, 2);
        assert_eq!(frame.stride, 16, "stride must be 4 bytes per pixel (16 bytes for width 4)");
        assert_eq!(frame.bgra.len(), 16 * 2, "buffer length must be stride * height");

        // (0, 0) SDR white (1.0): must map to 255 in all channels
        assert_eq!(frame.pixel(0, 0), Some((255, 255, 255, 255)), "SDR white (1.0) must map to 255");

        // (1, 0) Highlight (1.5): must saturate at 255
        assert_eq!(frame.pixel(1, 0), Some((255, 255, 255, 255)), "Highlight (1.5) must saturate at 255");

        // (2, 0) Pure red: Blue=0, Green=0, Red=255, Alpha=255
        assert_eq!(frame.pixel(2, 0), Some((0, 0, 255, 255)), "Pure red must map to BGRA (0, 0, 255, 255)");

        // (3, 0) Pure blue: Blue=255, Green=0, Red=0, Alpha=255
        assert_eq!(frame.pixel(3, 0), Some((255, 0, 0, 255)), "Pure blue must map to BGRA (255, 0, 0, 255)");

        // (0, 1) Black: (0, 0, 0, 255)
        assert_eq!(frame.pixel(0, 1), Some((0, 0, 0, 255)), "Black must map to 0");

        // (1, 1) 18% gray: ~118 via sRGB transfer function (117.65 rounded; not linear 46)
        let mid = frame.pixel(1, 1).expect("mid-tone pixel readable");
        assert_eq!((mid.0, mid.1, mid.2), (118, 118, 118), "18% gray must map via sRGB transfer curve to 118");
    }

    #[test]
    fn synthetic_hdr_positive_control_distinguishes_sdr_white_from_mid_gray_and_black() {
        let width = 3u32;
        let height = 1u32;
        let pitch = 3 * 8;
        let mut raw = vec![0u8; pitch];

        let put_px = |buf: &mut [u8], x: usize, r: f32, g: f32, b: f32| {
            let off = x * 8;
            buf[off..off + 2].copy_from_slice(&f32_to_f16(r).to_le_bytes());
            buf[off + 2..off + 4].copy_from_slice(&f32_to_f16(g).to_le_bytes());
            buf[off + 4..off + 6].copy_from_slice(&f32_to_f16(b).to_le_bytes());
            buf[off + 6..off + 8].copy_from_slice(&f32_to_f16(1.0).to_le_bytes());
        };

        put_px(&mut raw, 0, 1.0, 1.0, 1.0); // SDR white
        put_px(&mut raw, 1, 0.18, 0.18, 0.18); // Mid-gray
        put_px(&mut raw, 2, 0.0, 0.0, 0.0); // Black

        let frame = frame_from_staging(DXGI_FORMAT_R16G16B16A16_FLOAT, width, height, pitch, &raw);
        let white = frame.pixel(0, 0).unwrap();
        let mid = frame.pixel(1, 0).unwrap();
        let black = frame.pixel(2, 0).unwrap();

        assert_ne!(white, mid, "white and mid-gray must be distinguishable");
        assert_ne!(mid, black, "mid-gray and black must be distinguishable");
        assert_ne!(white, black, "white and black must be distinguishable");
    }
}
