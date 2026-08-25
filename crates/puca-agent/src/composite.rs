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
/// filter that keeps every source pixel's contribution; the last block on
/// each axis may be partial and averages only what exists.
fn paste_tile(
    canvas: &mut [u8],
    canvas_w: usize,
    canvas_h: usize,
    step: usize,
    dst_l: usize,
    dst_t: usize,
    frame: &Frame,
) {
    let stride = canvas_w * 4;
    let fw = frame.width as usize;
    let fh = frame.height as usize;
    if step == 0 {
        return;
    }
    // ONE upfront guard instead of a bounds check per sample: the emission
    // rule below (col < fw/step, row < fh/step) makes every block a FULL
    // step x step block whose samples lie inside [0, fh) rows and [0, fw)
    // columns — in range by these two facts alone. This loop runs at FULL
    // source resolution per dirty tile (that is what any downscaling filter
    // costs), so the inner accumulate must stay branch-free.
    if frame.stride < fw * 4 || frame.bgra.len() < frame.stride * fh {
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
            let src_row = row * frame.stride;
            let cols = fw.min(canvas_w.saturating_sub(dst_l));
            let src_end = src_row + cols * 4;
            if cols > 0 && src_end <= frame.bgra.len() && dst_row + cols * 4 <= canvas.len() {
                canvas[dst_row..dst_row + cols * 4].copy_from_slice(&frame.bgra[src_row..src_end]);
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
                let src_row = (row * step + yy) * frame.stride + x0;
                for xx in 0..step {
                    let at = src_row + xx * 4;
                    b += frame.bgra[at] as u32;
                    g += frame.bgra[at + 1] as u32;
                    r += frame.bgra[at + 2] as u32;
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
