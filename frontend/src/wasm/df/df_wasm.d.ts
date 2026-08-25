/* tslint:disable */
/* eslint-disable */

export class DeepFilter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build a mono DeepFilterNet processor (embedded default model).
     *
     * Runtime knobs (pass `undefined` from JS to keep the upstream default):
     * - `atten_lim_db`: cap total noise attenuation by mixing that fraction of
     *   the dry signal back in (upstream default 100 = unlimited). Also floors
     *   the damage when the model wrongly gates SPEECH: even a zero-masked
     *   frame keeps dry × 10^(-lim/20).
     * - `min_db_thresh`: local-SNR below which a frame is fully zero-masked
     *   (upstream default -10 dB). The 2026-08-05 muffling investigation
     *   measured this gate eating 40% of samples for a quiet speaker, and
     *   chattering on speech while the model's noise belief was stale.
     * - `post_filter_beta`: enable upstream's perceptual post filter (> 0).
     * - `max_db_erb_thresh`: local-SNR ABOVE which the frame is passed through
     *   with NO processing at all (upstream real-time default 30 dB; upstream's
     *   offline CLI uses 35 = never, since lsnr is clamped to lsnr_max 35).
     * - `max_db_df_thresh`: local-SNR above which only the ERB mask runs and
     *   the deep-filtering stage is skipped (upstream real-time default 20 dB;
     *   offline CLI 35 = never).
     *
     * The two max thresholds are the CPU-saving stage skips of upstream's
     * LADSPA/demo path. On a clean input they toggle frame to frame as the
     * lsnr estimate crosses them, which switches the residual noise floor
     * between suppressed and untouched — see dfTuning.ts for what was
     * measured and why the production values are what they are.
     */
    constructor(atten_lim_db?: number | null, min_db_thresh?: number | null, post_filter_beta?: number | null, max_db_erb_thresh?: number | null, max_db_df_thresh?: number | null);
    /**
     * Denoise one hop of mono f32 samples (length == hop_size). Returns the
     * enhanced hop; on error, returns the input unchanged (fail-open).
     */
    process(input: Float32Array): Float32Array;
    set_atten_lim(db: number): void;
    set_post_filter_beta(beta: number): void;
    /**
     * Runtime knob setters — the same fields the LADSPA plugin exposes as
     * live controls. Used by the offline sweep runner (e2e/df-offline.mjs) so
     * one wasm instance can be re-tuned between passes, and by tests.
     */
    set_thresholds(min_db_thresh: number, max_db_erb_thresh: number, max_db_df_thresh: number): void;
    /**
     * The model's algorithmic delay in hops: `process()` for input hop N
     * returns the enhanced samples of hop N − delay. For DFN3 that is 3
     * (one hop of STFT framing + two hops of lookahead). Callers that
     * align the enhanced stream against the raw one — or apply a
     * per-hop inverse gain — must use THIS, not assume zero.
     */
    readonly delay_hops: number;
    /**
     * Samples per hop (480 @ 48 kHz). The caller must feed exactly this many.
     */
    readonly hop_size: number;
    /**
     * Local-SNR estimate (dB) of the last `process()` call. lsnr is clamped
     * by the model to [lsnr_min, lsnr_max] = [-15, 35]; the near-silence
     * early return reports -15.
     */
    readonly last_lsnr: number;
    /**
     * False if the last `process()` fail-opened and returned its input hop
     * unchanged (see the field doc). True after a normal call, including
     * upstream's own near-silence early return (which does run to
     * completion, returning zeros — the caller floors its input so that
     * path is unreachable in production anyway).
     */
    readonly last_ok: boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_deepfilter_free: (a: number, b: number) => void;
    readonly deepfilter_delay_hops: (a: number) => number;
    readonly deepfilter_hop_size: (a: number) => number;
    readonly deepfilter_last_lsnr: (a: number) => number;
    readonly deepfilter_last_ok: (a: number) => number;
    readonly deepfilter_new: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly deepfilter_process: (a: number, b: number, c: number) => [number, number];
    readonly deepfilter_set_atten_lim: (a: number, b: number) => void;
    readonly deepfilter_set_post_filter_beta: (a: number, b: number) => void;
    readonly deepfilter_set_thresholds: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
