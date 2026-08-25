//! Media Foundation H.264 encoder.
//!
//! The MFT contract, and the parts that bite:
//!
//!  * The OUTPUT type must be set before the input type. Doing it the other way
//!    round fails with a type-negotiation error that names neither.
//!  * The encoder takes NV12, not BGRA, so every frame is converted. That
//!    conversion is the CPU cost in this file; a GPU path would keep the frame
//!    in a texture, which is a later optimisation and not correctness.
//!  * `ProcessOutput` returns MF_E_TRANSFORM_NEED_MORE_INPUT constantly at
//!    startup while the pipeline fills. That is NORMAL. Treating it as an error
//!    is why naive encoders look broken for the first second.
//!  * Buffers must be unlocked before the sample is released, or the next
//!    ProcessInput fails in a way that looks like a codec bug.
//!  * A GPU encoder is NOT obtained by asking for the encoder — it is a
//!    different MFT with a different contract. `CLSID_MSH264EncoderMFT` names
//!    the Microsoft SOFTWARE encoder specifically; NVENC, Quick Sync and AMF
//!    are only reachable through `MFTEnumEx(.., MFT_ENUM_FLAG_HARDWARE, ..)`,
//!    and every one of them is an ASYNCHRONOUS MFT: you may not call
//!    ProcessInput whenever you like, only when the transform has asked for a
//!    frame by raising `METransformNeedInput`, and output arrives as a
//!    `METransformHaveOutput` event rather than from the ProcessInput call.
//!    Driving one like a synchronous MFT fails with E_UNEXPECTED or, worse,
//!    silently produces nothing. See `pump_events` below.

use super::{contains_idr, EncodeError, EncodedFrame, FrameCodec, H264Profile};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
// windows-rs 0.58 keeps VARIANT in `core`, not under Win32::System::Variant.
use windows::core::VARIANT;

/// How long to keep asking an async MFT for the frame we just fed it before
/// giving up and letting the caller come back.
///
/// Yielding rather than sleeping is deliberate: `Sleep(1)` on Windows rounds up
/// to the system timer resolution, which defaults to ~15.6ms — longer than a
/// whole frame period, so a "1ms" wait would cost more latency than not waiting
/// at all. The budget is small because the alternative is not a stall: the
/// caller returns on its next tick and collects the frame then.
const OUTPUT_WAIT: Duration = Duration::from_millis(4);

/// How long a freshly built async MFT gets to ask for its first frame before we
/// judge it broken and move to the next candidate.
const FIRST_NEED_INPUT_WAIT: Duration = Duration::from_millis(400);

/// Pack a u32 pair into the u64 MF uses for ratios and sizes.
fn pack(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

pub struct H264Encoder {
    transform: IMFTransform,
    width: u32,
    height: u32,
    /// Reused NV12 scratch — allocating 1.5 bytes/pixel per frame at 30fps is
    /// pure garbage-collector pressure for no benefit.
    nv12: Vec<u8>,
    /// Next sample's presentation time, 100ns units. ACCUMULATED rather than
    /// derived from a frame counter: `update_rate` can change `fps` while
    /// streaming, and `frame_index * duration` with a smaller duration would
    /// step TIME BACKWARDS — which rate control reads as a clock fault.
    sample_time: i64,
    fps: u32,
    /// The fps the media types were negotiated at. A live `update_rate` may
    /// pace BELOW this freely (CBR undershoots, which is safe); pacing above
    /// it needs a rebuild, and the caller uses this to decide.
    built_fps: u32,
    /// The bitrate currently asked of the transform, so an fps-only change can
    /// re-derive the HRD buffer without the caller having to resend it.
    bitrate: u32,
    /// The profile the media types were negotiated with — kept so
    /// `update_size` can rebuild the SAME types at a new size.
    profile: H264Profile,
    /// `Some` for an asynchronous (hardware) MFT, `None` for the synchronous
    /// software one. This single field is what selects between the two entirely
    /// different ways of driving the transform.
    events: Option<IMFMediaEventGenerator>,
    /// Outstanding `METransformNeedInput` credits. Feeding without one is a
    /// contract violation, not a performance question.
    need_input: u32,
    /// Frames the transform has produced that the caller has not collected yet.
    /// An async MFT can emit two outputs between our calls; dropping the extra
    /// would lose a keyframe.
    ready: VecDeque<EncodedFrame>,
    /// The transform's ICodecAPI, kept from build time. `request_keyframe`
    /// needs it PER FRAME: `CODECAPI_AVEncVideoForceKeyFrame` is the only
    /// force-key mechanism hardware MFTs actually honour —
    /// `MFSampleExtension_CleanPoint` on an INPUT sample is inert (CleanPoint
    /// is what the encoder stamps on its OUTPUT), which with the deliberate
    /// infinite GOP above meant exactly ONE IDR per encoder lifetime: the
    /// fresh transform's first frame. Measured live (forced_keyframes test,
    /// NVIDIA MFT): 1 keyframe in 8 s of 2-s force-key requests before this
    /// field existed; ~4 after. That single-IDR stream is what made 0.8.108's
    /// clip seal emit one giant fragment ("part 1 exceeds PART_MAX_PLAINTEXT")
    /// — and it means a mid-stream PLI force-key never worked for the
    /// remote-desktop stream either (masked there by encoder rebuilds).
    codec_api: Option<ICodecAPI>,
    /// A keyframe that was asked for while the encoder was saturated. Without
    /// this the request is simply lost and the viewer stays black until the
    /// next one — the frame gets dropped, the demand must not.
    owed_keyframe: bool,
    /// Which MFT this is, for the log line.
    backend: String,
}

/// Every hardware H.264 encoder MFT this machine exposes, best first.
///
/// Empty is a normal answer — a machine with no GPU encoder, a headless VM, or
/// a driver that does not register one. The caller falls back to software.
unsafe fn hardware_h264_activates() -> Vec<IMFActivate> {
    let input = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let hr = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
        Some(&input),
        Some(&output),
        &mut raw,
        &mut count,
    );
    if hr.is_err() || raw.is_null() {
        return Vec::new();
    }
    // The array is one CoTaskMem allocation holding already-AddRef'd pointers;
    // read each out to take ownership, then free the array itself. Freeing
    // without reading leaks every interface.
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        if let Some(a) = std::ptr::read(raw.add(i)) {
            out.push(a);
        }
    }
    CoTaskMemFree(Some(raw as *const std::ffi::c_void));
    out
}

unsafe fn activate_name(a: &IMFActivate) -> String {
    let mut buf = [0u16; 256];
    let mut len = 0u32;
    if a.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, Some(&mut len)).is_ok() {
        let len = (len as usize).min(buf.len());
        return String::from_utf16_lossy(&buf[..len]);
    }
    "unnamed hardware H.264 MFT".to_string()
}

/// One BGRA pixel to luma, BT.601.
///
/// BT.601 coefficients: what the H.264 encoder assumes by default. Using BT.709
/// here without telling the encoder produces a picture with visibly wrong
/// colour that is easy to mistake for a capture problem.
#[inline(always)]
fn luma(b: i32, g: i32, r: i32) -> u8 {
    (((66 * r + 129 * g + 25 * b + 4096) >> 8).clamp(0, 255)) as u8
}

#[inline(always)]
fn chroma(b: i32, g: i32, r: i32) -> (u8, u8) {
    let u = (-38 * r - 74 * g + 112 * b + 32768) >> 8;
    let v = (112 * r - 94 * g - 18 * b + 32768) >> 8;
    (u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

/// BGRA -> NV12 (planar Y then interleaved UV at half resolution).
///
/// THIS FUNCTION IS THE SINGLE LARGEST CPU COST IN THE STREAM. Measured on a
/// 2560x1440 desktop it was **14.8ms of every 33ms frame** — half the budget,
/// spent before the GPU encoder had seen anything, and it does not shrink when
/// you switch to a hardware encoder because it happens first. The obvious
/// index-per-channel version costs that much because it bounds-checks roughly
/// 7.4 million loads per frame; iterating over fixed-size chunks lets the
/// compiler drop the checks and vectorise.
///
/// The scratch buffer is only re-zeroed when its size changes: `clear()` +
/// `resize()` memsets 5.5MB per frame for nothing, since the even-dimension
/// path below writes every byte it owns. Odd dimensions do not, so they keep
/// the zeroing. Callers stream even dimensions — the encoder requires them — so
/// the fast path is the one that runs.
///
/// ODD DIMENSIONS ARE NOT A SUPPORTED FORMAT, only a safe one. NV12 subsamples
/// chroma 2x2, so an odd height needs `ceil(h/2)` chroma rows while the plane
/// is sized `w*h/2` — they do not fit, and the version of this function that
/// shipped before indexed straight past the end and panicked. The encoder
/// refuses odd dimensions anyway and every caller rounds down with `& !1`, so
/// the fix is to clamp rather than to invent a layout no decoder expects: the
/// last chroma row is simply short. A panic inside the capture loop takes the
/// whole agent down, which is a far worse answer than a slightly wrong pixel in
/// a configuration nothing can encode.
fn bgra_to_nv12(bgra: &[u8], stride: usize, width: u32, height: u32, out: &mut Vec<u8>) {
    let w = width as usize;
    let h = height as usize;
    let need = w * h + w * h / 2;
    let even = w % 2 == 0 && h % 2 == 0;
    if out.len() != need || !even {
        out.clear();
        out.resize(need, 0);
    }
    let (y_plane, uv_plane) = out.split_at_mut(w * h);

    for row in 0..h {
        let Some(src) = bgra.get(row * stride..row * stride + w * 4) else { break };
        let dst = &mut y_plane[row * w..row * w + w];
        for (px, y) in src.chunks_exact(4).zip(dst.iter_mut()) {
            *y = luma(px[0] as i32, px[1] as i32, px[2] as i32);
        }
    }

    // Chroma is subsampled 2x2: average each quad rather than point-sampling,
    // or fine coloured text (which is most of a remote desktop) shimmers.
    for row in (0..h).step_by(2) {
        let below = (row + 1).min(h - 1);
        let Some(top) = bgra.get(row * stride..row * stride + w * 4) else { break };
        let Some(bottom) = bgra.get(below * stride..below * stride + w * 4) else { break };
        let uv_len = uv_plane.len();
        let base = (row / 2) * w;
        if base >= uv_len {
            break;
        }
        let dst = &mut uv_plane[base..(base + w).min(uv_len)];

        // chunks_exact(8) is one horizontal pair of BGRA pixels; paired with the
        // row below, that is the whole 2x2 quad with no bounds check inside.
        for ((t, b), uv) in top
            .chunks_exact(8)
            .zip(bottom.chunks_exact(8))
            .zip(dst.chunks_exact_mut(2))
        {
            let bs = t[0] as i32 + t[4] as i32 + b[0] as i32 + b[4] as i32;
            let gs = t[1] as i32 + t[5] as i32 + b[1] as i32 + b[5] as i32;
            let rs = t[2] as i32 + t[6] as i32 + b[2] as i32 + b[6] as i32;
            let (u, v) = chroma(bs / 4, gs / 4, rs / 4);
            uv[0] = u;
            uv[1] = v;
        }

        // An odd final column has only the left half of its quad.
        if w % 2 == 1 && w - 1 < dst.len() {
            let col = w - 1;
            let (t, b) = (&top[col * 4..], &bottom[col * 4..]);
            let bs = t[0] as i32 + b[0] as i32;
            let gs = t[1] as i32 + b[1] as i32;
            let rs = t[2] as i32 + b[2] as i32;
            let (u, v) = chroma(bs / 2, gs / 2, rs / 2);
            dst[col] = u;
            if col + 1 < dst.len() {
                dst[col + 1] = v;
            }
        }
    }
}

#[cfg(test)]
mod nv12_tests {
    use super::*;

    /// The straightforward index-per-channel implementation this file used
    /// before the chunked one, kept as the reference the fast path must match.
    ///
    /// A speed-up that changes the output is a picture-quality regression no
    /// timing test would catch, so the two are compared byte for byte rather
    /// than trusted to be "obviously the same rearrangement".
    fn reference(bgra: &[u8], stride: usize, width: u32, height: u32, out: &mut Vec<u8>) {
        let w = width as usize;
        let h = height as usize;
        out.clear();
        out.resize(w * h + w * h / 2, 0);
        let (y_plane, uv_plane) = out.split_at_mut(w * h);
        for row in 0..h {
            for col in 0..w {
                let at = row * stride + col * 4;
                y_plane[row * w + col] =
                    luma(bgra[at] as i32, bgra[at + 1] as i32, bgra[at + 2] as i32);
            }
        }
        for row in (0..h).step_by(2) {
            for col in (0..w).step_by(2) {
                let (mut rs, mut gs, mut bs, mut n) = (0i32, 0i32, 0i32, 0i32);
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (y, x) = (row + dy, col + dx);
                        if y < h && x < w {
                            let at = y * stride + x * 4;
                            bs += bgra[at] as i32;
                            gs += bgra[at + 1] as i32;
                            rs += bgra[at + 2] as i32;
                            n += 1;
                        }
                    }
                }
                if n == 0 {
                    n = 1;
                }
                let (u, v) = chroma(bs / n, gs / n, rs / n);
                let idx = (row / 2) * w + col;
                uv_plane[idx] = u;
                uv_plane[idx + 1] = v;
            }
        }
    }

    /// Deterministic pseudo-random pixels. A flat colour would let a wrong
    /// average, or a transposed row, still match.
    fn noise(w: usize, h: usize, stride: usize) -> Vec<u8> {
        let mut v = vec![0u8; stride * h];
        let mut s = 0x1234_5678u32;
        for row in 0..h {
            for col in 0..w * 4 {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                v[row * stride + col] = (s >> 24) as u8;
            }
        }
        v
    }

    /// The colour maths itself, pinned to known values.
    ///
    /// `the_fast_path_matches_the_reference_byte_for_byte` cannot see this:
    /// both sides call the SAME `luma`/`chroma` helpers, so switching to BT.709
    /// coefficients, changing the rounding bias, or swapping U and V moves both
    /// together and the equivalence holds. That is the "visibly wrong colour
    /// that is easy to mistake for a capture problem" this file's own comment
    /// warns about, and nothing was checking it.
    ///
    /// Values are BT.601 studio-swing, the range an H.264 encoder assumes by
    /// default: black is 16, white is 235, and neutral chroma is 128.
    #[test]
    fn the_colour_conversion_is_bt601_and_not_something_else() {
        assert_eq!(luma(0, 0, 0), 16, "black luma");
        assert_eq!(luma(255, 255, 255), 235, "white luma");
        // Green carries the most luma, then red, then blue (0.587 / 0.299 /
        // 0.114). That ordering is what makes a greyscale conversion look
        // right, and swapping the coefficients reverses it. NOTE THE ARGUMENT
        // ORDER — `luma(b, g, r)`, matching the byte order of a BGRA pixel, so
        // `luma(255, 0, 0)` is BLUE. Writing this test the other way round is
        // how it first failed.
        assert!(luma(0, 255, 0) > luma(0, 0, 255), "green must be brighter than red");
        assert!(luma(0, 0, 255) > luma(255, 0, 0), "red must be brighter than blue");

        assert_eq!(chroma(128, 128, 128), (128, 128), "grey must be neutral chroma");
        // Blue drives U up and V down; red does the opposite. Swapping the two
        // returns turns the picture orange-and-teal.
        let (bu, bv) = chroma(255, 0, 0);
        let (ru, rv) = chroma(0, 0, 255);
        assert!(bu > 200 && bv < 128, "blue should be high U, low V — got ({bu},{bv})");
        assert!(rv > 200 && ru < 128, "red should be high V, low U — got ({ru},{rv})");
    }

    #[test]
    fn the_fast_path_matches_the_reference_byte_for_byte() {
        // Even dimensions only: that is what streams, and it is the whole range
        // over which the reference itself is defined (see the odd-dimension test
        // below). A padded stride is included because that is what DXGI hands
        // back and it is the easiest thing for a chunked rewrite to get wrong.
        let cases = [(8usize, 6usize, 0usize), (2, 2, 0), (16, 8, 64), (64, 4, 32), (4, 64, 0)];
        for &(w, h, pad) in &cases {
            let stride = w * 4 + pad;
            let src = noise(w, h, stride);
            let (mut fast, mut slow) = (Vec::new(), Vec::new());
            bgra_to_nv12(&src, stride, w as u32, h as u32, &mut fast);
            reference(&src, stride, w as u32, h as u32, &mut slow);
            assert_eq!(fast, slow, "{w}x{h} stride +{pad} diverged from the reference");
        }
    }

    /// Positive control for the test above: the noise generator and the
    /// comparison can actually tell two frames apart. Without this, a `reference`
    /// that returned the same bytes for everything would make the equivalence
    /// test pass no matter what the fast path computed.
    #[test]
    fn two_different_frames_do_not_convert_to_the_same_bytes() {
        let (w, h, stride) = (16usize, 8usize, 16 * 4);
        let a = noise(w, h, stride);
        let b: Vec<u8> = a.iter().map(|v| 255 - v).collect();
        let (mut ca, mut cb) = (Vec::new(), Vec::new());
        bgra_to_nv12(&a, stride, w as u32, h as u32, &mut ca);
        bgra_to_nv12(&b, stride, w as u32, h as u32, &mut cb);
        assert_ne!(ca, cb, "the conversion is not distinguishing its input at all");
    }

    /// Odd dimensions are not encodable and no caller produces them — every one
    /// rounds down with `& !1`. What matters is that a stray one CANNOT take the
    /// agent down: the version of this code that shipped before indexed past the
    /// end of the chroma plane and panicked, and a panic here happens inside the
    /// capture loop.
    #[test]
    fn odd_dimensions_do_not_panic() {
        for &(w, h) in &[(7usize, 5usize), (5, 3), (1, 1), (3, 8), (8, 3)] {
            let stride = w * 4 + 8;
            let src = noise(w, h, stride);
            let mut out = Vec::new();
            bgra_to_nv12(&src, stride, w as u32, h as u32, &mut out);
            assert_eq!(out.len(), w * h + w * h / 2, "{w}x{h} produced an odd-sized buffer");
        }
    }

    /// The fast path skips re-zeroing its scratch buffer. That is only sound if
    /// every byte is rewritten — otherwise the previous frame bleeds through,
    /// which reads as a compression artefact rather than a bug.
    #[test]
    fn reusing_the_scratch_buffer_leaves_nothing_of_the_previous_frame() {
        let (w, h, stride) = (16usize, 8usize, 16 * 4);
        let first = noise(w, h, stride);
        let mut second = noise(w, h, stride);
        second.iter_mut().for_each(|b| *b = 255 - *b);

        let mut reused = Vec::new();
        bgra_to_nv12(&first, stride, w as u32, h as u32, &mut reused);
        bgra_to_nv12(&second, stride, w as u32, h as u32, &mut reused);

        let mut fresh = Vec::new();
        bgra_to_nv12(&second, stride, w as u32, h as u32, &mut fresh);
        assert_eq!(reused, fresh, "the reused buffer kept part of the first frame");
    }
}

impl H264Encoder {
    /// Build an encoder, preferring the GPU.
    ///
    /// Hardware candidates are tried in the order Media Foundation ranks them
    /// and the first one that survives a full setup wins; anything that throws
    /// on the way is recorded and skipped. Software is the floor, not a
    /// competitor — it is only reached when every hardware candidate failed or
    /// there were none, so a machine without a GPU encoder behaves exactly as
    /// it did before this existed.
    ///
    /// "Survives setup" is a real test, not a construction call: an async MFT
    /// must ask for its first frame within `FIRST_NEED_INPUT_WAIT`. A driver
    /// that accepts every call and then never speaks would otherwise be chosen
    /// over a working software encoder and show a permanently black screen.
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self, EncodeError> {
        Self::new_with_profile(width, height, fps, bitrate, H264Profile::Baseline)
    }

    /// Like `new`, but configured for a specific H.264 profile.
    ///
    /// The profile must come from what the peer NEGOTIATED (the rtc layer
    /// exposes it) — see the enum's comment in lib.rs. Baseline remains the
    /// default constructor so nothing existing changes behaviour.
    pub fn new_with_profile(
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        profile: H264Profile,
    ) -> Result<Self, EncodeError> {
        // PROFILE IS AN OPTIMISATION; A PICTURE IS NOT.
        //
        // `build` hard-fails when SetOutputType refuses the profile, and some
        // MFTs (older Intel parts, a few software fallbacks) accept only
        // baseline. Without this retry a peer that negotiated High would push
        // every hardware candidate into the rejected list and land on
        // software — or, if software refused too, take the session down with
        // `PumpError::Fatal`. Baseline decodes everywhere and every peer that
        // offers High also offers it, so falling back costs efficiency and
        // nothing else.
        match Self::try_new_with_profile(width, height, fps, bitrate, profile) {
            Ok(e) => Ok(e),
            Err(e) if profile != H264Profile::Baseline => {
                eprintln!(
                    "[encode] {profile:?} profile refused ({e}); falling back to baseline"
                );
                Self::try_new_with_profile(width, height, fps, bitrate, H264Profile::Baseline)
            }
            Err(e) => Err(e),
        }
    }

    fn try_new_with_profile(
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        profile: H264Profile,
    ) -> Result<Self, EncodeError> {
        unsafe {
            // Ignore the result: another component may already have initialised
            // COM on this thread, which is success for our purposes.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)
                .map_err(|e| EncodeError::Failed(format!("MFStartup failed: {e}")))?;

            let mut rejected: Vec<String> = Vec::new();
            for activate in hardware_h264_activates() {
                let name = activate_name(&activate);
                match activate.ActivateObject::<IMFTransform>() {
                    Ok(transform) => {
                        match Self::build(transform, name.clone(), width, height, fps, bitrate, profile) {
                            Ok(encoder) => {
                                eprintln!(
                                    "[encode] hardware H.264: {name} ({}), {width}x{height}@{fps} {}kbps",
                                    if encoder.events.is_some() { "async" } else { "sync" },
                                    bitrate / 1000
                                );
                                return Ok(encoder);
                            }
                            Err(e) => {
                                // EXPLICIT TEARDOWN, not a dropped refcount.
                                // The activation object caches the transform it
                                // created, and for a hardware encoder that
                                // object holds a GPU ENCODE SESSION — a
                                // resource consumer drivers cap at two or three
                                // machine-wide, shared with whatever else is
                                // recording. This loop deliberately builds and
                                // abandons transforms, and a monitor switch or
                                // a quality change runs it again, so leaving
                                // release to destructor ordering is how a
                                // machine ends up unable to start any encoder
                                // at all until something restarts.
                                let _ = activate.ShutdownObject();
                                rejected.push(format!("{name} ({e:?})"));
                            }
                        }
                    }
                    Err(e) => rejected.push(format!("{name} (activate failed: {e})")),
                }
            }

            let transform: IMFTransform = windows::Win32::System::Com::CoCreateInstance(
                &CLSID_MSH264EncoderMFT,
                None,
                windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
            )
            .map_err(|e| EncodeError::Failed(format!("no H.264 encoder available: {e}")))?;
            if rejected.is_empty() {
                eprintln!("[encode] no hardware H.264 encoder on this machine, using software");
            } else {
                eprintln!(
                    "[encode] hardware H.264 unusable, using software; rejected: {}",
                    rejected.join(", ")
                );
            }
            Self::build(
                transform,
                "Microsoft H.264 Encoder MFT (software)".to_string(),
                width,
                height,
                fps,
                bitrate,
                profile,
            )
        }
    }

    /// Configure one already-instantiated MFT, hardware or software.
    ///
    /// Everything below is common to both; the only fork is the async unlock
    /// and the first-frame check at the end.
    /// The negotiated output+input media types, built ONE way. `build` and
    /// `update_size` both call this so the two can never drift — a size
    /// change reconfigures with exactly the types a fresh build would use.
    unsafe fn negotiated_types(
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        profile: H264Profile,
    ) -> Result<(IMFMediaType, IMFMediaType), EncodeError> {
        let out_type: IMFMediaType = MFCreateMediaType()
            .map_err(|e| EncodeError::Failed(format!("MFCreateMediaType failed: {e}")))?;
        out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).ok();
        out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).ok();
        out_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).ok();
        out_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).ok();
        out_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).ok();
        out_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).ok();
        out_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .ok();
        // The profile is the PEER'S choice, threaded in from what the SDP
        // negotiated. High buys CABAC + 8x8 transforms — a real bitrate-
        // efficiency win on text-heavy screen content — but only when the
        // receiver advertised it; Baseline remains the floor for a peer
        // that offered nothing better.
        let mf_profile = match profile {
            H264Profile::Baseline => eAVEncH264VProfile_Base,
            H264Profile::Main => eAVEncH264VProfile_Main,
            H264Profile::High => eAVEncH264VProfile_High,
        };
        out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, mf_profile.0 as u32).ok();

        let in_type: IMFMediaType = MFCreateMediaType()
            .map_err(|e| EncodeError::Failed(format!("MFCreateMediaType failed: {e}")))?;
        in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).ok();
        in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).ok();
        in_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height)).ok();
        in_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1)).ok();
        in_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).ok();
        in_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .ok();
        Ok((out_type, in_type))
    }

    /// Wait for an async MFT's first `METransformNeedInput`. No frame has
    /// been submitted when this runs, so that is the only event the
    /// transform can raise. Returns the input credits gathered (0 for a
    /// synchronous MFT).
    unsafe fn probe_first_need_input(
        events: &Option<IMFMediaEventGenerator>,
    ) -> Result<u32, EncodeError> {
        let mut need_input = 0u32;
        if let Some(ev) = events {
            let deadline = Instant::now() + FIRST_NEED_INPUT_WAIT;
            loop {
                match ev.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(event) => {
                        if event.GetType().ok() == Some(METransformNeedInput.0 as u32) {
                            need_input += 1;
                            break;
                        }
                    }
                    Err(_) => {
                        if Instant::now() >= deadline {
                            return Err(EncodeError::Failed(
                                "async MFT never asked for a frame".into(),
                            ));
                        }
                        std::thread::yield_now();
                    }
                }
            }
        }
        Ok(need_input)
    }

    unsafe fn build(
        transform: IMFTransform,
        backend: String,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        profile: H264Profile,
    ) -> Result<Self, EncodeError> {
        {
            // LOW-LATENCY MODE, BEFORE THE MEDIA TYPES.
            //
            // Order is the whole trick here. Setting these after SetInputType
            // is accepted — `AVLowLatencyMode -> Ok(())` — and changes nothing:
            // MEASURED on a real desktop, the first encoded frame still only
            // emerged after SEVENTEEN inputs, about 567ms at 30fps before
            // capture, network or decode had spent anything. The MFT reads its
            // codec configuration while it negotiates types, so a property set
            // afterwards is recorded and never applied. An `Ok(())` from
            // SetValue means "I stored that", not "that took effect".
            //
            // Both levers are set: MF_LOW_LATENCY on the attribute store is
            // free, and MFTs differ in which one they honour.
            //
            // Best-effort throughout, matching the rest of this function — a
            // software-fallback MFT that refuses these must still start and
            // encode, simply as slowly as it did before.
            //
            // MF_TRANSFORM_ASYNC_UNLOCK belongs in the same breath and MUST come
            // before the media types: an async MFT rejects SetOutputType with
            // E_ACCESSDENIED until it is unlocked, so a missing unlock does not
            // read as "async", it reads as "this encoder does not support
            // H.264". Note it is `MF_TRANSFORM_ASYNC` that is queried and
            // `..._UNLOCK` that is set — they are different GUIDs.
            let mut is_async = false;
            if let Ok(attrs) = transform.GetAttributes() {
                is_async = attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1;
                if is_async {
                    attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(|e| {
                        EncodeError::Failed(format!("async unlock refused: {e}"))
                    })?;
                }
                let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
            }
            let codec_api = transform.cast::<ICodecAPI>().ok();
            if let Some(codec) = &codec_api {
                let _ = codec.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
                // CBR with a shallow buffer: the default rate control may bank
                // bits and spend them in bursts, which reads as a stall exactly
                // when the screen starts changing. Two frames of HRD keeps it
                // honest without starving a keyframe.
                let _ = codec.SetValue(
                    &CODECAPI_AVEncCommonRateControlMode,
                    &VARIANT::from(eAVEncCommonRateControlMode_CBR.0),
                );
                let _ = codec.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate));
                let buffer = (bitrate / fps.max(1)).saturating_mul(2);
                let _ = codec.SetValue(&CODECAPI_AVEncCommonBufferSize, &VARIANT::from(buffer));
                // NO PERIODIC KEYFRAMES. Whatever GOP the driver defaults to,
                // a periodic IDR on screen content is a bitrate spike that
                // reads as a latency bulge, spent re-sending a picture the
                // viewer already has. Keyframes here are ON DEMAND only: the
                // first frame, an encoder rebuild, or the peer's PLI (the
                // stream loop wires Event::KeyframeRequest -> force_key).
                // This matches the infinite-GOP policy other remote-desktop tools ship (GOP = i32::MAX). i32::MAX
                // rather than u32::MAX because the property is signed on some
                // drivers and a negative read would fall back to the default.
                //
                // MEASURED (live_encode, release, NVIDIA MFT, 1440p, matched
                // 60/60-frame runs): 0 keyframes and 669 KB, against 2
                // keyframes and ~945 KB with the driver's default GOP — 29%
                // fewer bytes for the SAME 60 frames, i.e. ~138 KB per
                // redundant IDR. At a fixed CBR target those bits go to the
                // deltas instead, which is the quality win. Throughput was
                // unchanged (both configurations reached 60/60 in 3 of 7
                // interleaved runs; the spread is machine load, not the
                // setting).
                let _ = codec.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(i32::MAX as u32));
                // CODECAPI_AVEncCommonQualityVsSpeed is deliberately NOT set.
                // MEASURED on the NVIDIA MFT (live_encode, release): with it at
                // 80 the encoder switched into a lookahead-style preset and
                // outputs began lagging inputs by ~30 frames — a full second of
                // added latency at 30fps — while AVLowLatencyMode sat set the
                // whole time. The default preset already encodes a 1440p frame
                // in ~2.5ms here; there is no quality worth that trade.
                // CABAC is Main/High-only; asking for it under Baseline is a
                // contract violation some MFTs act on rather than ignore.
                if profile != H264Profile::Baseline {
                    let _ = codec.SetValue(&CODECAPI_AVEncH264CABACEnable, &VARIANT::from(true));
                }
            }

            // OUTPUT FIRST — the reverse order fails type negotiation with an
            // error that names neither type. (Type construction is shared
            // with update_size — see negotiated_types.)
            let (out_type, in_type) =
                Self::negotiated_types(width, height, fps, bitrate, profile)?;
            transform
                .SetOutputType(0, &out_type, 0)
                .map_err(|e| EncodeError::Failed(format!("SetOutputType failed: {e}")))?;
            transform
                .SetInputType(0, &in_type, 0)
                .map_err(|e| EncodeError::Failed(format!("SetInputType failed: {e}")))?;

            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|e| EncodeError::Failed(format!("begin streaming failed: {e}")))?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|e| EncodeError::Failed(format!("start of stream failed: {e}")))?;

            let events = if is_async {
                Some(transform.cast::<IMFMediaEventGenerator>().map_err(|e| {
                    EncodeError::Failed(format!("async MFT has no event generator: {e}"))
                })?)
            } else {
                None
            };

            // THE PROBE RUNS BEFORE `Self` EXISTS, and that ordering is the
            // whole point rather than a tidiness preference.
            //
            // `Drop for H264Encoder` calls `MFShutdown`, and `MFStartup` is
            // called ONCE per `new()`. Constructing `Self` and then returning
            // an error dropped it, took the Media Foundation lock count to
            // zero, and tore the platform down inside a function that was
            // about to build the SOFTWARE fallback on it — so every later MF
            // call returned MF_E_SHUTDOWN, `new()` failed outright, and the
            // stream thread died with `PumpError::Fatal`. The check written to
            // protect against a mute hardware encoder was destroying the very
            // fallback it existed to protect. Nothing here may construct
            // `Self` until it is certain of returning it.
            //
            // Probing on locals is also simpler than it looks: no frame has
            // been submitted yet, so the only event the transform can possibly
            // raise is `METransformNeedInput`. There is no output to collect.
            let need_input = Self::probe_first_need_input(&events)?;

            Ok(Self {
                transform,
                width,
                height,
                nv12: Vec::new(),
                sample_time: 0,
                fps: fps.max(1),
                built_fps: fps.max(1),
                bitrate,
                profile,
                events,
                need_input,
                ready: VecDeque::new(),
                owed_keyframe: false,
                codec_api,
                backend,
            })
        }
    }

    /// Which MFT is actually encoding, for logs and diagnostics.
    pub fn backend(&self) -> &str {
        &self.backend
    }

    /// The fps the media types were negotiated at — the ceiling for a live
    /// pacing change (see `update_rate`).
    pub fn built_fps(&self) -> u32 {
        self.built_fps
    }

    /// Change bitrate and/or pacing fps on the RUNNING transform.
    ///
    /// This is what makes quality changes (and the adaptive loop) cheap: the
    /// old path tore the whole MFT down — a GPU encode-session re-acquisition
    /// plus a forced IDR — for what is, on every encoder tested, a documented
    /// dynamic property. Returns false when the transform refuses, and the
    /// caller falls back to that rebuild; an `Ok` from SetValue is still not
    /// PROOF the rate moved (the low-latency lesson above), but the failure
    /// mode is "bitrate stays put", which the adaptive loop's own feedback
    /// then reports — it is observable, not silent.
    ///
    /// `fps` here only re-paces SAMPLE TIMING; the media type keeps its built
    /// rate. Pacing below the built rate makes CBR undershoot, which is the
    /// safe direction. Callers must rebuild to pace ABOVE `built_fps()`.
    pub fn update_rate(&mut self, bitrate: Option<u32>, fps: Option<u32>) -> bool {
        if let Some(f) = fps {
            if f.max(1) > self.built_fps {
                return false;
            }
            self.fps = f.max(1);
        }
        // Nothing to push at the transform.
        if bitrate.is_none() && fps.is_none() {
            return true;
        }
        unsafe {
            let Ok(codec) = self.transform.cast::<ICodecAPI>() else {
                return false;
            };
            if let Some(b) = bitrate {
                if codec
                    .SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(b))
                    .is_err()
                {
                    return false;
                }
                self.bitrate = b;
            }
            // ALWAYS re-derive the HRD from the CURRENT pair. This used to sit
            // inside the bitrate branch, so dropping 30fps -> 15fps with the
            // bitrate unchanged left the buffer sized for the old cadence —
            // i.e. one frame of HRD instead of two, which is the burstiness
            // the shallow-but-not-starved sizing exists to avoid.
            let buffer = (self.bitrate / self.fps.max(1)).saturating_mul(2);
            let _ = codec.SetValue(&CODECAPI_AVEncCommonBufferSize, &VARIANT::from(buffer));
        }
        true
    }

    /// The frame size the media types are negotiated at right now.
    pub fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Reconfigure the LIVE transform for a new frame size, keeping the MFT.
    ///
    /// Returns false when the transform refuses — the caller drops the
    /// encoder and takes the full rebuild path, byte-identical to before this
    /// existed. On refusal the TEST_ONLY probe runs FIRST, so a transform
    /// that will not take the new size is left exactly as it was.
    ///
    /// Why: a monitor switch paid full `new()` — MFT enumeration, activation,
    /// type negotiation, async NeedInput probe — the single largest chunk of
    /// the "zoom to read text is slow" freeze on hardware encoders.
    /// `update_rate` proved the transform survives live property changes; a
    /// resolution change needs new MEDIA TYPES but not a new transform.
    pub fn update_size(&mut self, width: u32, height: u32) -> bool {
        if width == self.width && height == self.height {
            return true;
        }
        if width == 0 || height == 0 {
            return false;
        }
        unsafe {
            // Retire the stream first so no frame straddles the type change.
            // Pending outputs are for the OLD size — a caller that switched
            // away no longer wants them.
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
            self.ready.clear();
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);

            let Ok((out_type, in_type)) =
                Self::negotiated_types(width, height, self.built_fps, self.bitrate, self.profile)
            else {
                return false;
            };
            // Probe before committing: a refusal here leaves the old types in
            // force and the encoder untouched.
            if self
                .transform
                .SetOutputType(0, &out_type, MFT_SET_TYPE_TEST_ONLY.0 as u32)
                .is_err()
            {
                return false;
            }
            if self.transform.SetOutputType(0, &out_type, 0).is_err()
                || self.transform.SetInputType(0, &in_type, 0).is_err()
                || self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                    .is_err()
                || self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                    .is_err()
            {
                // Past TEST_ONLY a partial failure leaves the transform in an
                // indeterminate state — report it so the caller REBUILDS
                // rather than feeding a half-reconfigured encoder.
                return false;
            }
            let Ok(need_input) = Self::probe_first_need_input(&self.events) else {
                return false;
            };
            self.need_input = need_input;
            self.width = width;
            self.height = height;
            // Scratch is sized per frame; force a clean fill at the new size.
            self.nv12 = Vec::new();
            // `sample_time` stays monotonic across the change — rate control
            // reads a backwards step as a clock fault.
            self.owed_keyframe = true;
        }
        true
    }

    /// Encode one BGRA frame.
    ///
    /// `NeedMoreInput` is a normal early return while the pipeline fills, not a
    /// failure — callers keep feeding frames.
    pub fn encode_bgra(
        &mut self,
        bgra: &[u8],
        stride: usize,
        force_key: bool,
    ) -> Result<EncodedFrame, EncodeError> {
        if bgra.len() < stride * self.height as usize {
            return Err(EncodeError::Failed("frame buffer is shorter than stride*height".into()));
        }
        // A STRIDE NARROWER THAN THE PICTURE IS NOT SURVIVABLE HERE.
        //
        // The conversion reuses its scratch buffer without re-zeroing, which is
        // only sound because every byte gets rewritten — and that in turn holds
        // only while `stride >= width*4`. Below that the row loops run off the
        // end of the input, stop early, and leave the PREVIOUS frame's pixels
        // in the tail of the buffer; worse, luma and chroma stop at different
        // rows, so the result is a colour-fringed tear rather than an obvious
        // failure. The length check below does not imply it, so it is checked.
        if stride < self.width as usize * 4 {
            return Err(EncodeError::Failed(format!(
                "stride {stride} is narrower than {} bytes of picture",
                self.width as usize * 4
            )));
        }
        let force_key = force_key || self.owed_keyframe;

        unsafe {
            // CHECK FOR A CREDIT FIRST. Converting and then discovering the
            // encoder is saturated pays the full per-frame conversion — the
            // single largest CPU cost in the stream — for a frame that is
            // thrown away.
            if self.events.is_some() {
                self.pump_events()?;
                if self.need_input == 0 {
                    if force_key {
                        self.owed_keyframe = true;
                    }
                    return self.ready.pop_front().ok_or(EncodeError::NeedMoreInput);
                }
            }

            bgra_to_nv12(bgra, stride, self.width, self.height, &mut self.nv12);
            let sample = self.make_sample(force_key)?;
            if self.events.is_some() {
                return self.encode_async(sample, force_key);
            }
            self.owed_keyframe = false;
            if force_key {
                self.request_keyframe();
            }
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|e| EncodeError::Failed(format!("ProcessInput failed: {e}")))?;
            self.process_output()
        }
    }

    /// Ask the encoder to code the NEXT frame it processes as an IDR. Called
    /// immediately before the `ProcessInput` of the frame that must be a key,
    /// so "next" is exactly that frame. Best effort by design — a driver
    /// without ICodecAPI simply keeps its own GOP policy, and the caller's
    /// `owed_keyframe` bookkeeping re-requests until an IDR actually appears
    /// in the output bitstream (`contains_idr` is the arbiter, not this).
    unsafe fn request_keyframe(&self) {
        if let Some(codec) = &self.codec_api {
            let _ = codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
        }
    }

    /// Wrap the current NV12 scratch in a timestamped MF sample.
    unsafe fn make_sample(&mut self, force_key: bool) -> Result<IMFSample, EncodeError> {
        {
            let buffer: IMFMediaBuffer = MFCreateMemoryBuffer(self.nv12.len() as u32)
                .map_err(|e| EncodeError::Failed(format!("MFCreateMemoryBuffer failed: {e}")))?;
            let mut ptr = std::ptr::null_mut();
            let mut max = 0u32;
            buffer
                .Lock(&mut ptr, Some(&mut max), None)
                .map_err(|e| EncodeError::Failed(format!("buffer Lock failed: {e}")))?;
            std::ptr::copy_nonoverlapping(self.nv12.as_ptr(), ptr, self.nv12.len());
            // Unlock BEFORE the sample is used, or the next ProcessInput fails
            // in a way that reads as a codec bug.
            buffer.Unlock().ok();
            buffer.SetCurrentLength(self.nv12.len() as u32).ok();

            let sample: IMFSample = MFCreateSample()
                .map_err(|e| EncodeError::Failed(format!("MFCreateSample failed: {e}")))?;
            sample.AddBuffer(&buffer).ok();

            // 100ns units. A wrong timebase makes the encoder rate-control
            // against a fictional framerate and the bitrate target drift.
            let duration = 10_000_000i64 / self.fps as i64;
            sample.SetSampleTime(self.sample_time).ok();
            sample.SetSampleDuration(duration).ok();
            if force_key {
                sample.SetUINT32(&MFSampleExtension_CleanPoint, 1).ok();
            }
            self.sample_time += duration;

            Ok(sample)
        }
    }

    /// Drive an asynchronous (hardware) MFT for one frame.
    ///
    /// The shape is forced by the contract: collect whatever the transform has
    /// said since we were last here, feed the new frame only if it has asked
    /// for one, then give it a short moment to hand something back.
    ///
    /// Dropping the frame when there is no credit is correct for live screen
    /// content — the newest picture is the only one worth sending, and the
    /// alternative is stalling the whole media loop behind a busy GPU. The
    /// KEYFRAME demand attached to a dropped frame is carried forward instead
    /// (`owed_keyframe`), because losing that one means a viewer that joined
    /// mid-stream never gets a decodable picture at all.
    unsafe fn encode_async(
        &mut self,
        sample: IMFSample,
        force_key: bool,
    ) -> Result<EncodedFrame, EncodeError> {
        // The credit was already established by `encode_bgra`, which checks
        // before paying for the conversion. Re-check rather than assume: this
        // is the only place that may decrement it.
        if self.need_input == 0 {
            if force_key {
                self.owed_keyframe = true;
            }
            return self.ready.pop_front().ok_or(EncodeError::NeedMoreInput);
        }
        // COMMIT ONLY ON SUCCESS. Spending the credit and clearing the
        // keyframe demand before the call meant a transient `ProcessInput`
        // failure — MF_E_NOTACCEPTING is the realistic one, an async MFT may
        // ask for a frame and then re-buffer — permanently lost a credit the
        // transform still believed it had issued, and threw away a keyframe
        // request that was never submitted. Repeat that a few times and
        // `need_input` ratchets to zero, every frame is dropped, and the stream
        // goes still while `NeedMoreInput` keeps reporting that it is merely
        // filling.
        if force_key {
            self.request_keyframe();
        }
        if let Err(e) = self.transform.ProcessInput(0, &sample, 0) {
            self.owed_keyframe = force_key;
            return Err(EncodeError::Failed(format!("ProcessInput failed: {e}")));
        }
        self.need_input -= 1;
        self.owed_keyframe = false;

        let deadline = Instant::now() + OUTPUT_WAIT;
        loop {
            self.pump_events()?;
            if let Some(frame) = self.ready.pop_front() {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err(EncodeError::NeedMoreInput);
            }
            std::thread::yield_now();
        }
    }

    /// Consume every event the async MFT has queued right now.
    ///
    /// Non-blocking by construction: `MF_EVENT_FLAG_NO_WAIT` turns "no events"
    /// into an error return rather than a wait, which is exactly the loop
    /// terminator. Blocking here would hand a driver the power to wedge the
    /// media loop indefinitely.
    unsafe fn pump_events(&mut self) -> Result<(), EncodeError> {
        let Some(events) = self.events.clone() else { return Ok(()) };
        while let Ok(event) = events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
            let Ok(kind) = event.GetType() else { continue };
            if kind == METransformNeedInput.0 as u32 {
                self.need_input += 1;
            } else if kind == METransformHaveOutput.0 as u32 {
                match self.process_output() {
                    Ok(frame) => {
                        // NEWEST WINS, within what decode order allows. A
                        // keyframe obsoletes everything queued before it — the
                        // decoder resyncs on the IDR, so older frames are pure
                        // added latency. Deltas cannot be dropped selectively
                        // (each references the last), so the backstop for a
                        // caller that stopped draining is: throw the whole
                        // stale run away and owe a fresh keyframe, rather than
                        // ever serving live video from the back of a queue.
                        //
                        // MEASURED: on the NVIDIA MFT at capture cadence this
                        // never fires — the queue never reaches depth 2. It is
                        // a backstop for a stalled caller (a monitor switch, a
                        // blocked socket), not part of the steady state.
                        if frame.keyframe {
                            self.ready.clear();
                        }
                        self.ready.push_back(frame);
                        if self.ready.len() > 8 {
                            self.ready.clear();
                            self.owed_keyframe = true;
                        }
                    }
                    // HaveOutput promised a frame; NeedMoreInput here means the
                    // transform changed its mind, which is odd but not fatal.
                    Err(EncodeError::NeedMoreInput) => {}
                    Err(e) => return Err(e),
                }
            }
        }
        Ok(())
    }

    unsafe fn process_output(&mut self) -> Result<EncodedFrame, EncodeError> {
        let stream_info = self
            .transform
            .GetOutputStreamInfo(0)
            .map_err(|e| EncodeError::Failed(format!("GetOutputStreamInfo failed: {e}")))?;

        // When the MFT does not allocate its own samples we must provide one.
        let provides_samples = (stream_info.dwFlags
            & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32))
            != 0;

        let sample = if provides_samples {
            None
        } else {
            let buffer: IMFMediaBuffer = MFCreateMemoryBuffer(stream_info.cbSize.max(1 << 20))
                .map_err(|e| EncodeError::Failed(format!("output buffer failed: {e}")))?;
            let s: IMFSample = MFCreateSample()
                .map_err(|e| EncodeError::Failed(format!("output sample failed: {e}")))?;
            s.AddBuffer(&buffer).ok();
            Some(s)
        };

        let mut out = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: std::mem::ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: std::mem::ManuallyDrop::new(None),
        }];
        let mut status = 0u32;

        let hr = self.transform.ProcessOutput(0, &mut out, &mut status);
        if let Err(e) = hr {
            // The pipeline is still filling. Normal, and NOT a failure.
            if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Err(EncodeError::NeedMoreInput);
            }
            return Err(EncodeError::Failed(format!("ProcessOutput failed: {e}")));
        }

        let produced = std::mem::ManuallyDrop::take(&mut out[0].pSample)
            .ok_or_else(|| EncodeError::Failed("encoder produced no sample".into()))?;

        // Flatten every buffer: an encoder may split one frame across several,
        // and taking only the first truncates the NAL stream into something
        // that decodes to garbage.
        let count = produced.GetBufferCount().unwrap_or(1);
        let mut data = Vec::new();
        for i in 0..count {
            let Ok(buf) = produced.GetBufferByIndex(i) else { continue };
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            if buf.Lock(&mut ptr, None, Some(&mut len)).is_ok() {
                data.extend_from_slice(std::slice::from_raw_parts(ptr, len as usize));
                buf.Unlock().ok();
            }
        }

        if data.is_empty() {
            return Err(EncodeError::Failed(E_FAIL.message()));
        }

        // Detect the keyframe from the BITSTREAM rather than the MFT's own
        // attribute: drivers set that inconsistently, and a receiver that never
        // gets a real IDR shows a permanently black screen.
        let keyframe = contains_idr(&data);
        Ok(EncodedFrame { data, keyframe, codec: FrameCodec::H264 })
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = MFShutdown();
        }
    }
}
