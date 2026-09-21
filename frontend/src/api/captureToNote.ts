/**
 * "Save to Notes" — the join between a chat message and one of your own notes.
 *
 * A capture is a COPY, never an alias, and that is the whole point of this
 * file:
 *
 * - The TEXT loses every `sovereign-enc:` attachment ref. Those hrefs carry the
 *   per-file AES key AND the fetch capability (api/attachments.ts), so leaving
 *   one in a note's body would park a live key in a second place with a second
 *   lifetime. Clip refs lose their payload too (the packed manifest IS the clip
 *   key — docs/CLIPS.md), though the caller refuses clip posts outright.
 * - Each PICTURE is decrypted, encrypted again under a FRESH key and uploaded
 *   as this account's own file. Re-using the sender's ref would look identical
 *   and be wrong in four ways: the storage is billed to them, the file dies
 *   when they delete the message, deleting the note would destroy a file the
 *   message still names, and the note would depend on a capability minted for
 *   somebody else's upload.
 *
 * No React, no components/ imports, and nothing from notes/** — Notes is a
 * separate Vite entry, and a cross-entry import renames the index chunk.
 */
import { decryptToBlobUrl, isEncAttachment, parseEncAttachment } from './attachments';
import { deleteFiles } from './listContent';
import { uploadPreparedFiles } from './noteMedia';
import { type TaskAttachmentRef, MAX_TASK_ATTACHMENTS } from './tasks';

/** Longest title a captured note gets (notes/model/notesModel.ts's cap, kept
 *  here so this module imports nothing from the Notes entry). */
export const CAPTURE_TITLE_MAX = 100;

// Markdown image/link whose href is a sovereign-enc ref, with the optional
// leading `!`. `i` throughout: URL schemes are case-insensitive, and a
// case-sensitive matcher let `SOVEREIGN-ENC:` through carrying its key — the
// bug api/contextMenuUtils.ts already records on the clipboard path.
const ENC_MARKDOWN = /!?\[[^\]\n]*\]\(\s*sovereign-enc:[^)\s]*\s*\)/gi;
// Anything left that still names an attachment — a bare ref someone typed or a
// half-broken markdown link. Removed whole: the skeleton `sovereign-enc:<id>`
// stripAttachmentKeys leaves behind is right for the clipboard (it shows what
// was there) and wrong here, where it would sit in a note forever naming a file
// the note does not own.
const ENC_BARE = /sovereign-enc:[^\s)\]]*/gi;
const CLIP_REF = /sovereign-clip:v1\?[^\s)]*/gi;

/**
 * The text a captured message keeps: the prose, with every attachment ref
 * removed and every clip payload dropped. Blank lines left by a removed
 * picture collapse, so a message that was only a picture yields `''` and the
 * caller falls back to the file name.
 */
export function captureTextFromMessage(content: string): string {
    return content
        .replace(ENC_MARKDOWN, '')
        .replace(ENC_BARE, '')
        .replace(CLIP_REF, 'sovereign-clip:v1')
        .split('\n')
        .map(l => l.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** The attachment refs a message names, in order, deduped by href. */
export function attachmentRefsInMessage(content: string): TaskAttachmentRef[] {
    const out: TaskAttachmentRef[] = [];
    const seen = new Set<string>();
    for (const m of content.matchAll(/(!?)\[([^\]\n]*)\]\(\s*(sovereign-enc:[^)\s]*)\s*\)/gi)) {
        const href = m[3];
        if (!isEncAttachment(href) || seen.has(href)) continue;
        seen.add(href);
        out.push({ href, name: m[2] || 'attachment' });
    }
    return out;
}

/** The title a captured note gets: its first non-empty line, capped. */
export function captureTitle(text: string, fallback = 'Saved message'): string {
    const first = text.split('\n').map(l => l.trim()).find(l => l !== '');
    return (first ? first.replace(/\s+/g, ' ').slice(0, CAPTURE_TITLE_MAX) : fallback) || fallback;
}

/** Decrypt one attachment ref back to a plain File. */
async function decryptRefToFile(ref: TaskAttachmentRef): Promise<File> {
    const p = parseEncAttachment(ref.href);
    if (!p) throw new Error('That attachment can’t be read.');
    const url = await decryptToBlobUrl(p.id, p.key, p.mime, p.cap);
    const blob = await (await fetch(url)).blob();
    return new File([blob], ref.name || 'attachment', { type: p.mime });
}

/**
 * Decrypt these attachments and upload them again as MY files under FRESH
 * keys. Every returned ref names a different file id than its source —
 * asserted in tests/captureToNoteUpload.test.ts, because that assertion is the
 * only thing standing between this and a silent alias.
 *
 * All or nothing: one failure deletes the copies that already landed, so a
 * refused capture never leaves files counting against the quota that no note
 * names (api/noteMedia.ts's rule, reused rather than re-written).
 *
 * No `channelId` is passed: the copy belongs to the note, not to the
 * conversation the message was in. No re-shrink either — the sender already
 * prepared the picture, and a second pass would re-encode it for nothing.
 */
export async function copyRefsIntoMyNote(refs: TaskAttachmentRef[], existing = 0): Promise<TaskAttachmentRef[]> {
    if (existing + refs.length > MAX_TASK_ATTACHMENTS) {
        throw new Error(`A note holds at most ${MAX_TASK_ATTACHMENTS} pictures and files.`);
    }
    const files: File[] = [];
    for (const ref of refs) files.push(await decryptRefToFile(ref));
    return uploadPreparedFiles(files);
}

/** Best-effort cleanup of copies whose note then failed to save. */
export async function discardCopies(refs: TaskAttachmentRef[]): Promise<void> {
    await deleteFiles(refs.map(r => parseEncAttachment(r.href)?.id).filter((x): x is string => !!x));
}
