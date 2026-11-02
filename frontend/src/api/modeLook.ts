/**
 * The DOM half of a server mode's look (docs/SERVER_MODES.md): what the reader's
 * theme actually paints, how bright a picture actually is, and shrinking a
 * chosen picture to what every member, phones included, should have to download.
 * The arithmetic is api/serverModes.ts.
 */
import { type Rgb, parseCssColor } from './serverModes';

/** Longest edge of a stored background: a full-window picture, dimmed. */
export const BACKGROUND_MAX_EDGE = 1920;
/** Mirrors the server's MAX_BACKGROUND_BYTES, to say so before uploading. */
export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024;
const BACKGROUND_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Worst case when a picture cannot be measured: pure black and pure white. */
export const UNKNOWN_EXTREMES: readonly Rgb[] = [[0, 0, 0], [255, 255, 255]];

/**
 * A theme token's colour as the browser resolves it. Reading the custom property
 * itself would hand back `hsl(var(--theme-hue) ...)` or a substituted string; a
 * probe element's computed colour is always `rgb(...)`.
 */
export function readThemeColor(token: string): Rgb | null {
    if (typeof document === 'undefined') return null;
    const probe = document.createElement('div');
    probe.style.color = `var(${token})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return parseCssColor(value);
}

/**
 * The darkest and lightest parts of a picture, from a 32x32 reduction: fine
 * enough for a region a line of text could sit in, and a speck smaller than that
 * averages out rather than dimming the whole picture on its account.
 */
export async function measureExtremes(url: string): Promise<readonly Rgb[]> {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return UNKNOWN_EXTREMES;
        ctx.drawImage(img, 0, 0, 32, 32);
        const { data } = ctx.getImageData(0, 0, 32, 32);
        let dark: Rgb = [255, 255, 255];
        let light: Rgb = [0, 0, 0];
        const weight = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
        for (let i = 0; i < data.length; i += 4) {
            const pixel: Rgb = [data[i], data[i + 1], data[i + 2]];
            if (weight(pixel) < weight(dark)) dark = pixel;
            if (weight(pixel) > weight(light)) light = pixel;
        }
        return [dark, light];
    } catch {
        return UNKNOWN_EXTREMES;
    }
}

/** Thrown with a message that can be shown as it is. */
export class BackgroundRefused extends Error {}

/**
 * The picture that gets uploaded: at most BACKGROUND_MAX_EDGE on its long edge,
 * a JPEG (a flat one: drawing it takes any animation's first frame and drops
 * every byte of metadata). A GIF is refused before that rather than flattened,
 * because whoever chose it expects it to move. api/uploads.ts `uploadFile`, the
 * one door to /upload, still strips what it strips.
 */
export async function prepareBackground(file: File): Promise<File> {
    if (!BACKGROUND_TYPES.includes(file.type)) {
        throw new BackgroundRefused('Choose a JPEG, PNG or WebP picture. Animated pictures are not supported.');
    }
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new BackgroundRefused('That picture could not be read.');
    }
    try {
        const k = Math.min(1, BACKGROUND_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * k));
        canvas.height = Math.max(1, Math.round(bitmap.height * k));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new BackgroundRefused('That picture could not be read.');
        // A JPEG has no transparency: what shows through a PNG's holes is black.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.82, 0.68, 0.5]) {
            const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', quality));
            if (blob && blob.size <= BACKGROUND_MAX_BYTES) {
                return new File([blob], 'background.jpg', { type: 'image/jpeg' });
            }
        }
        throw new BackgroundRefused('That picture is too large for a background.');
    } finally {
        bitmap.close();
    }
}
