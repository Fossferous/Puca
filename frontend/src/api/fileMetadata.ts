/**
 * Every file's metadata, by its format, before it leaves the device: the one
 * door every attachment's seal (api/attachments.ts sealFileForUpload) and the
 * clear uploads and peer-to-peer sends (stripFileMetadata, through
 * api/uploads.ts and api/fileTransferManager.ts) pass. What each format loses
 * and keeps is in its own module; docs/SECURITY_MODEL.md, *Photos are
 * stripped of metadata*, has the whole list.
 *
 *   JPEG, PNG, WebP    api/imageMetadata.ts  (lossless; Orientation kept)
 *   GIF                api/gifMetadata.ts    (lossless; animation and loop kept)
 *   TIFF               api/tiffMetadata.ts   (in place; strips and tiles untouched)
 *   MP4, MOV, M4A, 3GP, HEIC, AVIF
 *                      api/isoBmffMetadata.ts (in place; media untouched)
 *   WebM, MKV          api/matroskaMetadata.ts (in place; frames untouched)
 *   SVG                api/svgMetadata.ts    (re-written; nothing active kept)
 *
 * THE BYTES DECIDE for the binary formats, not the name or the declared type,
 * which are whatever the sender's device said: a JPEG called .png is a JPEG.
 * An SVG is text, so it is one when its type or name says so, or when it says
 * nothing and its bytes open like one. A file that claims to be one of these
 * and cannot be read is REFUSED (ImageMetadataError, with a sentence that
 * says why), never sent with what could not be read. Anything else (a PDF, an
 * archive, audio other than M4A, a camera raw file) goes as it is.
 */
import { ImageMetadataError, sniffStrippable, stripImageMetadata } from './imageMetadata';
import { gifFile, isGif, planGif, stripGif } from './gifMetadata';
import { isBigTiff, isTiff, tiffPatches } from './tiffMetadata';
import { looksIsoBmff, planIsoBmff } from './isoBmffMetadata';
import { isEbml, planMatroska } from './matroskaMetadata';
import { cleanSvg, isGzip, sniffSvg } from './svgMetadata';
import { applyInPlace, checkedPatches, fileSource, memorySource, patchedFile, readBlobBytes, withoutNoops, type Patch, type Source } from './metadataPatches';

export interface FileHint {
    name?: string;
    type?: string;
}

const ext = (name?: string): string => (name || '').toLowerCase().split('.').pop() ?? '';
const typeOf = (t?: string): string => (t || '').toLowerCase().split(';')[0].trim();

/** Camera raw files: passed as they are (raw software needs the camera's data; no app here shows one). */
const RAW_EXT = new Set(['dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raw', 'pef', 'srw', '3fr', 'erf', 'kdc', 'mrw', 'iiq', 'rwl', 'x3f', 'raf', 'mos', 'mef', 'dcr']);
const MOVIE_EXT = new Set(['mp4', 'm4v', 'mov', 'qt', 'm4a', 'm4b', '3gp', '3g2', 'heic', 'heif', 'hif', 'avif']);
const SVG_TYPE = 'image/svg+xml';

function saysSvg(hint: FileHint): boolean {
    return typeOf(hint.type) === SVG_TYPE || ext(hint.name) === 'svg' || ext(hint.name) === 'svgz';
}
function saysNothing(hint: FileHint): boolean {
    const t = typeOf(hint.type);
    return t === '' || t === 'application/octet-stream';
}
function saysMovie(hint: FileHint): boolean {
    const t = typeOf(hint.type);
    return t.startsWith('video/') || t === 'audio/mp4' || t === 'audio/x-m4a' || t === 'audio/3gpp' || MOVIE_EXT.has(ext(hint.name));
}
function isoFormat(hint: FileHint, head: Uint8Array): string {
    const brand = head.length >= 12 ? String.fromCharCode(head[8], head[9], head[10], head[11]) : '';
    if (/^(avif|avis)$/.test(brand) || ext(hint.name) === 'avif') return 'AVIF';
    if (/^(heic|heix|heim|heis|mif1|msf1)$/.test(brand) || /^(heic|heif|hif)$/.test(ext(hint.name))) return 'HEIC';
    if (brand === 'qt  ' || ext(hint.name) === 'mov') return 'MOV';
    return 'MP4';
}

type Kind = 'image' | 'gif' | 'tiff' | 'iso' | 'ebml' | 'svg' | 'none';

/** Which stripper these bytes (their first 4 KB or more) and what the device said about them call for. */
function kindOf(head: Uint8Array, hint: FileHint): Kind {
    if (sniffStrippable(head)) return 'image';
    if (isGif(head)) return 'gif';
    if (isTiff(head) || isBigTiff(head)) return RAW_EXT.has(ext(hint.name)) ? 'none' : 'tiff';
    if (isEbml(head)) return 'ebml';
    if (looksIsoBmff(head, saysMovie(hint))) return RAW_EXT.has(ext(hint.name)) ? 'none' : 'iso';
    if (saysSvg(hint) || (saysNothing(hint) && !isGzip(head) && sniffSvg(head))) return 'svg';
    return 'none';
}

/** The plan for a container, checked: null when there is nothing to change. */
async function containerPlan(kind: 'iso' | 'ebml', src: Source, hint: FileHint, head: Uint8Array): Promise<Patch[] | null> {
    const format = kind === 'iso' ? isoFormat(hint, head) : (ext(hint.name) === 'mkv' || typeOf(hint.type) === 'video/x-matroska' ? 'MKV' : 'WebM');
    const plan = kind === 'iso' ? await planIsoBmff(src, format) : await planMatroska(src, format);
    if (!plan || plan.length === 0) return null;
    const checked = checkedPatches(plan, src.size);
    if (!checked) throw new ImageMetadataError(format, 'what it holds overlaps itself', kind === 'iso' && /HEIC|AVIF/.test(format) ? 'photo' : 'video');
    const real = await withoutNoops(checked, src);
    return real.length ? real : null;
}

/**
 * These bytes without their metadata, for the seal. The binary containers
 * (TIFF, MP4/MOV/HEIC/AVIF, WebM/MKV) are overwritten IN PLACE, in `bytes`
 * itself, and the same array comes back: the seal owns them (a File it read,
 * or plaintext it decrypted only to seal again). JPEG, PNG, WebP, GIF and SVG
 * come back as a new array when anything was removed. Anything else comes
 * back as it came.
 */
export async function stripAttachmentMetadata(bytes: Uint8Array, hint: FileHint = {}): Promise<Uint8Array> {
    const head = bytes.subarray(0, 4096);
    const kind = kindOf(head, hint);
    switch (kind) {
        case 'image': return stripImageMetadata(bytes);
        case 'gif': return stripGif(bytes);
        case 'svg': return cleanSvg(bytes);
        case 'tiff': {
            const p = await tiffPlan(memorySource(bytes));
            if (p) applyInPlace(bytes, p);
            return bytes;
        }
        case 'iso': case 'ebml': {
            const p = await containerPlan(kind, memorySource(bytes), hint, head);
            if (p) applyInPlace(bytes, p);
            return bytes;
        }
        default: return bytes;
    }
}

/** A TIFF's checked overwrites, or null when there is nothing to change (a raw file among them). */
async function tiffPlan(src: Source): Promise<Patch[] | null> {
    const p = await tiffPatches(src);
    if (!p || p.length === 0) return null;
    const checked = checkedPatches(p, src.size);
    if (!checked) throw new ImageMetadataError('TIFF', 'what it holds overlaps itself', 'picture');
    const real = await withoutNoops(checked, src);
    return real.length ? real : null;
}

/** Declared types the clear-upload door never opens: ciphertext (an attachment's seal) and text, among others. */
function mayHoldMetadata(t: string): boolean {
    return t === '' || t.startsWith('image/') || t.startsWith('video/') || t === 'audio/mp4' || t === 'audio/x-m4a' || t === 'audio/3gpp';
}

/**
 * The same for a File (the clear uploads: avatars, icons, emoji, a mode's
 * background; and a peer-to-peer send, up to gigabytes). The name and type are
 * kept. A file whose declared type cannot hold one of these formats (an
 * octet-stream: every sealed attachment's ciphertext passes here) is returned
 * as it came, unread. A video, a TIFF or a GIF is never read whole into
 * memory: it is read in slices (api/metadataPatches.ts fileSource; a video
 * and a TIFF only where metadata can be), and the result is the original's
 * slices with the overwrites between them (a GIF's, the blocks it keeps).
 */
export async function stripFileMetadata(file: File): Promise<File> {
    const t = typeOf(file.type);
    if (!mayHoldMetadata(t)) return file;
    let head: Uint8Array;
    // Could not even be read: the upload fails on it in its own words.
    try { head = await readBlobBytes(file.slice(0, 4096)); } catch { return file; }
    const hint = { name: file.name, type: file.type };
    const kind = kindOf(head, hint);
    if (kind === 'none') return file;
    if (kind === 'iso' || kind === 'ebml') {
        const plan = await containerPlan(kind, fileSource(file), hint, head);
        return plan ? patchedFile(file, plan) : file;
    }
    if (kind === 'tiff') {
        const plan = await tiffPlan(fileSource(file));
        return plan ? patchedFile(file, plan) : file;
    }
    if (kind === 'gif') {
        const plan = await planGif(fileSource(file));
        return plan ? gifFile(file, plan) : file;
    }
    // JPEG, PNG, WebP and SVG: read whole (an SVG is parsed as one document).
    const bytes = await readBlobBytes(file);
    const out = await stripAttachmentMetadata(bytes, hint);
    if (out === bytes) return file;
    return new File([out as BlobPart], file.name, { type: file.type, lastModified: file.lastModified });
}
