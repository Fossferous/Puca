/**
 * Pending composer attachments — the model behind the chip strip.
 *
 * An attachment being uploaded used to BE markdown text inside the composer's
 * value: `![name](sovereign-enc:id?k=KEY)` appended straight into the
 * textarea. That showed the user a wall of tokens instead of their image, put
 * the file's AES key on screen (and in the textarea's undo/clipboard buffer —
 * the same leak class stripAttachmentKeys exists for), and let a half-typed
 * message be sent with a half-uploaded file.
 *
 * Now the composer keeps a list of these records; the markdown is built ONLY
 * at send time by buildOutgoingContent. Everything here is pure so it can be
 * table-tested; object-URL lifecycle (create/revoke) belongs to the caller.
 */

export interface PendingAttachment {
    /** Local identity for reducer updates; never leaves the client. */
    localId: string;
    name: string;
    mime: string;
    status: 'uploading' | 'ready' | 'failed';
    /** The sovereign-enc ref, present once 'ready'. */
    href?: string;
    /** Object URL for an IMAGE thumbnail, or null for every other type (a
     *  video blob in the chip's <img> paints an empty square — non-images get
     *  the file icon instead). Created and revoked by the caller. */
    previewUrl: string | null;
    spoiler: boolean;
    /** Why it failed, for the chip's tooltip. */
    error?: string;
}

let nextLocalId = 1;

/** A fresh 'uploading' chip. */
export function pendingAttachment(
    file: { name?: string; type?: string },
    previewUrl: string | null,
    spoiler = false,
): PendingAttachment {
    return {
        localId: `att_${nextLocalId++}`,
        name: file.name || 'attachment',
        mime: file.type || 'application/octet-stream',
        status: 'uploading',
        previewUrl,
        spoiler,
    };
}

/** Back to 'uploading' (a retry); clears the old error. */
export function markUploading(list: PendingAttachment[], localId: string): PendingAttachment[] {
    return list.map(a => (a.localId === localId ? { ...a, status: 'uploading' as const, error: undefined } : a));
}

export function markReady(list: PendingAttachment[], localId: string, href: string): PendingAttachment[] {
    return list.map(a => (a.localId === localId ? { ...a, status: 'ready' as const, href } : a));
}

export function markFailed(list: PendingAttachment[], localId: string, error: string): PendingAttachment[] {
    return list.map(a => (a.localId === localId ? { ...a, status: 'failed' as const, error } : a));
}

export function toggleSpoiler(list: PendingAttachment[], localId: string): PendingAttachment[] {
    return list.map(a => (a.localId === localId ? { ...a, spoiler: !a.spoiler } : a));
}

export function removeAttachment(list: PendingAttachment[], localId: string): PendingAttachment[] {
    return list.filter(a => a.localId !== localId);
}

/** Markdown for the READY chips only — image syntax for images, link syntax
 *  otherwise, spoiler-wrapped when marked. '' when none are ready.
 *
 *  The LABEL is stripped of markdown-breaking characters, exactly like
 *  attachments.ts does for the direct-markdown path. This is load-bearing,
 *  not cosmetic: the message parser's label class excludes ']' and newline,
 *  so a filename like `Screenshot [1].png` emitted raw fails to parse — the
 *  attachment renders as literal text (key-bearing href on screen, file
 *  unreachable) — and a crafted name like `x](https://evil/a.png) y.png`
 *  would smuggle a REAL image link that leaks every reader's IP on render.
 *  The chip UI keeps showing the true name; only the wire form is stripped. */
export function serializeAttachments(list: PendingAttachment[]): string {
    return list
        .filter(a => a.status === 'ready' && a.href)
        .map(a => {
            const label = a.name.replace(/[[\]()\n]/g, '_');
            const md = `${a.mime.startsWith('image/') ? '!' : ''}[${label}](${a.href})`;
            return a.spoiler ? `||${md}||` : md;
        })
        .join(' ');
}

/** The outgoing message: typed text plus the ready attachments' markdown. */
export function buildOutgoingContent(input: string, list: PendingAttachment[]): string {
    const text = input.trim();
    const atts = serializeAttachments(list);
    if (!atts) return text;
    return text ? `${text} ${atts}` : atts;
}

/**
 * May the composer send right now?
 *  - something must exist to send: nonempty text or at least one READY chip
 *    (failed chips are never serialized, so they alone cannot justify a send);
 *  - never while any upload is still in flight — sending would silently drop
 *    the file the user just attached.
 */
export function canSendComposer(input: string, list: PendingAttachment[]): boolean {
    if (list.some(a => a.status === 'uploading')) return false;
    return input.trim().length > 0 || list.some(a => a.status === 'ready');
}
