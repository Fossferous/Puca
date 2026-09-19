/**
 * Shrink a photo before it is encrypted and uploaded as a note image.
 *
 * A phone camera hands back 4000-pixel, multi-megabyte JPEGs; a note shows
 * them at card width. Downscaling on the device keeps uploads fast on a
 * phone link, stays far below the 25 MB upload cap, and makes thumbnails
 * cheap to decrypt. It happens BEFORE encryption, so the server only ever
 * sees the smaller ciphertext.
 *
 * Only what can be re-encoded without loss of meaning is touched: GIFs
 * (animation) and SVGs pass through unchanged, and so does anything already
 * small. Where the platform cannot decode the image (no createImageBitmap,
 * a HEIC the browser does not read, jsdom) the original goes through — the
 * upload cap still applies to it.
 */

export const MAX_IMAGE_EDGE = 2048;
/** Files at or under this size and edge are left alone. */
export const SMALL_IMAGE_BYTES = 1_500_000;

/** The size to scale `w`×`h` to so the long edge is at most `maxEdge`. */
export function fitWithin(w: number, h: number, maxEdge = MAX_IMAGE_EDGE): { w: number; h: number } {
    const long = Math.max(w, h);
    if (long <= maxEdge || long <= 0) return { w, h };
    const k = maxEdge / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Whether a file is worth re-encoding at all. */
export function shouldShrink(type: string, bytes: number, w: number, h: number): boolean {
    if (!type.startsWith('image/') || type === 'image/gif' || type === 'image/svg+xml') return false;
    return bytes > SMALL_IMAGE_BYTES || Math.max(w, h) > MAX_IMAGE_EDGE;
}

export async function prepareImageForUpload(file: File): Promise<File> {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        return file;
    }
    try {
        if (!shouldShrink(file.type, file.size, bitmap.width, bitmap.height)) return file;
        const { w, h } = fitWithin(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, w, h);
        // PNG stays PNG (screenshots, transparency); everything else is a JPEG.
        const png = file.type === 'image/png';
        const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.85));
        if (!blob || blob.size >= file.size) return file;
        const stem = (file.name || 'photo').replace(/\.[^.]+$/, '');
        return new File([blob], `${stem}.${png ? 'png' : 'jpg'}`, { type: blob.type });
    } finally {
        bitmap.close();
    }
}
