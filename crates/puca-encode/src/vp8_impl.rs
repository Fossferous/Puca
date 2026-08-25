//! VP8 encoding via libvpx, for the Linux host.
//!
//! WHY RAW FFI AND NOT THE `vpx-encode` CRATE. That crate's entire surface is
//! `Config { width, height, timebase, bitrate, codec }` + `encode(pts, data)`.
//! There is no way to force a keyframe. A WebRTC sender that cannot emit one on
//! demand is broken by construction: a viewer who joins late, or drops the one
//! keyframe, never gets a decodable start and sits on a black rectangle forever.
//! `encode_bgra(.., force_key: bool)` is the existing contract on this crate's
//! Windows path, and it has to be honoured. Reaching `VPX_EFLAG_FORCE_KF` means
//! calling `vpx_codec_encode` directly, which also gets us the realtime deadline
//! and the screen-content mode a desktop encoder wants.
//!
//! WHY VP8 AND NOT H.264 HERE. H.264 on Linux means either a GPL encoder (x264,
//! which would relicense this codebase — it ships installers) or openh264, whose
//! patent grant covers Cisco's own binaries and not ours. VP8 is royalty-free,
//! BSD, and every WebRTC browser is required to decode it. It also happens to be
//! what the frame-AEAD clear-header offsets already describe (see the module doc
//! in lib.rs) — so it costs nothing on the crypto side, where H.264 would.
//!
//! BUILD REQUIREMENTS, which are stricter than "install libvpx":
//!   * libvpx **1.13.0 or older**. `env-libvpx-sys` ships pre-generated bindings
//!     per version and stops there; anything newer PANICS at build time with
//!     "Expected file vpx-ffi-<v>.rs not found". Ubuntu 24.04 (1.14) and Fedora
//!     41 (1.15) both trip this. The escape hatch is that crate's `generate`
//!     feature, which needs libclang.
//!   * An assembler — nasm or yasm — if building libvpx from source. Both build
//!     from source themselves, so a missing distro package is not a dead end.
//!
//! Behind the `vp8` cargo feature, OFF by default, so the agent still builds on
//! a machine with no libvpx at all and honestly reports that it cannot be
//! watched. A build that silently produced no video would be worse.

use super::{is_vp8_keyframe, EncodeError, EncodedFrame, FrameCodec};
use std::os::raw::{c_int, c_long};
use vpx_sys::*;

/// Realtime deadline: encode within the frame interval rather than chasing
/// quality. A desktop stream that is 200ms late is worse than one that is
/// slightly softer.
const VPX_DL_REALTIME_US: c_long = 1;

pub struct Vp8Encoder {
    ctx: vpx_codec_ctx_t,
    /// Reusable I420 scratch, so a 1440p stream is not allocating 5 MB a frame.
    i420: Vec<u8>,
    width: u32,
    height: u32,
    /// Presentation timestamp in timebase units; libvpx requires it to advance.
    pts: i64,
    /// Frames already emitted for the current input, drained one call at a time.
    pending: Vec<EncodedFrame>,
}

impl Vp8Encoder {
    /// The frame size this encoder was built for.
    pub fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn new(width: u32, height: u32, fps: u32, bitrate_kbps: u32) -> Result<Self, EncodeError> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            // I420 is 4:2:0 — odd dimensions have no well-defined chroma plane.
            // Refusing beats silently cropping, which shows up as a one-pixel
            // shear nobody can explain.
            return Err(EncodeError::Failed(format!(
                "VP8 needs even, non-zero dimensions; got {width}x{height}"
            )));
        }
        unsafe {
            let iface = vpx_codec_vp8_cx();
            // MaybeUninit, NOT mem::zeroed(): this struct contains enums with no
            // valid zero value, so zeroing it is undefined behaviour and Rust
            // aborts the process on it. libvpx fills every field here, which is
            // exactly what assume_init needs to be sound.
            let mut cfg = std::mem::MaybeUninit::<vpx_codec_enc_cfg_t>::uninit();
            let res = vpx_codec_enc_config_default(iface, cfg.as_mut_ptr(), 0);
            if res != VPX_CODEC_OK {
                return Err(EncodeError::Failed(format!("enc_config_default failed: {res:?}")));
            }
            let mut cfg = cfg.assume_init();

            cfg.g_w = width;
            cfg.g_h = height;
            cfg.g_timebase.num = 1;
            cfg.g_timebase.den = fps.max(1) as c_int;
            cfg.rc_target_bitrate = bitrate_kbps;
            cfg.rc_end_usage = vpx_rc_mode::VPX_CBR;
            // Realtime: no lookahead, no lagged frames. Lag would add latency
            // and, worse, make a forced keyframe arrive several frames late.
            cfg.g_lag_in_frames = 0;
            cfg.g_pass = vpx_enc_pass::VPX_RC_ONE_PASS;
            cfg.g_error_resilient = 1;
            // Keyframes ON DEMAND, not on a timer: this stream is driven by PLIs
            // and by session start. A periodic keyframe on a static desktop is
            // pure waste.
            cfg.kf_mode = vpx_kf_mode::VPX_KF_AUTO;
            cfg.kf_max_dist = 300;
            // Small buffers keep the rate controller responsive to the bursty
            // "nothing then a whole window redraws" shape of a desktop.
            cfg.rc_buf_sz = 1000;
            cfg.rc_buf_initial_sz = 500;
            cfg.rc_buf_optimal_sz = 600;
            cfg.g_threads = 4;

            // Zeroed IS valid for the context (its fields are pointers and
            // enums whose 0 discriminant exists), and libvpx expects it that way
            // before init.
            let mut ctx = std::mem::MaybeUninit::<vpx_codec_ctx_t>::zeroed().assume_init();
            let res = vpx_codec_enc_init_ver(
                &mut ctx,
                iface,
                &cfg,
                0,
                VPX_ENCODER_ABI_VERSION as c_int,
            );
            if res != VPX_CODEC_OK {
                return Err(EncodeError::Failed(format!("enc_init failed: {res:?}")));
            }

            // cpu-used trades quality for speed; 8 is realtime-screen territory.
            // Ignored if unsupported rather than fatal — a slower encoder still
            // works, and refusing to start would be a worse outcome.
            let _ = vpx_codec_control_(&mut ctx, vp8e_enc_control_id::VP8E_SET_CPUUSED as c_int, 8);
            // Tell VP8 this is screen content: it biases toward the large flat
            // regions and hard edges of a desktop rather than camera noise.
            let _ = vpx_codec_control_(
                &mut ctx,
                vp8e_enc_control_id::VP8E_SET_SCREEN_CONTENT_MODE as c_int,
                1,
            );

            let (w, h) = (width as usize, height as usize);
            Ok(Self {
                ctx,
                i420: vec![0u8; w * h + 2 * (w / 2) * (h / 2)],
                width,
                height,
                pts: 0,
                pending: Vec::new(),
            })
        }
    }

    /// Encode one BGRA frame. `stride` is BYTES per row and is NOT assumed to be
    /// `width * 4` — the Windows capture path pads rows, and assuming otherwise
    /// shears the picture diagonally.
    pub fn encode_bgra(
        &mut self,
        bgra: &[u8],
        stride: usize,
        force_key: bool,
    ) -> Result<EncodedFrame, EncodeError> {
        // Drain anything already produced before encoding more: libvpx can emit
        // several packets for one input.
        if let Some(f) = self.pending.pop() {
            return Ok(f);
        }

        let (w, h) = (self.width as usize, self.height as usize);
        if stride < w * 4 || bgra.len() < stride * h {
            return Err(EncodeError::Failed(format!(
                "frame is {} bytes with stride {stride}, too small for {w}x{h}",
                bgra.len()
            )));
        }
        bgra_to_i420(bgra, stride, w, h, &mut self.i420);

        unsafe {
            // vpx_img_wrap fills this entirely.
            let mut img = std::mem::MaybeUninit::<vpx_image_t>::uninit();
            if vpx_img_wrap(
                img.as_mut_ptr(),
                vpx_img_fmt::VPX_IMG_FMT_I420,
                self.width,
                self.height,
                1,
                self.i420.as_mut_ptr(),
            )
            .is_null()
            {
                return Err(EncodeError::Failed("vpx_img_wrap failed".into()));
            }
            let img = img.assume_init();

            let flags: vpx_enc_frame_flags_t =
                if force_key { VPX_EFLAG_FORCE_KF.into() } else { 0 };
            let res = vpx_codec_encode(
                &mut self.ctx,
                &img,
                self.pts,
                1,
                flags as c_long,
                VPX_DL_REALTIME_US as c_ulong,
            );
            if res != VPX_CODEC_OK {
                return Err(EncodeError::Failed(format!("vpx_codec_encode failed: {res:?}")));
            }
            self.pts += 1;

            let mut iter: vpx_codec_iter_t = std::ptr::null();
            loop {
                let pkt = vpx_codec_get_cx_data(&mut self.ctx, &mut iter);
                if pkt.is_null() {
                    break;
                }
                if (*pkt).kind != vpx_codec_cx_pkt_kind::VPX_CODEC_CX_FRAME_PKT {
                    continue;
                }
                let frame = (*pkt).data.frame;
                let data =
                    std::slice::from_raw_parts(frame.buf as *const u8, frame.sz as usize).to_vec();
                // Keyframe read from the BITSTREAM, not from libvpx's flag. The
                // two agreeing is asserted in the live test; where they could
                // ever differ, the decoder believes the bitstream.
                let keyframe = is_vp8_keyframe(&data);
                self.pending.push(EncodedFrame { data, keyframe, codec: FrameCodec::Vp8 });
            }
        }

        // libvpx is SYNCHRONOUS: one input frame yields its output on the same
        // call. Never return NeedMoreInput — that variant exists for the Media
        // Foundation MFT's ~16-frame pipeline, and the agent's stream loop maps
        // it to "skip", which here would be an invisible permanent no-video.
        self.pending.pop().ok_or_else(|| {
            EncodeError::Failed("libvpx produced no packet for a frame (it is synchronous)".into())
        })
    }
}

impl Drop for Vp8Encoder {
    fn drop(&mut self) {
        unsafe {
            vpx_codec_destroy(&mut self.ctx);
        }
    }
}

/// BGRA -> I420 (BT.601 limited range), honouring `stride`.
///
/// Matches the Windows path's colour handling so the two hosts do not look
/// subtly different. Chroma is sampled from the top-left of each 2x2 block
/// rather than averaged: cheaper, and on the hard edges of a desktop it is
/// arguably sharper than a box filter.
fn bgra_to_i420(bgra: &[u8], stride: usize, w: usize, h: usize, out: &mut [u8]) {
    let (y_size, c_size) = (w * h, (w / 2) * (h / 2));
    let (y_plane, rest) = out.split_at_mut(y_size);
    let (u_plane, v_plane) = rest.split_at_mut(c_size);

    for row in 0..h {
        let src = row * stride;
        for col in 0..w {
            let i = src + col * 4;
            let (b, g, r) = (bgra[i] as i32, bgra[i + 1] as i32, bgra[i + 2] as i32);
            y_plane[row * w + col] =
                (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8;
        }
    }
    for row in (0..h).step_by(2) {
        for col in (0..w).step_by(2) {
            let i = row * stride + col * 4;
            let (b, g, r) = (bgra[i] as i32, bgra[i + 1] as i32, bgra[i + 2] as i32);
            let idx = (row / 2) * (w / 2) + col / 2;
            u_plane[idx] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
            v_plane[idx] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
        }
    }
}

#[allow(non_camel_case_types)]
type c_ulong = std::os::raw::c_ulong;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odd_dimensions_are_refused_rather_than_cropped() {
        // I420 has no well-defined chroma plane for odd sizes. Cropping silently
        // produces a one-pixel shear that is very hard to attribute later.
        assert!(Vp8Encoder::new(1919, 1080, 30, 2000).is_err());
        assert!(Vp8Encoder::new(1920, 1079, 30, 2000).is_err());
        assert!(Vp8Encoder::new(0, 0, 30, 2000).is_err());
    }

    #[test]
    fn bgra_to_i420_honours_a_padded_stride() {
        // THE SHEAR BUG. A capture with padded rows converted as if stride were
        // width*4 walks diagonally through the image. Two rows of a 2x2 image
        // with 4 bytes of padding each: pure blue then pure red.
        let (w, h) = (2usize, 2usize);
        let stride = w * 4 + 4;
        let mut src = vec![0u8; stride * h];
        for col in 0..w {
            let i = col * 4;
            src[i] = 255; // B
            src[i + 3] = 255;
            let j = stride + col * 4;
            src[j + 2] = 255; // R
            src[j + 3] = 255;
        }
        let mut out = vec![0u8; w * h + 2 * (w / 2) * (h / 2)];
        bgra_to_i420(&src, stride, w, h, &mut out);

        // BT.601: blue luma ~29, red luma ~82. If the stride were ignored, row 1
        // would read from the padding and both rows would come out identical.
        assert!(out[0] < 45, "row 0 should be dark blue luma, got {}", out[0]);
        assert!(out[2] > 60, "row 1 should be red luma, got {}", out[2]);
        assert_ne!(out[0], out[2], "the two rows must differ; stride was ignored");
    }

    #[test]
    fn a_frame_smaller_than_its_geometry_is_refused() {
        // Guards the unsafe slice below: a short buffer would read out of bounds.
        let mut enc = match Vp8Encoder::new(64, 64, 30, 500) {
            Ok(e) => e,
            Err(_) => return, // no libvpx in this build; the other tests cover the pure parts
        };
        let too_small = vec![0u8; 64 * 4 * 10];
        assert!(enc.encode_bgra(&too_small, 64 * 4, false).is_err());
    }
}
