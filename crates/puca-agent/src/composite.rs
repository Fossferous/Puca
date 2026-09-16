use puca_capture::{CaptureError, Frame, OutputInfo, ScreenCapture};

/// Monitor index meaning "every display stitched into one surface".
///
/// A sentinel, not an index — bounds-checking it against the monitor count is
/// how "All Displays" came to be accepted by StartStream and refused by
/// SetMonitor with "there is no screen 256". Named so the two paths cannot
/// disagree about what 255 means.
pub const ALL_DISPLAYS: usize = 255;

/// The largest surface we will composite before stepping pixels down.
///
/// The union of this machine's displays is not a resolution anyone chose: three
/// screens side by side is 5440x2567 here, ~14 megapixels. That is past what
/// the H.264 encoder will accept at common levels, it is ~56 MB of memory
/// traffic per frame before anything is encoded, and a phone would be asked to
/// decode it. Beyond this cap the composite is sampled down by an integer step,
/// which costs sharpness and saves the feature.
const MAX_COMPOSITE_W: u32 = 3840;
const MAX_COMPOSITE_H: u32 = 2160;

/// The bounding box of every output, in desktop pixels.
///
/// Pure so it can be tested against fabricated layouts with negative origins
/// and gaps — the shapes real hardware produces and no test machine reliably
/// has. Returns (left, top, width, height).
///
/// `pub(crate)` so `session::capture_surface` uses this one rather than adding a
/// third hand-written copy of the same min/max (`resolve_target` has the second,
/// and the two are pinned to agree by
/// `the_caret_mapping_and_the_input_aim_describe_the_same_composite`).
pub(crate) fn union_box(outputs: &[OutputInfo]) -> Option<(i32, i32, u32, u32)> {
    let left = outputs.iter().map(|o| o.left).min()?;
    let top = outputs.iter().map(|o| o.top).min()?;
    let right = outputs.iter().map(|o| o.left + o.width).max()?;
    let bottom = outputs.iter().map(|o| o.top + o.height).max()?;
    if right <= left || bottom <= top {
        return None;
    }
    Some((left, top, (right - left) as u32, (bottom - top) as u32))
}

/// How far to step the composite down, and the surface size that produces.
///
/// `step` is an integer so sampling is a plain index stride — no filtering, no
/// float maths per pixel. The output dimensions are forced EVEN because the
/// encoder rounds down to even (`stream.rs` masks with `!1`) and a composite
/// that reports a size the encoder does not use misaligns the NV12 conversion,
/// which shows up as a sheared or green picture rather than as an error.
pub(crate) fn composite_geometry(union_w: u32, union_h: u32) -> (u32, u32, u32) {
    let step_w = union_w.div_ceil(MAX_COMPOSITE_W).max(1);
    let step_h = union_h.div_ceil(MAX_COMPOSITE_H).max(1);
    let step = step_w.max(step_h);
    let out_w = (union_w / step) & !1;
    let out_h = (union_h / step) & !1;
    (step, out_w.max(2), out_h.max(2))
}

/// The shortest edge a viewer fit may leave.
///
/// A stage that is momentarily tiny (a layout mid-transition reports a few
/// pixels) must not collapse the stream to a thumbnail, and below this a
/// picture of a desktop carries nothing legible whatever the viewer asked for.
const MIN_FIT_EDGE: u32 = 320;

/// How far to step a picture down so it is no larger than the VIEWER can show.
///
/// `view_w`/`view_h` are the viewer's stage in ITS device pixels; 0 on either
/// axis means "no fit" and the picture stays native. The viewer letterboxes
/// (`object-fit: contain`), so it shows the source at
/// `min(view_w / src_w, view_h / src_h)` of its size; source pixels per shown
/// pixel is therefore the LARGER of the two axis ratios, and its integer part
/// is the step. Integer because the downscale is `paste_tile`'s box average —
/// a plain stride, no resampler — and integer division is exactly the floor
/// the maths wants.
///
/// WHY. A phone controlling a 1440x2560 portrait monitor decoded every one of
/// those pixels — 15.8 ms a frame on the owner's handset, half the 33 ms
/// budget at 30 fps — to show them at 607x1080. Step 2 sends a quarter of the
/// pixels and the phone displays the same picture. Turn the phone upright and
/// the stage is 1080x2400: the ratio drops under 2 and the picture goes back
/// to native, which is what a viewer who just made room for it wants.
pub(crate) fn fit_step(src_w: u32, src_h: u32, view_w: u32, view_h: u32) -> u32 {
    if src_w == 0 || src_h == 0 || view_w == 0 || view_h == 0 {
        return 1;
    }
    let mut step = (src_w / view_w).max(src_h / view_h).max(1);
    while step > 1 && (src_w / step < MIN_FIT_EDGE || src_h / step < MIN_FIT_EDGE) {
        step -= 1;
    }
    step
}

/// Step one whole picture down by `step` into `out`, which is reused across
/// frames (grown once, then written in place). Returns the output
/// `(width, height, stride)`. Dimensions are forced even for the same reason
/// `composite_geometry` forces them: the encoder rounds down to even, and a
/// picture that reports a size the encoder does not use shears the NV12
/// conversion.
/// Returns None — and writes nothing — for a picture whose stride and length
/// do not describe it. `paste_tile_raw` refuses such a picture silently (that
/// is right for a tile: the canvas keeps its last content), but here a silent
/// refusal would encode a black or a STALE buffer as the live picture, which
/// the viewer cannot tell from a frozen stream. The caller sends the native
/// picture instead and says so once.
pub(crate) fn downscale_into(
    out: &mut Vec<u8>,
    step: u32,
    width: u32,
    height: u32,
    stride: usize,
    bgra: &[u8],
) -> Option<(u32, u32, usize)> {
    let step = step.max(1);
    if stride < width as usize * 4 || bgra.len() < stride * height as usize {
        return None;
    }
    let out_w = ((width / step) & !1).max(2);
    let out_h = ((height / step) & !1).max(2);
    let len = out_w as usize * out_h as usize * 4;
    if out.len() != len {
        out.clear();
        out.resize(len, 0);
    }
    if step == 2 {
        downscale_2x(out, out_w as usize, out_h as usize, stride, bgra);
    } else {
        paste_tile_raw(
            out,
            out_w as usize,
            out_h as usize,
            step as usize,
            0,
            0,
            width as usize,
            height as usize,
            stride,
            bgra,
        );
    }
    Some((out_w, out_h, out_w as usize * 4))
}

/// The step-2 box average, which is nearly every fit there is (a phone held
/// sideways against a 1440p or 4K monitor), written so the inner loop has no
/// bounds checks: each source row pair and each output row are sliced once,
/// and `chunks_exact` lets the compiler vectorise the sums. Measured on the
/// owner's desktop against `paste_tile_raw`'s general loop at 1440x2560:
/// 5.6 ms a frame before, see `bench_fit_step2_1440x2560` for after. Byte-
/// identical to the general path (pinned by a test), so it is a speed-up and
/// not a second definition of the average.
///
/// The caller has checked that `stride >= width * 4` and that `bgra` holds
/// `stride * height` bytes, and `out_w * 2 <= width`, `out_h * 2 <= height`
/// by construction, so every slice below is in range.
fn downscale_2x(out: &mut [u8], out_w: usize, out_h: usize, stride: usize, bgra: &[u8]) {
    let src_row_bytes = out_w * 8;
    for row in 0..out_h {
        let top = row * 2 * stride;
        let a = &bgra[top..top + src_row_bytes];
        let b = &bgra[top + stride..top + stride + src_row_bytes];
        let dst = &mut out[row * out_w * 4..(row + 1) * out_w * 4];
        for ((d, p), q) in dst.chunks_exact_mut(4).zip(a.chunks_exact(8)).zip(b.chunks_exact(8)) {
            d[0] = ((p[0] as u16 + p[4] as u16 + q[0] as u16 + q[4] as u16) / 4) as u8;
            d[1] = ((p[1] as u16 + p[5] as u16 + q[1] as u16 + q[5] as u16) / 4) as u8;
            d[2] = ((p[2] as u16 + p[6] as u16 + q[2] as u16 + q[6] as u16) / 4) as u8;
            // Opaque: the picture never carries meaningful alpha.
            d[3] = 255;
        }
    }
}

/// How long a different step must hold before it is applied.
///
/// `fit_step` is a hard integer boundary, and a stage that oscillates across
/// it — an animating layout, a pinch settling, a keyboard bar opening — would
/// otherwise flip the encoded size on every frame, and each flip is an
/// encoder reconfigure plus a forced keyframe (or a full rebuild when the
/// transform refuses the live change). Nothing else a peer sends has that
/// amplification: a keyframe request costs one IDR. Half a second is long
/// enough for a rotation or a pinch to settle first, and short enough that a
/// deliberate change is not felt as a delay.
pub(crate) const FIT_SETTLE: std::time::Duration = std::time::Duration::from_millis(500);

/// Fitted frames the cost guard averages over before it decides.
const FIT_COST_WINDOW: u32 = 60;

/// The share of the frame interval the fit may cost, averaged over the
/// window, before it is turned off for the rest of the stream. The pump runs
/// capture, fit and encode in sequence, so a fit costing more than this on
/// top of a capture and an encode pushes the frame past its interval — and a
/// host that got slower after an update is worse than a phone that decodes
/// more. Measured on the owner's desktop the fit is far under this (see
/// `bench_fit_step2_1440x2560`); the guard exists for the host this was not
/// measured on.
const FIT_COST_BUDGET: f64 = 0.35;

/// One frame after the fit: the dimensions to encode, and whether the bytes
/// are in `FitState::buf` (fitted) or still the caller's (native).
pub(crate) struct Fitted {
    pub step: u32,
    pub w: u32,
    pub h: u32,
    pub stride: usize,
    pub from_buffer: bool,
}

/// The viewer fit's state across frames: the step in force, a change waiting
/// to settle, the reused buffer, and the cost guard. Kept out of the pump so
/// every decision here is tested without a capture.
pub(crate) struct FitState {
    /// The step in force, or None before the first frame.
    applied: Option<u32>,
    /// A different step the viewer has been asking for, and since when.
    pending: Option<(u32, std::time::Instant)>,
    /// The fitted picture, reused frame to frame.
    pub(crate) buf: Vec<u8>,
    /// Set once the guard has found the fit too expensive on this host.
    disabled: bool,
    /// The misdescribed-picture fallback is said once, not thirty times a second.
    degraded_logged: bool,
    cost_us: u64,
    cost_n: u32,
}

impl FitState {
    pub(crate) fn new() -> Self {
        Self {
            applied: None,
            pending: None,
            buf: Vec::new(),
            disabled: false,
            degraded_logged: false,
            cost_us: 0,
            cost_n: 0,
        }
    }

    /// The step to use for this frame, given the one the viewer's stage wants.
    ///
    /// The FIRST frame takes it at once: a media restart carries a known fit,
    /// and paying a native encoder build and then a reconfigure would be the
    /// freeze this exists to avoid. After that, a change must hold for
    /// `FIT_SETTLE` before it is applied, and a request that changes its mind
    /// in the meantime starts the clock again.
    pub(crate) fn decide(&mut self, wanted: u32, now: std::time::Instant) -> u32 {
        let wanted = if self.disabled { 1 } else { wanted.max(1) };
        let Some(applied) = self.applied else {
            self.applied = Some(wanted);
            return wanted;
        };
        if wanted == applied {
            self.pending = None;
            return applied;
        }
        match self.pending {
            Some((p, since)) if p == wanted => {
                if now.duration_since(since) >= FIT_SETTLE {
                    self.applied = Some(wanted);
                    self.pending = None;
                    return wanted;
                }
            }
            _ => self.pending = Some((wanted, now)),
        }
        applied
    }

    /// Fit one picture for the viewer. When the result says `from_buffer`,
    /// the bytes to encode are in `self.buf`; otherwise they are the caller's.
    pub(crate) fn apply(
        &mut self,
        view: Option<(u32, u32)>,
        width: u32,
        height: u32,
        stride: usize,
        bgra: &[u8],
        now: std::time::Instant,
    ) -> Fitted {
        let wanted = view.map(|(vw, vh)| fit_step(width, height, vw, vh)).unwrap_or(1);
        let before = self.applied;
        let step = self.decide(wanted, now);
        let native = Fitted { step: 1, w: width, h: height, stride, from_buffer: false };
        if step <= 1 {
            if before != Some(1) {
                eprintln!(
                    "[stream] fit: {width}x{height} native{}",
                    if self.disabled { " (fit off on this host)" } else { "" }
                );
            }
            return native;
        }
        match downscale_into(&mut self.buf, step, width, height, stride, bgra) {
            Some((w, h, s)) => {
                if before != Some(step) {
                    let (vw, vh) = view.unwrap_or((0, 0));
                    eprintln!(
                        "[stream] fit: {width}x{height} for a {vw}x{vh} stage -> step {step}, encoding {w}x{h}"
                    );
                }
                Fitted { step, w, h, stride: s, from_buffer: true }
            }
            None => {
                if !self.degraded_logged {
                    eprintln!(
                        "[stream] fit: the capture handed a picture its stride and length do not describe ({width}x{height}, stride {stride}, {} bytes) - sending it native",
                        bgra.len()
                    );
                    self.degraded_logged = true;
                }
                native
            }
        }
    }

    /// Account one FITTED frame's cost. After `FIT_COST_WINDOW` of them, if
    /// the average exceeds `FIT_COST_BUDGET` of the frame interval, the fit is
    /// turned off for the rest of this stream, at once, and the log says so.
    pub(crate) fn note_cost(&mut self, took: std::time::Duration, fps: u32) {
        if self.disabled {
            return;
        }
        self.cost_us += took.as_micros() as u64;
        self.cost_n += 1;
        if self.cost_n < FIT_COST_WINDOW {
            return;
        }
        let avg_us = self.cost_us as f64 / self.cost_n as f64;
        let interval_us = 1_000_000.0 / fps.max(1) as f64;
        self.cost_us = 0;
        self.cost_n = 0;
        if avg_us > interval_us * FIT_COST_BUDGET {
            self.disabled = true;
            self.applied = Some(1);
            self.pending = None;
            eprintln!(
                "[stream] fit: costs {:.1} ms a frame against a {:.1} ms frame interval on this host - sending native for the rest of this stream",
                avg_us / 1000.0,
                interval_us / 1000.0
            );
        }
    }

    #[cfg(test)]
    fn is_disabled(&self) -> bool {
        self.disabled
    }
}

/// Paste one tile's frame onto the canvas at `(dst_l, dst_t)` canvas pixels,
/// stepping the source down by `step`. Free and pure so the pixel bookkeeping
/// is testable without DXGI.
///
/// `step == 1` is a straight row copy, clamped to the row — the canvas is one
/// flat buffer, so a copy overrunning the right edge would land at the start
/// of the next line rather than out of bounds; the surface is also rounded
/// down to even, so a monitor can legitimately extend one pixel past it.
///
/// `step > 1` is a `step x step` BOX AVERAGE, not nearest-neighbour. Nearest
/// sampling threw away three of every four pixels at step 2, which aliased
/// small text on the all-displays view into unreadable speckle — the exact
/// "can the composite ever be legible?" complaint. Averaging is the cheapest
/// filter that keeps every source pixel's contribution. Only FULL blocks are
/// emitted: a trailing partial block (fewer than `step` source pixels on an
/// axis) is dropped, so up to `step - 1` columns and rows at the far edge are
/// not in the output. For the composite that edge is desktop the viewer never
/// aims at; for the viewer fit it is at most a few pixels at the right and
/// bottom of the screen (see `fit_step`).
fn paste_tile(
    canvas: &mut [u8],
    canvas_w: usize,
    canvas_h: usize,
    step: usize,
    dst_l: usize,
    dst_t: usize,
    frame: &Frame,
) {
    paste_tile_raw(
        canvas,
        canvas_w,
        canvas_h,
        step,
        dst_l,
        dst_t,
        frame.width as usize,
        frame.height as usize,
        frame.stride,
        &frame.bgra,
    );
}

/// `paste_tile` over a bare picture: `(fw, fh, fstride, fbytes)` rather than
/// a `Frame`, so the composite's retained canvas — which is not a Frame — can
/// be stepped down by the viewer fit without a copy into one.
#[allow(clippy::too_many_arguments)]
fn paste_tile_raw(
    canvas: &mut [u8],
    canvas_w: usize,
    canvas_h: usize,
    step: usize,
    dst_l: usize,
    dst_t: usize,
    fw: usize,
    fh: usize,
    fstride: usize,
    fbytes: &[u8],
) {
    let stride = canvas_w * 4;
    if step == 0 {
        return;
    }
    // ONE upfront guard instead of a bounds check per sample: the emission
    // rule below (col < fw/step, row < fh/step) makes every block a FULL
    // step x step block whose samples lie inside [0, fh) rows and [0, fw)
    // columns — in range by these two facts alone. This loop runs at FULL
    // source resolution per dirty tile (that is what any downscaling filter
    // costs), so the inner accumulate must stay branch-free.
    if fstride < fw * 4 || fbytes.len() < fstride * fh {
        return;
    }
    let n = (step * step) as u32;
    for row in 0..(fh / step) {
        let dst_y = dst_t + row;
        if dst_y >= canvas_h {
            break;
        }
        let dst_row = dst_y * stride + dst_l * 4;

        if step == 1 {
            let src_row = row * fstride;
            let cols = fw.min(canvas_w.saturating_sub(dst_l));
            let src_end = src_row + cols * 4;
            if cols > 0 && src_end <= fbytes.len() && dst_row + cols * 4 <= canvas.len() {
                canvas[dst_row..dst_row + cols * 4].copy_from_slice(&fbytes[src_row..src_end]);
            }
            continue;
        }

        for col in 0..(fw / step) {
            let dst_x = dst_l + col;
            if dst_x >= canvas_w {
                break;
            }
            let dst = dst_row + col * 4;
            if dst + 4 > canvas.len() {
                continue;
            }
            let x0 = col * step * 4;
            let (mut b, mut g, mut r) = (0u32, 0u32, 0u32);
            for yy in 0..step {
                let src_row = (row * step + yy) * fstride + x0;
                for xx in 0..step {
                    let at = src_row + xx * 4;
                    b += fbytes[at] as u32;
                    g += fbytes[at + 1] as u32;
                    r += fbytes[at + 2] as u32;
                }
            }
            canvas[dst] = (b / n) as u8;
            canvas[dst + 1] = (g / n) as u8;
            canvas[dst + 2] = (r / n) as u8;
            // Opaque: the composite never carries meaningful alpha.
            canvas[dst + 3] = 255;
        }
    }
}

/// A failed build, carrying back the capture the caller lent us (if any) so it
/// is never dropped on an error path.
enum BuildError {
    Failed(CaptureError, Option<ScreenCapture>),
}

/// One output inside the composite: which capture index it is, where its
/// top-left sits on the composited surface, and the last frame it produced.
///
/// The index is stored rather than implied by position because
/// `puca_capture::outputs()` omits an output it could not describe —
/// the vector can have GAPS, so position is not identity. Every lookup here is
/// by this field.
struct Tile {
    index: usize,
    capture: ScreenCapture,
    left: i32,
    top: i32,
    last_frame: Option<Frame>,
    /// Whether `last_frame` still needs pasting onto the retained canvas.
    dirty: bool,
}

pub struct VirtualCapture {
    captures: Vec<Tile>,
    width: u32,
    height: u32,
    /// How many source pixels each composited pixel steps over. 1 = native.
    step: u32,
    /// Where this surface's top-left sits on the DESKTOP. Stored rather than
    /// recomputed because it is frozen here at build time along with
    /// `step`/`width`/`height`: a monitor unplugged mid-session changes what a
    /// fresh `outputs()` would say and changes nothing about the surface this
    /// composite is still producing. Anything mapping a desktop coordinate onto
    /// this picture must use these numbers, not that enumeration.
    min_left: i32,
    min_top: i32,
    /// Which tile the NEXT empty-handed refresh blocks on — rotates per call
    /// so every monitor gets its turn at the acquire budget (see refresh).
    budget_cursor: usize,
    bgra: Vec<u8>,
}

/// The tile a blocking acquire should target: the cursor position, wrapped.
/// Pure so the rotation is testable without DXGI.
fn block_target(tile_count: usize, cursor: usize) -> Option<usize> {
    if tile_count == 0 {
        return None;
    }
    Some(cursor % tile_count)
}

impl VirtualCapture {
    pub fn new() -> Result<Self, CaptureError> {
        Self::build(None).map_err(|BuildError::Failed(e, _)| e)
    }

    /// Build the composite while REUSING a capture the caller already holds.
    ///
    /// DXGI duplication is exclusive per output. A live stream holds a
    /// duplication of the screen it is showing, and `new()` opens every output
    /// — including that one — so switching to All Displays collided with the
    /// caller's own capture and failed with AccessLost, every time, on every
    /// machine. There was no path by which the feature could work.
    ///
    /// On failure the adopted capture is handed BACK in the `Err`, because the
    /// caller's contract is that a refused switch leaves the current screen
    /// streaming; dropping it here would release the duplication and kill the
    /// session it was trying to protect.
    pub fn adopt(
        existing_index: usize,
        existing: ScreenCapture,
    ) -> Result<Self, (ScreenCapture, CaptureError)> {
        match Self::build(Some((existing_index, existing))) {
            Ok(v) => Ok(v),
            Err(BuildError::Failed(e, Some(returned))) => Err((returned, e)),
            Err(BuildError::Failed(e, None)) => {
                // Only reachable when no capture was passed in, which this call
                // site never does.
                debug_assert!(false, "adopt lost the capture it was given: {e}");
                Err((
                    ScreenCapture::new(existing_index)
                        .unwrap_or_else(|_| panic!("cannot recover capture {existing_index}")),
                    e,
                ))
            }
        }
    }

    /// Has ANY tile ever delivered a real frame onto the canvas?
    ///
    /// False means the canvas is still the zero-fill it was born with — a
    /// sleeping desktop, cold. The pump uses this to refuse to synthesize a
    /// "first keyframe" out of pure black on a session that has never sent
    /// anything: that black frame counted as delivery and disabled the
    /// no-first-frame wake escalation exactly when it was needed.
    pub fn has_content(&self) -> bool {
        self.captures.iter().any(|t| t.last_frame.is_some())
    }

    /// Take one output's capture back out of the composite.
    ///
    /// The mirror of `adopt`, and needed for the same reason: leaving All
    /// Displays for a single screen cannot call `ScreenCapture::new` for that
    /// screen, because this composite is still duplicating it. `None` when the
    /// index is not part of this composite.
    /// Toggle the pointer on every tile, and force a full repaint.
    ///
    /// Marking every tile dirty is what actually clears the old cursor: the
    /// canvas is retained between frames, so a tile that produces nothing new
    /// keeps its previous pixels — pointer included — indefinitely.
    pub fn set_draw_cursor(&mut self, on: bool) {
        for tile in &mut self.captures {
            tile.capture.set_draw_cursor(on);
            tile.dirty = true;
        }
    }

    pub fn take(&mut self, index: usize) -> Option<ScreenCapture> {
        let at = self.captures.iter().position(|t| t.index == index)?;
        Some(self.captures.remove(at).capture)
    }

    fn build(adopted: Option<(usize, ScreenCapture)>) -> Result<Self, BuildError> {
        let adopted_index = adopted.as_ref().map(|(i, _)| *i);
        // Driven by the CAPTURE enumeration, whose index is the one
        // `ScreenCapture::new` takes and whose rectangle belongs to that same
        // output. This used to walk `puca_input::list_monitors()` (GDI
        // order) and pass `m.index` to `ScreenCapture::new` (DXGI order) while
        // pasting the result at the GDI monitor's position — so on any machine
        // where the two orders differ the tiles were shuffled, and a mirrored
        // pair (one HMONITOR, two DXGI outputs) silently dropped a screen.
        let outputs = puca_capture::outputs();
        let mut spare = adopted;
        if outputs.is_empty() {
            return Err(BuildError::Failed(
                CaptureError::Failed("No monitors available".into()),
                spare.take().map(|(_, c)| c),
            ));
        }
        if let Some(idx) = adopted_index {
            if !outputs.iter().any(|o| o.index == idx) {
                return Err(BuildError::Failed(
                    CaptureError::Failed(format!("output {idx} is not capturable")),
                    spare.take().map(|(_, c)| c),
                ));
            }
        }

        let Some((min_left, min_top, union_w, union_h)) = union_box(&outputs) else {
            return Err(BuildError::Failed(
                CaptureError::Failed("the displays have no area".into()),
                spare.take().map(|(_, c)| c),
            ));
        };
        let (step, width, height) = composite_geometry(union_w, union_h);

        let mut captures: Vec<Tile> = Vec::new();
        for m in &outputs {
            // Reuse the caller's capture for its output; opening a second one
            // is exactly the collision this function exists to avoid.
            let taken = match &spare {
                Some((idx, _)) if *idx == m.index => spare.take().map(|(_, c)| c),
                _ => None,
            };
            let cap = match taken {
                Some(c) => c,
                None => match ScreenCapture::new(m.index) {
                    Ok(c) => c,
                    Err(e) => {
                        // Recover the adopted capture from wherever it is: still
                        // in hand, or already placed into the partial composite.
                        let recovered = spare.take().map(|(_, c)| c).or_else(|| {
                            adopted_index.and_then(|i| {
                                captures
                                    .iter()
                                    .position(|t| t.index == i)
                                    .map(|at| captures.remove(at).capture)
                            })
                        });
                        return Err(BuildError::Failed(e, recovered));
                    }
                },
            };
            captures.push(Tile {
                index: m.index,
                capture: cap,
                left: m.left - min_left,
                top: m.top - min_top,
                last_frame: None,
                dirty: false,
            });
        }

        let stride = (width * 4) as usize;
        let bgra = vec![0u8; stride * height as usize];

        Ok(Self {
            captures,
            width,
            height,
            step,
            min_left,
            min_top,
            budget_cursor: 0,
            bgra,
        })
    }

    /// Refresh the composited surface IN PLACE.
    ///
    /// Deliberately not returning a `Frame`: the frame owns its bytes, so
    /// handing one back meant cloning the whole canvas every tick — 56 MB per
    /// frame on this machine's virtual desktop, which is memory traffic the
    /// encoder then has to compete with. The caller reads the result through
    /// `surface()` instead, which borrows.
    pub fn refresh(&mut self, timeout_ms: u32) -> Result<(), CaptureError> {
        let mut any_success = false;
        let mut some_access_lost = false;
        let mut fallback_failed = None;

        // FAIR ACQUISITION, two passes. The old policy gave the FIRST tile
        // the whole timeout and every other tile 0ms — so on a multi-monitor
        // desktop the composite was paced by tile 0 alone: the budget was
        // spent blocking on an idle first monitor while another tile's ready
        // frame waited a whole pass, and non-first tiles only ever
        // contributed when a frame HAPPENED to be ready at a zero-timeout
        // poll. Pass 1 harvests every hot tile for free; pass 2 spends the
        // budget blocking on ONE tile — rotating per call, so every monitor
        // gets its turn — and only when pass 1 found nothing. Worst-case
        // block per refresh stays one acquire, same as before.
        let mut poll = |tile: &mut Tile, t: u32| match tile.capture.next_frame(t) {
            Ok(frame) => {
                tile.last_frame = Some(frame);
                tile.dirty = true;
                true
            }
            Err(CaptureError::Timeout) => false,
            Err(CaptureError::AccessLost) => {
                some_access_lost = true;
                false
            }
            Err(e) => {
                fallback_failed = Some(e);
                false
            }
        };
        for tile in &mut self.captures {
            if poll(tile, 0) {
                any_success = true;
            }
        }
        if !any_success && timeout_ms > 0 {
            if let Some(i) = block_target(self.captures.len(), self.budget_cursor) {
                self.budget_cursor = self.budget_cursor.wrapping_add(1);
                if poll(&mut self.captures[i], timeout_ms) {
                    any_success = true;
                }
            }
        }

        // ONE BAD SCREEN MUST NOT BLANK THE OTHERS.
        //
        // This used to return AccessLost the moment ANY tile lost its
        // duplication, before pasting anything — so a single monitor that was
        // asleep, running a fullscreen-exclusive game, or showing protected
        // content stopped the whole composite dead, and All Displays showed
        // nothing at all while two perfectly good screens were being captured.
        // With three monitors that is three times as likely to happen.
        //
        // A lost tile keeps its last picture on the retained canvas instead.
        // `ScreenCapture::next_frame` rebuilds its own duplication on the next
        // call, so the tile heals itself; until it does, one stale screen
        // beside two live ones is plainly better than a black rectangle. Do not
        // "fix" this back to failing fast.
        if !any_success {
            if some_access_lost {
                return Err(CaptureError::AccessLost);
            }
            if let Some(e) = fallback_failed {
                return Err(e);
            }
            return Err(CaptureError::Timeout);
        }

        // Paste only what changed: the canvas is retained between calls, so
        // re-copying a monitor that produced no new frame is pure cost.
        let step = self.step as usize;
        let (canvas_w, canvas_h) = (self.width as usize, self.height as usize);
        for tile in &mut self.captures {
            if !tile.dirty {
                continue;
            }
            let Some(frame) = &tile.last_frame else { continue };
            tile.dirty = false;

            // Destination is in COMPOSITED pixels, so the monitor's origin
            // steps down with everything else.
            paste_tile(
                &mut self.bgra,
                canvas_w,
                canvas_h,
                step,
                tile.left as usize / step,
                tile.top as usize / step,
                frame,
            );
        }

        Ok(())
    }

    /// Which desktop rectangle this composite shows, and at what step:
    /// (min_left, min_top, step, out_w, out_h) — every one of them as FROZEN at
    /// build time.
    ///
    /// Exists so the caret mapping asks the capture in hand what it is showing
    /// instead of re-deriving it from a fresh enumeration, which is the only
    /// version of that question that stays true after a hot-plug.
    pub fn desktop_extent(&self) -> (i32, i32, u32, u32, u32) {
        (self.min_left, self.min_top, self.step, self.width, self.height)
    }

    /// The composited surface: (width, height, stride, pixels).
    pub fn surface(&self) -> (u32, u32, usize, &[u8]) {
        (self.width, self.height, (self.width * 4) as usize, &self.bgra)
    }

    /// Owned copy of the surface, for the raw (non-streaming) capture path.
    ///
    /// The clone lives HERE, on the path that polls a frame at a time over a
    /// pipe, and no longer on the streaming path that runs sixty times a
    /// second.
    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<Frame, CaptureError> {
        self.refresh(timeout_ms)?;
        let (width, height, stride, bgra) = self.surface();
        Ok(Frame { width, height, stride, bgra: bgra.to_vec() })
    }
}

pub enum AnyCapture {
    Single(ScreenCapture),
    Virtual(VirtualCapture),
}

impl AnyCapture {
    /// Cursor ownership, applied to EVERY member of a composite.
    ///
    /// All Displays draws the pointer per tile — each tile is its own
    /// ScreenCapture — so toggling only the composite would leave the cursor
    /// in whichever screen it happened to be over.
    ///
    /// The retained pixels are dropped with it: both the composite canvas and
    /// a still screen's re-encoded last frame hold the cursor already BAKED
    /// IN, so without invalidation the pointer stays frozen on screen until
    /// something else happens to change those pixels.
    pub fn set_draw_cursor(&mut self, on: bool) {
        match self {
            Self::Single(c) => c.set_draw_cursor(on),
            Self::Virtual(c) => c.set_draw_cursor(on),
        }
    }

    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<Frame, CaptureError> {
        match self {
            Self::Single(c) => c.next_frame(timeout_ms),
            Self::Virtual(c) => c.next_frame(timeout_ms),
        }
    }

    /// What this capture is showing, in desktop pixels, for mapping a caret onto
    /// it.
    ///
    /// ASKED OF THE CAPTURE, not of a fresh enumeration — the composite's
    /// geometry is frozen at build time and `outputs()` is not. Only the
    /// single-screen arm needs an enumeration, and it needs a CURRENT one: a
    /// display-mode change moves that rectangle under us with nothing to notify
    /// this loop, which is the same reason `next_frame` re-reads rotation.
    pub(crate) fn caret_surface(&self, monitor: usize) -> Option<crate::session::CaptureSurface> {
        match self {
            Self::Virtual(v) => {
                let (min_left, min_top, step, out_w, out_h) = v.desktop_extent();
                Some(crate::session::CaptureSurface::Composite {
                    min_left,
                    min_top,
                    step,
                    out_w,
                    out_h,
                })
            }
            // A single capture is never the composite. If the two ever disagreed
            // the honest answer is "no surface" (the viewer holds its view)
            // rather than a composite mapping applied to one screen's picture.
            Self::Single(_) if monitor != ALL_DISPLAYS => {
                crate::session::capture_surface(monitor, &puca_capture::outputs())
            }
            Self::Single(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(index: usize, left: i32, top: i32, width: i32, height: i32) -> OutputInfo {
        OutputInfo {
            index, left, top, width, height,
            hmonitor: 0x1000 + index as isize,
            rotation: puca_capture::Rotation::None,
        }
    }

    #[test]
    fn the_union_box_covers_every_output_including_negative_origins() {
        // The reporter's real layout: the primary at the origin, one screen to
        // its right and one to its LEFT, so both minima are negative.
        let outputs = vec![
            out(0, 0, 0, 2560, 1440),
            out(1, 2560, -685, 1440, 2560),
            out(2, -1440, -692, 1440, 2560),
        ];
        assert_eq!(union_box(&outputs), Some((-1440, -692, 5440, 2567)));
    }

    #[test]
    fn the_union_box_ignores_gaps_in_the_output_list() {
        // `outputs()` omits an output it could not describe, so indexes are not
        // positions. The box must still be the union of what IS there.
        let outputs = vec![out(0, 0, 0, 1920, 1080), out(3, 1920, 0, 1920, 1080)];
        assert_eq!(union_box(&outputs), Some((0, 0, 3840, 1080)));
        assert_eq!(union_box(&[]), None);
    }

    fn test_frame(w: u32, h: u32, bgra: Vec<u8>) -> Frame {
        Frame { width: w, height: h, stride: w as usize * 4, bgra }
    }

    #[test]
    fn a_stepped_paste_averages_the_block_not_a_corner() {
        // A 4x4 checkerboard of 0x00/0xFF greys at step 2: every 2x2 block
        // holds two of each, so a BOX AVERAGE lands on mid-grey (127) in
        // every output pixel — while nearest-neighbour, which sampled one
        // corner, would produce pure 0x00 or 0xFF. This is the test that can
        // fail.
        let mut bgra = vec![0u8; 4 * 4 * 4];
        for y in 0..4usize {
            for x in 0..4usize {
                let v = if (x + y) % 2 == 0 { 0x00 } else { 0xFF };
                let at = (y * 4 + x) * 4;
                bgra[at..at + 3].fill(v);
                bgra[at + 3] = 255;
            }
        }
        let frame = test_frame(4, 4, bgra);
        let mut canvas = vec![0u8; 2 * 2 * 4];
        paste_tile(&mut canvas, 2, 2, 2, 0, 0, &frame);
        for px in canvas.chunks_exact(4) {
            assert_eq!(&px[..3], &[127, 127, 127], "a stepped block must average, not sample");
            assert_eq!(px[3], 255);
        }
    }

    #[test]
    fn trailing_source_pixels_emit_nothing_and_full_blocks_average() {
        // 3x3 frame at step 2: fw/step = 1, so exactly ONE output column is
        // emitted (the same rule as the old sampler) and every emitted block
        // is therefore a FULL step x step block — the fact the branch-free
        // inner loop's bounds safety rests on. The trailing source column
        // contributes nothing.
        let mut bgra = vec![0u8; 3 * 3 * 4];
        for y in 0..3usize {
            for (x, v) in [10u8, 30, 200].into_iter().enumerate() {
                let at = (y * 3 + x) * 4;
                bgra[at..at + 3].fill(v);
                bgra[at + 3] = 255;
            }
        }
        let frame = test_frame(3, 3, bgra);
        let mut canvas = vec![0u8; 2 * 4];
        paste_tile(&mut canvas, 2, 1, 2, 0, 0, &frame);
        assert_eq!(&canvas[0..3], &[20, 20, 20], "full block: (10+30+10+30)/4");
        assert_eq!(&canvas[4..7], &[0, 0, 0], "no phantom second column");
    }

    #[test]
    fn a_step_one_paste_is_a_straight_copy_with_the_edge_clamped() {
        // Positive control that the fast path is untouched — including the
        // right-edge clamp: a frame one pixel wider than the canvas must not
        // wrap onto the next row.
        let mut bgra = vec![0u8; 3 * 1 * 4];
        for (i, v) in [1u8, 2, 3].into_iter().enumerate() {
            bgra[i * 4..i * 4 + 3].fill(v);
        }
        let frame = test_frame(3, 1, bgra);
        let mut canvas = vec![0u8; 2 * 2 * 4];
        paste_tile(&mut canvas, 2, 2, 1, 0, 0, &frame);
        assert_eq!(canvas[0], 1);
        assert_eq!(canvas[4], 2);
        assert_eq!(&canvas[8..12], &[0, 0, 0, 0], "the third pixel must clip, not wrap");
    }

    #[test]
    fn the_block_target_rotates_through_every_tile_and_refuses_zero() {
        assert_eq!(block_target(0, 5), None);
        assert_eq!(block_target(3, 0), Some(0));
        assert_eq!(block_target(3, 1), Some(1));
        assert_eq!(block_target(3, 2), Some(2));
        assert_eq!(block_target(3, 3), Some(0), "the cursor wraps");
        assert_eq!(block_target(1, usize::MAX), Some(0));
    }

    // ---- the viewer fit -------------------------------------------------

    /// The owner's case, measured 2026-09-16: a 1440x2560 portrait monitor
    /// on a phone held sideways (2400x1080 device px). Every source pixel was
    /// decoded (15.8 ms a frame) to be shown at 607x1080. Step 2 sends a
    /// quarter of them; the phone shows the same picture.
    #[test]
    fn the_owners_phone_in_landscape_halves_a_portrait_monitor() {
        assert_eq!(fit_step(1440, 2560, 2400, 1080), 2);
    }

    /// Turn the phone upright and the stage is 1080x2400: the ratio is 1.33,
    /// under 2, so the picture goes back to native — the viewer just made
    /// room for it.
    #[test]
    fn the_same_phone_upright_gets_the_picture_back_native() {
        assert_eq!(fit_step(1440, 2560, 1080, 2400), 1);
    }

    #[test]
    fn a_4k_desktop_on_a_1080p_stage_steps_by_two() {
        assert_eq!(fit_step(3840, 2160, 1920, 1080), 2);
    }

    /// Integer steps only: a 2560x1440 desktop on a 1920x1080 stage is 1.33
    /// source pixels per shown pixel, and the box average has no half step.
    #[test]
    fn a_fraction_short_of_two_stays_native() {
        assert_eq!(fit_step(2560, 1440, 1920, 1080), 1);
    }

    #[test]
    fn a_stage_larger_than_the_source_never_upscales() {
        assert_eq!(fit_step(1920, 1080, 3840, 2160), 1);
    }

    /// 0 on either axis is the wire's "no fit" — an older app, or the user
    /// choosing full resolution — and must never divide by it.
    #[test]
    fn no_stage_means_native() {
        assert_eq!(fit_step(1920, 1080, 0, 0), 1);
        assert_eq!(fit_step(1920, 1080, 0, 1080), 1);
        assert_eq!(fit_step(1920, 1080, 1920, 0), 1);
        assert_eq!(fit_step(0, 0, 1920, 1080), 1);
    }

    /// A layout mid-transition can report a stage of a few pixels. The fit is
    /// clamped so the shorter edge never drops under MIN_FIT_EDGE, rather than
    /// collapsing the stream to a thumbnail for a frame.
    #[test]
    fn a_momentarily_tiny_stage_cannot_collapse_the_picture() {
        // 1080 / 3 = 360 fits; 1080 / 4 = 270 would not.
        assert_eq!(fit_step(1920, 1080, 100, 100), 3);
        assert_eq!(fit_step(1920, 1080, 1, 1), 3);
    }

    /// A pinch zoom reports a LARGER stage (the picture is shown at 2x), so
    /// the step drops and the viewer gets the pixels they zoomed in for.
    #[test]
    fn a_zoomed_viewer_gets_its_pixels_back() {
        assert_eq!(fit_step(1440, 2560, 2400, 1080), 2, "fitted");
        assert_eq!(fit_step(1440, 2560, 4800, 2160), 1, "zoomed 2x");
    }

    /// The downscale is the same BOX AVERAGE as the composite's tiles: the
    /// checkerboard below has two 0x00 and two 0xFF in every 2x2 block, so
    /// every output pixel is mid-grey. Nearest sampling would give a corner.
    #[test]
    fn a_fitted_frame_is_box_averaged_to_even_dimensions() {
        let mut bgra = vec![0u8; 4 * 4 * 4];
        for y in 0..4usize {
            for x in 0..4usize {
                let v = if (x + y) % 2 == 0 { 0x00 } else { 0xFF };
                let at = (y * 4 + x) * 4;
                bgra[at..at + 3].fill(v);
                bgra[at + 3] = 255;
            }
        }
        let mut out = Vec::new();
        let (w, h, stride) = downscale_into(&mut out, 2, 4, 4, 16, &bgra).expect("a well-formed picture fits");
        assert_eq!((w, h, stride), (2, 2, 8));
        assert_eq!(out.len(), 2 * 2 * 4);
        for px in out.chunks(4) {
            assert_eq!(&px[..3], &[127, 127, 127], "box average, not a corner");
            assert_eq!(px[3], 255, "opaque");
        }
        // Odd results round DOWN to even: 6 / 2 = 3 -> 2 rows.
        let bgra6 = vec![9u8; 8 * 6 * 4];
        let (w, h, _) = downscale_into(&mut out, 2, 8, 6, 32, &bgra6).expect("fits");
        assert_eq!((w, h), (4, 2));
    }

    /// The buffer is reused frame to frame: a second call at the same size
    /// must not reallocate (the pump runs thirty times a second).
    #[test]
    fn the_fitted_buffer_is_reused_at_a_stable_size() {
        let bgra = vec![1u8; 8 * 8 * 4];
        let mut out = Vec::new();
        downscale_into(&mut out, 2, 8, 8, 32, &bgra).expect("fits");
        let ptr = out.as_ptr();
        let cap = out.capacity();
        downscale_into(&mut out, 2, 8, 8, 32, &bgra).expect("fits");
        assert_eq!((out.as_ptr(), out.capacity()), (ptr, cap));
    }

    /// A picture whose stride or length does not describe it is REFUSED, not
    /// half-written: the alternative was encoding a black or a stale buffer
    /// as the live picture, indistinguishable from a frozen stream.
    #[test]
    fn a_misdescribed_picture_is_refused_and_nothing_is_written() {
        let mut out = Vec::new();
        assert!(downscale_into(&mut out, 2, 8, 8, 32, &vec![0u8; 100]).is_none(), "too short");
        assert!(downscale_into(&mut out, 2, 8, 8, 16, &vec![0u8; 8 * 8 * 4]).is_none(), "stride under the width");
        assert!(out.is_empty(), "nothing was written for a refused picture");
    }

    // ---- the fit across frames: FitState -------------------------------

    fn ms(n: u64) -> std::time::Duration {
        std::time::Duration::from_millis(n)
    }

    fn checkerboard(w: usize, h: usize) -> Vec<u8> {
        let mut bgra = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let v = if (x + y) % 2 == 0 { 0x00 } else { 0xFF };
                let at = (y * w + x) * 4;
                bgra[at..at + 3].fill(v);
                bgra[at + 3] = 255;
            }
        }
        bgra
    }

    /// A media restart carries a known fit. Building the encoder native and
    /// reconfiguring it half a second later would be the freeze this avoids.
    #[test]
    fn the_first_frame_takes_the_fit_at_once() {
        let mut f = FitState::new();
        assert_eq!(f.decide(2, std::time::Instant::now()), 2);
    }

    #[test]
    fn a_changed_step_waits_until_it_has_held() {
        let mut f = FitState::new();
        let t = std::time::Instant::now();
        assert_eq!(f.decide(2, t), 2);
        assert_eq!(f.decide(1, t + ms(100)), 2, "not yet");
        assert_eq!(f.decide(1, t + ms(400)), 2, "still not");
        assert_eq!(f.decide(1, t + ms(700)), 1, "held for FIT_SETTLE");
    }

    /// THE AMPLIFICATION THIS GUARDS. Each applied change is an encoder
    /// reconfigure and a forced keyframe; a stage flapping across the step
    /// boundary — or a peer spamming SetViewSize — must not be able to buy
    /// one per frame.
    #[test]
    fn a_flapping_stage_never_moves_the_step() {
        let mut f = FitState::new();
        let t = std::time::Instant::now();
        assert_eq!(f.decide(2, t), 2);
        let mut changes = 0;
        let mut last = 2;
        for i in 1..=30u64 {
            let wanted = if i % 2 == 0 { 2 } else { 1 };
            let got = f.decide(wanted, t + ms(100 * i));
            if got != last {
                changes += 1;
                last = got;
            }
        }
        assert_eq!(changes, 0, "flapping every 100 ms for 3 s changed the step {changes} time(s)");
    }

    #[test]
    fn a_settled_change_and_a_settled_return_cost_one_change_each() {
        let mut f = FitState::new();
        let t = std::time::Instant::now();
        assert_eq!(f.decide(2, t), 2);
        assert_eq!(f.decide(1, t + ms(100)), 2);
        assert_eq!(f.decide(1, t + ms(700)), 1);
        assert_eq!(f.decide(2, t + ms(800)), 1);
        assert_eq!(f.decide(2, t + ms(1400)), 2);
    }

    #[test]
    fn apply_fits_into_its_buffer_and_reports_the_encoded_size() {
        let (w, h) = (640u32, 640u32);
        let bgra = checkerboard(640, 640);
        let mut f = FitState::new();
        let t = std::time::Instant::now();
        let out = f.apply(Some((320, 320)), w, h, 640 * 4, &bgra, t);
        assert_eq!((out.step, out.w, out.h, out.stride, out.from_buffer), (2, 320, 320, 1280, true));
        assert_eq!(f.buf.len(), 320 * 320 * 4);
        assert!(f.buf.chunks(4).all(|px| px[0] == 127 && px[1] == 127 && px[2] == 127 && px[3] == 255));
        // The stage goes away: the fit HOLDS through the settle time, then
        // the caller's bytes are used again, at the native size.
        let out = f.apply(None, w, h, 640 * 4, &bgra, t + ms(100));
        assert!(out.from_buffer, "a change waits");
        let out = f.apply(None, w, h, 640 * 4, &bgra, t + ms(700));
        assert_eq!((out.step, out.w, out.h, out.from_buffer), (1, 640, 640, false));
    }

    #[test]
    fn a_picture_the_capture_misdescribes_is_sent_native_not_stale() {
        let mut f = FitState::new();
        let out = f.apply(Some((320, 320)), 640, 640, 640 * 4, &vec![0u8; 100], std::time::Instant::now());
        assert_eq!((out.step, out.w, out.h, out.from_buffer), (1, 640, 640, false));
    }

    #[test]
    fn the_cost_guard_turns_the_fit_off_on_a_slow_host_and_not_on_a_fast_one() {
        let t = std::time::Instant::now();
        let mut slow = FitState::new();
        slow.decide(2, t);
        // 20 ms a frame against a 33 ms interval at 30 fps.
        for _ in 0..FIT_COST_WINDOW {
            slow.note_cost(ms(20), 30);
        }
        assert!(slow.is_disabled());
        assert_eq!(slow.decide(2, t), 1, "off means native at once, not after a settle");

        let mut fast = FitState::new();
        fast.decide(2, t);
        for _ in 0..FIT_COST_WINDOW {
            fast.note_cost(ms(4), 30);
        }
        assert!(!fast.is_disabled());
        assert_eq!(fast.decide(2, t), 2);
        // 4 ms is 24% of the 16.7 ms interval at 60 fps: still on.
        for _ in 0..FIT_COST_WINDOW {
            fast.note_cost(ms(4), 60);
        }
        assert!(!fast.is_disabled());
        // 7 ms is 42% of it: off.
        for _ in 0..FIT_COST_WINDOW {
            fast.note_cost(ms(7), 60);
        }
        assert!(fast.is_disabled());
    }

    /// The step-2 fast path is a SPEED-UP of the general loop, not a second
    /// definition of the average: on a picture with every channel varying
    /// per pixel, and with padding in the stride, both must agree byte for
    /// byte. (The general path is called directly with the tile pasting
    /// machinery, exactly as downscale_into did before the fast path.)
    #[test]
    fn the_step_two_fast_path_matches_the_general_box_average_byte_for_byte() {
        let (w, h, stride) = (646usize, 330usize, 646 * 4 + 32);
        let mut bgra = vec![0u8; stride * h];
        let mut x: u32 = 0x2545_F491;
        for byte in bgra.iter_mut() {
            // xorshift32: deterministic, every channel different.
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *byte = (x >> 24) as u8;
        }
        let mut fast = Vec::new();
        let (ow, oh, ostride) = downscale_into(&mut fast, 2, w as u32, h as u32, stride, &bgra).expect("fits");
        let mut general = vec![0u8; ow as usize * oh as usize * 4];
        paste_tile_raw(&mut general, ow as usize, oh as usize, 2, 0, 0, w, h, stride, &bgra);
        assert_eq!((ow, oh, ostride), (322, 164, 322 * 4));
        assert_eq!(fast, general, "the fast path drifted from the general average");
    }

    /// Not a test — a measurement, so the cost guard's budget is set against a
    /// number rather than a guess:
    /// `cargo test --release -p puca-agent bench_fit -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_fit_step2_1440x2560() {
        let (w, h) = (1440u32, 2560u32);
        let bgra = vec![0x7fu8; (w * h * 4) as usize];
        let mut out = Vec::new();
        downscale_into(&mut out, 2, w, h, (w * 4) as usize, &bgra).expect("fits");
        let t = std::time::Instant::now();
        for _ in 0..60 {
            downscale_into(&mut out, 2, w, h, (w * 4) as usize, &bgra).expect("fits");
        }
        eprintln!("fit 1440x2560 step 2: {:.2} ms/frame", t.elapsed().as_secs_f64() * 1000.0 / 60.0);
    }

    #[test]
    fn a_surface_within_the_cap_is_not_stepped_down() {
        let (step, w, h) = composite_geometry(3840, 1080);
        assert_eq!((step, w, h), (1, 3840, 1080));
    }

    #[test]
    fn an_oversized_surface_steps_down_to_fit_the_cap() {
        // The reporter's virtual desktop.
        let (step, w, h) = composite_geometry(5440, 2567);
        assert_eq!(step, 2, "5440 needs halving to fit 3840");
        assert!(w <= MAX_COMPOSITE_W && h <= MAX_COMPOSITE_H);
        assert_eq!((w, h), (2720, 1282), "2567/2 = 1283.5 -> 1283 -> evened to 1282");

        // Three 2560x1440 side by side: 7680 wide needs a step of 2.
        let (step, w, h) = composite_geometry(7680, 1440);
        assert_eq!((step, w, h), (2, 3840, 720));

        // Past twice the cap in one axis.
        let (step, _, _) = composite_geometry(12000, 1080);
        assert_eq!(step, 4);

        // A tall stack is capped by HEIGHT, not width.
        let (step, _, h) = composite_geometry(1440, 7680);
        assert_eq!(step, 4);
        assert!(h <= MAX_COMPOSITE_H);
    }

    /// EVEN dimensions are not cosmetic: `pump_frame` builds the encoder with
    /// `width & !1`, so a composite that reports an odd size hands the NV12
    /// conversion a different geometry than the encoder was created with —
    /// which shears the picture rather than failing.
    #[test]
    fn composited_dimensions_are_always_even() {
        for (w, h) in [(5440u32, 2567u32), (1921, 1081), (3839, 2159), (2, 2), (1, 1)] {
            let (_, ow, oh) = composite_geometry(w, h);
            assert_eq!(ow % 2, 0, "width {ow} from {w} must be even");
            assert_eq!(oh % 2, 0, "height {oh} from {h} must be even");
            assert!(ow >= 2 && oh >= 2, "a surface must never collapse to nothing");
        }
    }

    // --- live, on real hardware -------------------------------------------
    //
    // The composite bug cannot be reproduced without a real DXGI duplication:
    // it IS the exclusivity rule. These follow the conventions in
    // crates/puca-capture/tests/live_capture.rs — ignored by default,
    // and they must be run single-threaded because two of them contending for
    // the same output would fail for the wrong reason:
    //
    //   cargo test -p puca-agent -- --ignored --nocapture --test-threads=1

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real desktop; run with --ignored --test-threads=1"]
    fn live_the_composite_cannot_open_a_screen_someone_else_holds() {
        // POSITIVE CONTROL for the test below. If this ever stops failing, DXGI
        // exclusivity no longer holds on this machine and the adopt test proves
        // nothing.
        let held = ScreenCapture::new(0).expect("open screen 0");
        let collided = VirtualCapture::new();
        assert!(
            collided.is_err(),
            "VirtualCapture::new() opened a screen that was already duplicated — \
             the exclusivity this whole fix works around is not in effect",
        );
        drop(held);
    }

    /// Write the composite to a BMP when `SOVEREIGN_COMPOSITE_DUMP` names a
    /// path. Off by default and does nothing without it.
    ///
    /// "All Displays shows nothing" is the one report in this feature that
    /// assertions genuinely cannot settle. Every dimension can be correct while
    /// the picture is still wrong — a tile pasted at the wrong aspect, or a
    /// screen that captured black — and the only way to tell is to look. That
    /// is how the portrait monitors were caught: their rects said 1440x2560 and
    /// their frames were 2560x1440, so two thirds of the mosaic was a sideways
    /// smear inside a correctly sized surface.
    #[cfg(windows)]
    fn dump_bmp(composite: &VirtualCapture) {
        let Some(path) = std::env::var_os("SOVEREIGN_COMPOSITE_DUMP") else { return };
        let (w, h, stride, bgra) = composite.surface();
        let (w, h) = (w as usize, h as usize);
        let row = ((w * 3) + 3) & !3;
        let mut px = vec![0u8; row * h];
        for y in 0..h {
            for x in 0..w {
                let src = y * stride + x * 4;
                let dst = (h - 1 - y) * row + x * 3;
                if src + 3 <= bgra.len() {
                    px[dst..dst + 3].copy_from_slice(&bgra[src..src + 3]);
                }
            }
        }
        let mut bmp = Vec::with_capacity(54 + px.len());
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&((54 + px.len()) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&(w as i32).to_le_bytes());
        bmp.extend_from_slice(&(h as i32).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&24u16.to_le_bytes());
        bmp.extend_from_slice(&[0; 24]);
        bmp.extend_from_slice(&px);
        std::fs::write(&path, &bmp).expect("could not write the composite dump");
        eprintln!("composite dumped to {}", path.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real desktop; run with --ignored --test-threads=1"]
    fn live_the_composite_adopts_the_screen_already_being_streamed() {
        // THE FIX. A live stream holds screen 0; switching to All Displays must
        // succeed by adopting that capture rather than opening a second one.
        let held = ScreenCapture::new(0).expect("open screen 0");
        let mut composite = match VirtualCapture::adopt(0, held) {
            Ok(v) => v,
            Err((_, e)) => panic!("adopt failed while holding screen 0: {e}"),
        };

        let (w, h, stride, _) = composite.surface();
        let outputs = puca_capture::outputs();
        let (_, _, uw, uh) = union_box(&outputs).expect("a desktop with area");
        let (_, expect_w, expect_h) = composite_geometry(uw, uh);
        assert_eq!((w, h), (expect_w, expect_h), "the surface must match the geometry helper");
        assert_eq!(stride, (w * 4) as usize);
        eprintln!("composite {w}x{h} from a {uw}x{uh} desktop across {} outputs", outputs.len());

        // And it must actually produce pixels.
        let mut got = false;
        for _ in 0..30 {
            match composite.refresh(50) {
                Ok(()) => { got = true; break; }
                Err(CaptureError::Timeout) => continue,
                Err(e) => panic!("composite refresh failed: {e}"),
            }
        }
        assert!(got, "the composite never produced a frame");
        dump_bmp(&composite);

        // MIRROR: leaving All Displays takes the screen back out rather than
        // re-opening one the composite still holds.
        let recovered = composite.take(0).expect("screen 0 is part of the composite");
        assert!(
            ScreenCapture::new(0).is_err(),
            "take() returned something that was not the live duplication",
        );
        drop(recovered);
        assert!(
            ScreenCapture::new(0).is_ok(),
            "dropping the taken capture must release the screen",
        );
    }
}
