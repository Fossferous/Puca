/**
 * Making a JavaScript context collect its garbage soon: the page's
 * (api/plaintextHost.ts) and a plaintext host worker's
 * (api/plaintextHost.worker.ts). Its own module because the worker cannot
 * import plaintextHost.ts, which starts that worker.
 *
 * Why it matters: a Blob object keeps its bytes, and any file Chromium paged
 * them to (blob_storage), alive until the context holding the object
 * collects garbage, revoked URL or not, and an idle page or worker does not
 * do that for minutes (an idle worker, as good as never).
 */

/**
 * Give an ArrayBuffer's memory back NOW: detach it (the ES2024
 * `transfer(0)`), which the engine frees at once, rather than whenever the
 * page next collects garbage (measured in the Android WebView: four 22 MB
 * buffers detached this way, -88 MB of renderer memory with no GC; merely
 * dropped, -10 MB). Only for a buffer nothing else will read. A no-op where
 * the engine has no `transfer`, or on a buffer already detached.
 */
export function freeNow(buf: ArrayBuffer | null | undefined): void {
    try {
        (buf as (ArrayBuffer & { transfer?: (n: number) => ArrayBuffer }) | null | undefined)?.transfer?.(0);
    } catch { /* already detached */ }
}

/**
 * Make this context collect garbage soon. There is no API for it; what V8
 * does is start a full collection when the memory held outside its heap
 * grows by more than its soft limit (64 MB) since the last one, so this asks
 * for 6 x 16 MB of buffers, touching one byte each, and frees them at once
 * (freeNow). Measured on the page: 80 MB this way, every page-made Blob
 * garbage-collected within 2 s in headless Edge and in the Android WebView;
 * 48 MB, none; 9-13 ms of the main thread on the emulator, a few pages of
 * memory. A worker is a V8 isolate of its own and does the same for itself
 * (e2e/plaintext-disk-real-browser.mjs, small files let go of beside others
 * still shown).
 */
export function nudgeCollection(): void {
    const held: ArrayBuffer[] = [];
    try {
        for (let i = 0; i < 6; i++) {
            const a = new ArrayBuffer(16 * 1024 * 1024);
            new Uint8Array(a)[0] = 1;
            held.push(a);
        }
    } catch { /* address space is short (a 32-bit phone): what we got */ }
    for (const a of held) freeNow(a);
}
