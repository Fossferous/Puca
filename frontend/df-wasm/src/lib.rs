//! DeepFilterNet (DFN3) noise suppression compiled to WebAssembly.
//! Wraps the same `deep_filter` Rust pipeline the desktop backend uses, so the
//! DSP + model are the proven upstream implementation — we only expose a thin
//! per-hop `process()` for the browser audio graph to drive.
use wasm_bindgen::prelude::*;
use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::Array2;

#[wasm_bindgen]
pub struct DeepFilter {
    inner: DfTract,
    hop: usize,
    /// Local-SNR estimate (dB) the model produced for the most recent hop —
    /// the value `apply_stages` gates on. Exposed for telemetry: it is the
    /// only way to see WHICH processing regime a hop actually took.
    last_lsnr: f32,
    /// Whether the most recent `process()` actually ran the model. False when
    /// it fail-opened (bad length, shape error, or an upstream Err) and
    /// returned the INPUT hop unchanged — which is hop N, not the enhanced
    /// hop N − delay the caller expects at that position. The caller needs to
    /// know, so it can substitute an aligned raw hop instead.
    last_ok: bool,
}

#[wasm_bindgen]
impl DeepFilter {
    /// Build a mono DeepFilterNet processor (embedded default model).
    ///
    /// Runtime knobs (pass `undefined` from JS to keep the upstream default):
    /// - `atten_lim_db`: cap total noise attenuation by mixing that fraction of
    ///   the dry signal back in (upstream default 100 = unlimited). Also floors
    ///   the damage when the model wrongly gates SPEECH: even a zero-masked
    ///   frame keeps dry × 10^(-lim/20).
    /// - `min_db_thresh`: local-SNR below which a frame is fully zero-masked
    ///   (upstream default -10 dB). The 2026-08-05 muffling investigation
    ///   measured this gate eating 40% of samples for a quiet speaker, and
    ///   chattering on speech while the model's noise belief was stale.
    /// - `post_filter_beta`: enable upstream's perceptual post filter (> 0).
    /// - `max_db_erb_thresh`: local-SNR ABOVE which the frame is passed through
    ///   with NO processing at all (upstream real-time default 30 dB; upstream's
    ///   offline CLI uses 35 = never, since lsnr is clamped to lsnr_max 35).
    /// - `max_db_df_thresh`: local-SNR above which only the ERB mask runs and
    ///   the deep-filtering stage is skipped (upstream real-time default 20 dB;
    ///   offline CLI 35 = never).
    ///
    /// The two max thresholds are the CPU-saving stage skips of upstream's
    /// LADSPA/demo path. On a clean input they toggle frame to frame as the
    /// lsnr estimate crosses them, which switches the residual noise floor
    /// between suppressed and untouched — see dfTuning.ts for what was
    /// measured and why the production values are what they are.
    #[wasm_bindgen(constructor)]
    pub fn new(
        atten_lim_db: Option<f32>,
        min_db_thresh: Option<f32>,
        post_filter_beta: Option<f32>,
        max_db_erb_thresh: Option<f32>,
        max_db_df_thresh: Option<f32>,
    ) -> Result<DeepFilter, JsValue> {
        let dfp = DfParams::default();
        let mut rp = RuntimeParams::default_with_ch(1);
        if let Some(lim) = atten_lim_db {
            rp = rp.with_atten_lim(lim);
        }
        if min_db_thresh.is_some() || max_db_erb_thresh.is_some() || max_db_df_thresh.is_some() {
            let min = min_db_thresh.unwrap_or(rp.min_db_thresh);
            let erb = max_db_erb_thresh.unwrap_or(rp.max_db_erb_thresh);
            let dfe = max_db_df_thresh.unwrap_or(rp.max_db_df_thresh);
            rp = rp.with_thresholds(min, erb, dfe);
        }
        if let Some(beta) = post_filter_beta {
            rp = rp.with_post_filter(beta);
        }
        let inner = DfTract::new(dfp, &rp).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let hop = inner.hop_size;
        Ok(DeepFilter { inner, hop, last_lsnr: 0., last_ok: true })
    }

    /// Samples per hop (480 @ 48 kHz). The caller must feed exactly this many.
    #[wasm_bindgen(getter)]
    pub fn hop_size(&self) -> usize {
        self.hop
    }

    /// The model's algorithmic delay in hops: `process()` for input hop N
    /// returns the enhanced samples of hop N − delay. For DFN3 that is 3
    /// (one hop of STFT framing + two hops of lookahead). Callers that
    /// align the enhanced stream against the raw one — or apply a
    /// per-hop inverse gain — must use THIS, not assume zero.
    #[wasm_bindgen(getter)]
    pub fn delay_hops(&self) -> usize {
        // STFT: analysis frame N spans hops [N-1, N]; synthesis at frame N
        // completes hop N-1. Plus the model's own lookahead (max of conv and
        // df lookahead, both 2 for DFN3), applied by masking a frame that
        // many steps back in the rolling spectrum buffer.
        1 + self.inner.lookahead
    }

    /// Local-SNR estimate (dB) of the last `process()` call. lsnr is clamped
    /// by the model to [lsnr_min, lsnr_max] = [-15, 35]; the near-silence
    /// early return reports -15.
    #[wasm_bindgen(getter)]
    pub fn last_lsnr(&self) -> f32 {
        self.last_lsnr
    }

    /// False if the last `process()` fail-opened and returned its input hop
    /// unchanged (see the field doc). True after a normal call, including
    /// upstream's own near-silence early return (which does run to
    /// completion, returning zeros — the caller floors its input so that
    /// path is unreachable in production anyway).
    #[wasm_bindgen(getter)]
    pub fn last_ok(&self) -> bool {
        self.last_ok
    }

    /// Runtime knob setters — the same fields the LADSPA plugin exposes as
    /// live controls. Used by the offline sweep runner (e2e/df-offline.mjs) so
    /// one wasm instance can be re-tuned between passes, and by tests.
    pub fn set_thresholds(&mut self, min_db_thresh: f32, max_db_erb_thresh: f32, max_db_df_thresh: f32) {
        self.inner.min_db_thresh = min_db_thresh;
        self.inner.max_db_erb_thresh = max_db_erb_thresh;
        self.inner.max_db_df_thresh = max_db_df_thresh;
    }

    pub fn set_post_filter_beta(&mut self, beta: f32) {
        self.inner.set_pf_beta(beta.max(0.));
    }

    pub fn set_atten_lim(&mut self, db: f32) {
        self.inner.set_atten_lim(db);
    }

    /// Denoise one hop of mono f32 samples (length == hop_size). Returns the
    /// enhanced hop; on error, returns the input unchanged (fail-open).
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.last_ok = false;
        if input.len() != self.hop {
            return input.to_vec();
        }
        let noisy = match Array2::from_shape_vec((1, self.hop), input.to_vec()) {
            Ok(a) => a,
            Err(_) => return input.to_vec(),
        };
        let mut enh = Array2::<f32>::zeros((1, self.hop));
        match self.inner.process(noisy.view(), enh.view_mut()) {
            Ok(lsnr) => {
                self.last_lsnr = lsnr;
                self.last_ok = true;
                enh.row(0).to_vec()
            }
            Err(_) => input.to_vec(),
        }
    }
}
