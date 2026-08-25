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
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, DXGI_ERROR_SESSION_DISCONNECTED,
    DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_MODE_ROTATION;

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

fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), CaptureError> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;

    // WARP as a fallback: a headless or RDP session may have no hardware
    // device, and refusing to capture there would rule out exactly the
    // unattended machines this is for.
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let hr = unsafe {
            D3D11CreateDevice(
                None,
                driver,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        };
        if hr.is_ok() {
            break;
        }
    }

    match (device, context) {
        (Some(d), Some(c)) => Ok((d, c)),
        _ => Err(CaptureError::Failed("could not create a D3D11 device".into())),
    }
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

/// Duplicate the given monitor's output.
fn duplicate(device: &ID3D11Device, monitor: usize) -> Result<IDXGIOutputDuplication, CaptureError> {
    unsafe {
        let found = each_output(|seen, output| {
            if seen != monitor {
                return None;
            }
            Some(output.cast::<IDXGIOutput1>().map_err(|e| {
                CaptureError::Failed(format!("output does not support duplication: {e}"))
            }))
        });
        match found {
            Some(Ok(output1)) => output1.DuplicateOutput(device).map_err(|e| {
                if e.code() == E_ACCESSDENIED || is_transient_display_state(e.code()) {
                    // E_ACCESSDENIED: the secure desktop, or another process
                    // holding an exclusive duplication. For the secure desktop
                    // this is a DESKTOP permission answer, not a DXGI limit —
                    // a SYSTEM process attached to Winlogon via SetThreadDesktop
                    // duplicates it normally (measured 2026-08-15). So the fix
                    // for that case is to follow the input desktop, not to
                    // reach for a different capture API. The transient family:
                    // a display powering down or detaching (DPMS sleep on
                    // some panels/links detaches the output entirely). All
                    // recoverable by re-duplicating later — a session must
                    // survive its host's screens going to sleep, because the
                    // controller's own input is what wakes them back up.
                    CaptureError::AccessLost
                } else {
                    CaptureError::Failed(format!("DuplicateOutput failed: {e}"))
                }
            }),
            Some(Err(e)) => Err(e),
            None => Err(CaptureError::Failed(format!("no monitor at index {monitor}"))),
        }
    }
}

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
        let (device, context) = create_device()?;
        let duplication = duplicate(&device, monitor)?;
        let rotation = rotation_of(monitor);
        Ok(Self {
            device,
            context,
            duplication: Some(duplication),
            monitor,
            rotation,
            staging: None,
            cursor: CursorState::default(),
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
            self.duplication = Some(duplicate(&self.device, self.monitor)?);
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

        let staging = self.staging_for(&desc)?;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context.CopyResource(&staging, &texture);
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| CaptureError::Failed(format!("Map failed: {e}")))?;
        }

        let stride = mapped.RowPitch as usize;
        let height = desc.Height as usize;
        let mut bgra = vec![0u8; stride * height];
        unsafe {
            std::ptr::copy_nonoverlapping(mapped.pData as *const u8, bgra.as_mut_ptr(), bgra.len());
            self.context.Unmap(&staging, 0);
        }

        let raw = Frame {
            width: desc.Width,
            height: desc.Height,
            stride,
            bgra,
        };
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
}
