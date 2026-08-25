/* @ts-self-types="./df_wasm.d.ts" */

export class DeepFilter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DeepFilterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_deepfilter_free(ptr, 0);
    }
    /**
     * The model's algorithmic delay in hops: `process()` for input hop N
     * returns the enhanced samples of hop N − delay. For DFN3 that is 3
     * (one hop of STFT framing + two hops of lookahead). Callers that
     * align the enhanced stream against the raw one — or apply a
     * per-hop inverse gain — must use THIS, not assume zero.
     * @returns {number}
     */
    get delay_hops() {
        const ret = wasm.deepfilter_delay_hops(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Samples per hop (480 @ 48 kHz). The caller must feed exactly this many.
     * @returns {number}
     */
    get hop_size() {
        const ret = wasm.deepfilter_hop_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Local-SNR estimate (dB) of the last `process()` call. lsnr is clamped
     * by the model to [lsnr_min, lsnr_max] = [-15, 35]; the near-silence
     * early return reports -15.
     * @returns {number}
     */
    get last_lsnr() {
        const ret = wasm.deepfilter_last_lsnr(this.__wbg_ptr);
        return ret;
    }
    /**
     * False if the last `process()` fail-opened and returned its input hop
     * unchanged (see the field doc). True after a normal call, including
     * upstream's own near-silence early return (which does run to
     * completion, returning zeros — the caller floors its input so that
     * path is unreachable in production anyway).
     * @returns {boolean}
     */
    get last_ok() {
        const ret = wasm.deepfilter_last_ok(this.__wbg_ptr);
        return ret !== 0;
    }
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
     * @param {number | null} [atten_lim_db]
     * @param {number | null} [min_db_thresh]
     * @param {number | null} [post_filter_beta]
     * @param {number | null} [max_db_erb_thresh]
     * @param {number | null} [max_db_df_thresh]
     */
    constructor(atten_lim_db, min_db_thresh, post_filter_beta, max_db_erb_thresh, max_db_df_thresh) {
        const ret = wasm.deepfilter_new(isLikeNone(atten_lim_db) ? Number.MAX_SAFE_INTEGER : Math.fround(atten_lim_db), isLikeNone(min_db_thresh) ? Number.MAX_SAFE_INTEGER : Math.fround(min_db_thresh), isLikeNone(post_filter_beta) ? Number.MAX_SAFE_INTEGER : Math.fround(post_filter_beta), isLikeNone(max_db_erb_thresh) ? Number.MAX_SAFE_INTEGER : Math.fround(max_db_erb_thresh), isLikeNone(max_db_df_thresh) ? Number.MAX_SAFE_INTEGER : Math.fround(max_db_df_thresh));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        DeepFilterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Denoise one hop of mono f32 samples (length == hop_size). Returns the
     * enhanced hop; on error, returns the input unchanged (fail-open).
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    process(input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.deepfilter_process(this.__wbg_ptr, ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * @param {number} db
     */
    set_atten_lim(db) {
        wasm.deepfilter_set_atten_lim(this.__wbg_ptr, db);
    }
    /**
     * @param {number} beta
     */
    set_post_filter_beta(beta) {
        wasm.deepfilter_set_post_filter_beta(this.__wbg_ptr, beta);
    }
    /**
     * Runtime knob setters — the same fields the LADSPA plugin exposes as
     * live controls. Used by the offline sweep runner (e2e/df-offline.mjs) so
     * one wasm instance can be re-tuned between passes, and by tests.
     * @param {number} min_db_thresh
     * @param {number} max_db_erb_thresh
     * @param {number} max_db_df_thresh
     */
    set_thresholds(min_db_thresh, max_db_erb_thresh, max_db_df_thresh) {
        wasm.deepfilter_set_thresholds(this.__wbg_ptr, min_db_thresh, max_db_erb_thresh, max_db_df_thresh);
    }
}
if (Symbol.dispose) DeepFilter.prototype[Symbol.dispose] = DeepFilter.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./df_wasm_bg.js": import0,
    };
}

const DeepFilterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_deepfilter_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('df_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
