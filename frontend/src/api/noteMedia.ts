/**
 * Uploading a note's own photos, drawings and files: shrink (photos only),
 * encrypt, upload, and hand back the refs for the list's sealed sidecar
 * (api/listContent.ts). All-or-nothing per call: if one upload fails, the
 * ones that already landed are deleted again, so a failed save never leaves
 * files counting against the quota that no note names.
 *
 * A NOTE HOLDS ANY FILE, not only pictures. The upload primitive never cared
 * — everything goes up as `attachment.enc` and the real name and type live
 * in the sealed sidecar — so what is here is the shrink being skipped for a
 * non-image (pulling a 25 MB PDF through the image decoder only stalls a
 * phone) and the display name being CLAMPED: the sealed sidecar has a 16 KiB
 * envelope cap (MAX_LIST_ATTACHMENTS_LEN, src/list_content.rs), and a
 * pathological 4 KB filename would push a note past it and make the save
 * fail with a 400 the user cannot explain.
 */
import { type TaskAttachmentRef, MAX_TASK_ATTACHMENTS, isAttachmentsLocked, parseTaskAttachments } from './tasks';
import { type SealedFile, decryptToBlobUrl, encryptAndUploadRef, parseEncAttachment, sealFileForUpload, uploadSealedRef } from './attachments';
import { prepareImageForUpload } from './imagePrep';
import { bytesFromB64, bytesToB64, parkedHref, parseParkedRef } from './parkedMedia';
import { deleteFiles } from './listContent';

/** The mime a drawing's editable strokes are uploaded under (next to its PNG). */
export const DRAWING_STROKES_MIME = 'application/x-puca-drawing';

/** A drawing ready to upload: the picture and its strokes (JSON text). */
export interface DrawingFiles {
    png: Blob;
    strokes: string;
}

export class TooManyAttachmentsError extends Error {
    constructor() {
        super(`A note holds at most ${MAX_TASK_ATTACHMENTS} photos and drawings (a drawing counts twice)`);
        this.name = 'TooManyAttachmentsError';
    }
}

/** How many sidecar slots adding these would take. */
export function slotsNeeded(files: number, drawings: number): number {
    return files + drawings * 2;
}

/** The longest display name a sidecar ref may carry. Twelve of these still
 *  leave room inside the 16 KiB sealed envelope. */
export const MAX_ATTACHMENT_NAME_LEN = 120;

/** `name`, short enough for the sidecar, keeping the extension — which is
 *  what tells a download what it is. */
export function clampAttachmentName(name: string): string {
    if (name.length <= MAX_ATTACHMENT_NAME_LEN) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    return `${name.slice(0, MAX_ATTACHMENT_NAME_LEN - ext.length - 1)}…${ext}`;
}

async function uploadAll(files: File[]): Promise<TaskAttachmentRef[]> {
    const done: TaskAttachmentRef[] = [];
    try {
        for (const f of files) {
            const r = await encryptAndUploadRef(f);
            done.push({ href: r.href, name: clampAttachmentName(r.name) });
        }
        return done;
    } catch (err) {
        await deleteFiles(done.map(r => parseEncAttachment(r.href)?.id).filter((x): x is string => !!x));
        throw err;
    }
}

/** Photos ready to encrypt (shrunk; only images go through the decoder) plus
 *  each drawing's PNG and strokes file. */
async function filesForUpload(photos: File[], drawings: { files: DrawingFiles; base: string }[]): Promise<File[]> {
    // A non-image (a PDF, a spreadsheet) is not shrinkable and pulling it
    // through createImageBitmap only stalls a phone on a 25 MB file.
    const prepared = await Promise.all(photos.map(f => (f.type.startsWith('image/') ? prepareImageForUpload(f) : Promise.resolve(f))));
    const files: File[] = [...prepared];
    for (const d of drawings) {
        files.push(new File([d.files.png], `${d.base}.png`, { type: 'image/png' }));
        files.push(new File([d.files.strokes], `${d.base}.json`, { type: DRAWING_STROKES_MIME }));
    }
    return files;
}

/** Upload photos and files (photos shrunk first) and drawings; `base(i)` names drawing i
 *  (`drawing-<n>`, see notes/model/noteContent.ts). Throws — with nothing
 *  left behind — on any failure, including a sidecar that would overflow. */
export async function uploadNoteMedia(
    photos: File[],
    drawings: { files: DrawingFiles; base: string }[],
    existing: number,
): Promise<TaskAttachmentRef[]> {
    if (existing + slotsNeeded(photos.length, drawings.length) > MAX_TASK_ATTACHMENTS) throw new TooManyAttachmentsError();
    return uploadAll(await filesForUpload(photos, drawings));
}

// --- Media sealed on this device and not yet uploaded ------------------------------------

/** One parked item: the ciphertext (base64), the key that opens it, and the
 *  ref the note shows while it waits (api/parkedMedia.ts). */
export interface SealedMedia {
    id: string;
    name: string;
    mime: string;
    /** The AES key, base64url — becomes the ref's `k=` once uploaded. */
    key: string;
    /** nonce || ciphertext, base64. */
    data: string;
    /** Ciphertext bytes, for the on-device cap. */
    bytes: number;
}

let parkSeq = 0;
function parkedId(): string {
    return `${Date.now().toString(36)}-${(parkSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Shrink (photos only), encrypt, and hand back the parked records — no
 * network. The plaintext file is not kept: only its ciphertext is, so a
 * photo taken offline is sealed before it is ever written to the device.
 */
export async function sealNoteMedia(
    photos: File[],
    drawings: { files: DrawingFiles; base: string }[],
    existing: number,
): Promise<SealedMedia[]> {
    if (existing + slotsNeeded(photos.length, drawings.length) > MAX_TASK_ATTACHMENTS) throw new TooManyAttachmentsError();
    const files = await filesForUpload(photos, drawings);
    const out: SealedMedia[] = [];
    for (const f of files) {
        const sealed: SealedFile = await sealFileForUpload(f);
        const bytes = new Uint8Array(await sealed.blob.arrayBuffer());
        out.push({ id: parkedId(), name: clampAttachmentName(sealed.name), mime: sealed.mime, key: sealed.key, data: bytesToB64(bytes), bytes: bytes.length });
    }
    return out;
}

/** The ref a parked record shows as until it is uploaded. */
export function refOfParked(rec: SealedMedia): TaskAttachmentRef {
    return { href: parkedHref(rec.id, rec.mime), name: rec.name };
}

/**
 * Upload parked ciphertext, in order and one at a time (the server caps
 * concurrent uploads per IP — src/upload_handlers.rs). All-or-nothing, like
 * `uploadNoteMedia`: a failure deletes what already landed.
 */
export async function uploadParkedMedia(records: SealedMedia[]): Promise<TaskAttachmentRef[]> {
    const done: TaskAttachmentRef[] = [];
    try {
        for (const rec of records) {
            const r = await uploadSealedRef({
                key: rec.key,
                blob: new Blob([bytesFromB64(rec.data) as BlobPart], { type: 'application/octet-stream' }),
                mime: rec.mime,
                name: rec.name,
            });
            done.push({ href: r.href, name: clampAttachmentName(r.name) });
        }
        return done;
    } catch (err) {
        await deleteFiles(fileIdsOf(done));
        throw err;
    }
}

/** Decrypt a drawing's strokes file back to its JSON text. */
export async function readStrokes(ref: TaskAttachmentRef): Promise<string> {
    const p = parseEncAttachment(ref.href);
    if (!p) throw new Error('Not an attachment ref');
    const url = await decryptToBlobUrl(p.id, p.key, p.mime, p.cap);
    const resp = await fetch(url);
    return resp.text();
}

/** The uploaded file ids behind refs (for best-effort deletion). */
export function fileIdsOf(refs: TaskAttachmentRef[]): string[] {
    return refs.map(r => parseEncAttachment(r.href)?.id).filter((x): x is string => !!x);
}

// --- The gallery -------------------------------------------------------------------------

/** One entry of a note's gallery. A drawing is its PNG plus the strokes file
 *  that makes it editable again; the strokes file is never shown on its own. */
export interface GalleryItem {
    ref: TaskAttachmentRef;
    kind: 'image' | 'drawing' | 'file';
    /** Drawings: the strokes ref paired with this PNG. */
    strokes?: TaskAttachmentRef;
}

function baseName(name: string): string {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

function mimeOf(ref: TaskAttachmentRef): string {
    return parseEncAttachment(ref.href)?.mime ?? parseParkedRef(ref.href)?.mime ?? '';
}

/**
 * What a note's gallery shows, from its OPENED sidecar. Empty for none and
 * for a locked sidecar (the caller shows the lock). A drawing is paired by
 * file name: `drawing-<n>.png` with `drawing-<n>.json` of DRAWING_STROKES_MIME.
 */
export function galleryItems(opened: string | null | undefined): GalleryItem[] {
    if (!opened || isAttachmentsLocked(opened)) return [];
    const refs = parseTaskAttachments(opened);
    const strokesByBase = new Map<string, TaskAttachmentRef>();
    for (const r of refs) if (mimeOf(r) === DRAWING_STROKES_MIME) strokesByBase.set(baseName(r.name), r);
    const paired = new Set<string>();
    const out: GalleryItem[] = [];
    for (const r of refs) {
        const mime = mimeOf(r);
        if (mime === DRAWING_STROKES_MIME) continue;
        if (mime.startsWith('image/')) {
            const strokes = strokesByBase.get(baseName(r.name));
            if (strokes) {
                paired.add(strokes.href);
                out.push({ ref: r, kind: 'drawing', strokes });
            } else {
                out.push({ ref: r, kind: 'image' });
            }
        } else {
            out.push({ ref: r, kind: 'file' });
        }
    }
    // A strokes file whose PNG is gone is still listed, so it can be removed.
    for (const r of refs) {
        if (mimeOf(r) === DRAWING_STROKES_MIME && !paired.has(r.href)) out.push({ ref: r, kind: 'file' });
    }
    return out;
}

/** Every ref an item stands for (a drawing is two). */
export function refsOfItem(item: GalleryItem): TaskAttachmentRef[] {
    return item.strokes ? [item.ref, item.strokes] : [item.ref];
}

/** The sidecar without `item` (both halves of a drawing). */
export function withoutItem(refs: TaskAttachmentRef[], item: GalleryItem): TaskAttachmentRef[] {
    const drop = new Set(refsOfItem(item).map(r => r.href));
    return refs.filter(r => !drop.has(r.href));
}

/** The next free `drawing-<n>` base name in a sidecar. */
export function nextDrawingName(refs: TaskAttachmentRef[]): string {
    let n = 1;
    const taken = new Set(refs.map(r => baseName(r.name)));
    while (taken.has(`drawing-${n}`)) n++;
    return `drawing-${n}`;
}

/** The pictures a note's card leads with: photos and drawings, never files
 *  or strokes, at most `max`. */
export function heroItems(opened: string | null | undefined, max = 3): GalleryItem[] {
    return galleryItems(opened).filter(i => i.kind !== 'file').slice(0, max);
}
