/**
 * The DOM half of a server mode's look (docs/SERVER_MODES.md): what the reader's
 * theme actually paints, how bright a picture actually is, and shrinking a
 * chosen picture to what every member, phones included, should have to download.
 * The arithmetic is api/serverModes.ts.
 */
import {
    PICTURE_TEXT_TOKENS,
    type PictureLimit,
    type Rgb,
    type TonePlan,
    parseCssColor,
    pictureLimit,
    pictureTextColours,
    planTone,
    toneMap,
} from './serverModes';

/** Longest edge of a stored background: a full-window picture. */
export const BACKGROUND_MAX_EDGE = 1920;
/** Mirrors the server's MAX_BACKGROUND_BYTES, to say so before uploading. */
export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024;
const BACKGROUND_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Longest edge a picture is mapped at. It is a backdrop, and a phone has to do this too. */
export const PICTURE_MAX_EDGE = 1600;
const MAP_BAND_ROWS = 120;
const PICTURE_QUALITY = 0.94;

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

/** The theme as the reader has it right now, and what a picture has to do on it. */
export interface PictureTheme {
    limit: PictureLimit;
    text: Record<string, string>;
    /** The surfaces that lie over the picture, translucent. */
    composer: string;
    hover: string;
    active: string;
    mention: string;
    mentionHover: string;
    halo: string;
}

/** Null when the theme cannot be read: no picture then, since nothing could be held to it. */
export function readPictureTheme(): PictureTheme | null {
    const surface = readThemeColor('--bg-primary');
    const below = readThemeColor('--bg-secondary');
    if (!surface || !below) return null;
    const tokens: Record<string, Rgb> = {};
    for (const token of PICTURE_TEXT_TOKENS) {
        const colour = readThemeColor(token);
        if (colour) tokens[token] = colour;
    }
    // Text in the brand colour (a name with no role colour, a link, who a reply answers), which
    // may be the mode's accent: one dark enough to carry a white label was 1.28:1 over a picture.
    const brand = readThemeColor('--brand-primary');
    if (brand) tokens['--mode-brand-text'] = brand;
    const limit = pictureLimit(surface);
    // Everything translucent over a picture leans away from the text, so that it can only
    // add contrast. Measured: amoled's own selection grey over a moon leaves 3.64:1, and the
    // gold on a row that mentions you 4.05:1.
    const dark = limit.kind === 'ceiling';
    const lean = dark ? '0, 0, 0' : '255, 255, 255';
    return {
        limit,
        text: pictureTextColours(tokens, limit),
        composer: `rgba(${below[0]}, ${below[1]}, ${below[2]}, 0.55)`,
        hover: `rgba(${lean}, ${dark ? 0.28 : 0.45})`,
        active: `rgba(${lean}, ${dark ? 0.38 : 0.6})`,
        mention: dark ? 'rgba(70, 45, 0, 0.45)' : 'rgba(255, 226, 150, 0.6)',
        mentionHover: dark ? 'rgba(70, 45, 0, 0.6)' : 'rgba(255, 226, 150, 0.75)',
        halo: dark ? '0 0 3px rgba(0, 0, 0, 0.75), 0 1px 2px rgba(0, 0, 0, 0.6)' : '0 0 3px rgba(255, 255, 255, 0.85), 0 1px 2px rgba(255, 255, 255, 0.6)',
    };
}

/**
 * The picture tone-mapped for this theme, as a `data:` URL and not a `blob:` one: it stays up
 * for as long as the mode is on screen, and a long-lived Blob is what keeps decrypted
 * attachments on disk (api/authedMedia.ts says how). So it has nothing to revoke either.
 * Null for a picture that cannot be read: no picture then, rather than one nobody measured.
 */
export async function mapPicture(url: string, limit: PictureLimit): Promise<{ url: string; plan: TonePlan } | null> {
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        const k = Math.min(1, PICTURE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const plan = planTone(pixels.data, limit);
        // In bands: a phone takes half a second over this, and the chat is running.
        const band = 4 * canvas.width * MAP_BAND_ROWS;
        for (let at = 0; at < pixels.data.length; at += band) {
            toneMap(pixels.data.subarray(at, at + band), plan);
            await new Promise(done => setTimeout(done));
        }
        ctx.putImageData(pixels, 0, 0);
        const mapped = canvas.toDataURL('image/jpeg', PICTURE_QUALITY);
        // Before the collector gets to it: iOS caps what all canvases may hold together.
        canvas.width = 0;
        return { url: mapped, plan };
    } catch {
        return null;
    }
}

/** `.chat-main`'s style with a mapped picture behind it. Inherited by everything in the chat. */
export function pictureStyle(url: string, theme: PictureTheme): Record<string, string> {
    return {
        // Text that names no colour inherits it from <body>, as a colour, not as the variable.
        color: theme.text['--text-normal'],
        backgroundImage: `url("${url}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        textShadow: theme.halo,
        '--bg-modifier-hover': theme.hover,
        '--bg-modifier-active': theme.active,
        '--bg-modifier-selected': theme.active,
        '--mode-composer-bg': theme.composer,
        '--mode-mention-bg': theme.mention,
        '--mode-mention-hover-bg': theme.mentionHover,
        '--mode-reply-bg': theme.hover,
        '--mode-reply-hover-bg': theme.active,
        // A file's chip has fixed colours for saved and failed: on a surface of its own they hold.
        '--mode-chip-bg': 'var(--bg-secondary)',
        // Light's darkened amber and red are written into the rule, and hold only on Light's surface.
        '--mode-warning-text': theme.text['--text-warning'],
        '--mode-danger-text': theme.text['--text-danger'],
        ...theme.text,
    };
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
