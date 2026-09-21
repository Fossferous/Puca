/**
 * Uploading a note's own photos and drawings: shrink (photos), encrypt,
 * upload, and hand back the refs for the list's sealed sidecar
 * (api/listContent.ts). All-or-nothing per call: if one upload fails, the
 * ones that already landed are deleted again, so a failed save never leaves
 * files counting against the quota that no note names.
 */
import { type TaskAttachmentRef, MAX_TASK_ATTACHMENTS, isAttachmentsLocked, parseTaskAttachments } from './tasks';
import { decryptToBlobUrl, encryptAndUploadRef, parseEncAttachment } from './attachments';
import { prepareImageForUpload } from './imagePrep';
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

async function uploadAll(files: File[]): Promise<TaskAttachmentRef[]> {
    const done: TaskAttachmentRef[] = [];
    try {
        for (const f of files) {
            const r = await encryptAndUploadRef(f);
            done.push({ href: r.href, name: r.name });
        }
        return done;
    } catch (err) {
        await deleteFiles(done.map(r => parseEncAttachment(r.href)?.id).filter((x): x is string => !!x));
        throw err;
    }
}

/** Upload photos (shrunk first) and drawings; `base(i)` names drawing i
 *  (`drawing-<n>`, see notes/model/noteContent.ts). Throws — with nothing
 *  left behind — on any failure, including a sidecar that would overflow. */
export async function uploadNoteMedia(
    photos: File[],
    drawings: { files: DrawingFiles; base: string }[],
    existing: number,
): Promise<TaskAttachmentRef[]> {
    if (existing + slotsNeeded(photos.length, drawings.length) > MAX_TASK_ATTACHMENTS) throw new TooManyAttachmentsError();
    const prepared = await Promise.all(photos.map(prepareImageForUpload));
    const files: File[] = [...prepared];
    for (const d of drawings) {
        files.push(new File([d.files.png], `${d.base}.png`, { type: 'image/png' }));
        files.push(new File([d.files.strokes], `${d.base}.json`, { type: DRAWING_STROKES_MIME }));
    }
    return uploadAll(files);
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
    return parseEncAttachment(ref.href)?.mime ?? '';
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
/**
 * What saving a drawing does to a note's sidecar. A drawing is a PAIR — the
 * PNG everything shows and the strokes that make it editable — so REPLACING
 * one must drop both refs and delete both files; dropping only the picture
 * leaves the strokes on the server with nothing naming them. The new pair is
 * named against what is left, never against the pair being replaced, so the
 * name it frees is reused instead of climbing for ever.
 */
export function planDrawingReplace(refs: TaskAttachmentRef[], replacing?: GalleryItem): {
    kept: TaskAttachmentRef[];
    dropped: TaskAttachmentRef[];
    base: string;
} {
    const kept = replacing ? withoutItem(refs, replacing) : refs;
    return { kept, dropped: replacing ? refsOfItem(replacing) : [], base: nextDrawingName(kept) };
}

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
