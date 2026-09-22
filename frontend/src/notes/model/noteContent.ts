/**
 * Púca Notes — the pure side of a note's own text (`body`): its title when
 * the composer's is blank, the two conversions between a text note and a
 * checklist, and what a paste or a drop carries. (Its photos and drawings
 * are api/noteMedia.ts.) No network, no DOM; unit-tested
 * (src/tests/noteContent.test.ts).
 */
import { type Task, buildTaskTree, type TaskNode } from '../../api/tasks';
import { isUndecryptable } from '../../api/decryptMarkers';
import { deriveQuickTitle } from './notesModel';

/** Readable note text, or '' for none / a decrypt-failure marker. */
export function readableBody(body: string | null | undefined): string {
    if (!body || isUndecryptable(body)) return '';
    return body;
}

/** The title a new note gets when the composer's title is blank: its first
 *  line of text, else its first item, else what it is. */
export function deriveContentTitle(
    title: string,
    content: { body?: string; items?: string[]; images?: number; drawing?: boolean; audio?: number; fileNames?: string[] },
): string {
    if (title.replace(/\s+/g, ' ').trim()) return deriveQuickTitle(title, []);
    const firstLine = (content.body ?? '').split('\n').map(l => l.trim()).find(l => l !== '');
    if (firstLine) return deriveQuickTitle('', [firstLine]);
    if (content.items && content.items.some(i => i.trim())) return deriveQuickTitle('', content.items);
    if (content.drawing) return 'Drawing';
    if ((content.audio ?? 0) > 0) return 'Voice note';
    if ((content.images ?? 0) > 0) return 'Photo';
    // A note that is nothing but an attached file is named after it, without
    // the extension — "Untitled note" for a note called tickets.pdf helps
    // nobody find it again.
    const first = (content.fileNames ?? []).map(n => n.trim()).find(n => n !== '');
    if (first) return deriveQuickTitle('', [first.replace(/\.[^./\\]+$/, '') || first]);
    return 'Untitled note';
}

// --- Text note ⇄ checklist ------------------------------------------------------------

/** "Show checkboxes": one item per non-blank line of the text, with a
 *  leading bullet or checkbox (`- `, `* `, `• `, `[ ]`, `[x]`) dropped — so a
 *  note pasted as a Markdown list converts cleanly. */
export function bodyToItems(body: string): string[] {
    return body
        .split(/\r?\n/)
        .map(l => l.trim().replace(/^(?:[-*•]\s+)?(?:\[[ xX]\]\s*)?/, '').trim())
        .filter(l => l !== '');
}

// --- Paste and drop ------------------------------------------------------------------

/** The items a multi-line paste would become — the SAME splitter "Show
 *  checkboxes" uses, so a list copied out of anywhere lands the same way
 *  wherever it is pasted. One line in gives exactly one line out, which is
 *  what tells the paste handlers there is nothing to ask about. */
export function linesFromPaste(text: string): string[] {
    return bodyToItems(text);
}

/** A multi-line paste kept as ONE item: a single line, the way an `<input>`
 *  would have taken it had we not intercepted the paste. */
export function pasteAsOneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** The minimum of a `DataTransfer` this module reads: a clipboard paste and
 *  an OS drop both satisfy it, and a test can hand-build one. A drop has no
 *  `getData` worth reading; a paste does. */
export interface TransferLike {
    files?: ArrayLike<File> | null;
    items?: ArrayLike<DataTransferItem> | null;
    getData?: (format: string) => string;
}

/** True when this paste is TEXT that merely carries a picture alongside it.
 *
 *  Chromium puts an `image/png` on the clipboard NEXT TO the text whenever
 *  rich content is copied — a Word paragraph, a range of Excel cells, a
 *  selection of a web page — so "the clipboard holds an image" is not "a
 *  picture was copied", and a picture handler that only asks the first
 *  question turns a pasted table into a screenshot of a table. A real
 *  screenshot, or "Copy image", carries no text at all, which is what tells
 *  the two apart. Drops are unaffected: an OS drop of files has no text.
 *
 *  (Púca's chat composer, Chat.tsx, takes the images-first branch on purpose
 *  — an image pasted there IS the message. A note's text is not.) */
export function isTextPaste(dt: TransferLike | null | undefined): boolean {
    if (!dt || typeof dt.getData !== 'function') return false;
    return (dt.getData('text/plain') || '').trim() !== '';
}

/** The files carried by a paste or a drop, split into pictures and the rest.
 *  Nothing (or no transfer at all) gives two empty arrays. */
export function filesFromTransfer(dt: TransferLike | null | undefined): { images: File[]; others: File[] } {
    const images: File[] = [];
    const others: File[] = [];
    if (!dt) return { images, others };
    // `files` is what a drop and a modern paste both fill. Some webviews
    // leave it empty for a pasted image and fill only `items`, so that is the
    // fallback — never both, or one screenshot would land twice.
    let files = dt.files && dt.files.length > 0 ? Array.from(dt.files) : [];
    if (files.length === 0 && dt.items) {
        files = Array.from(dt.items)
            .filter(i => i.kind === 'file')
            .map(i => i.getAsFile())
            .filter((f): f is File => f !== null);
    }
    for (const f of files) {
        if (f.type.startsWith('image/')) images.push(f);
        else others.push(f);
    }
    return { images, others };
}

/** "Hide checkboxes": every item as a line, in the editor's order (open
 *  items, then completed), nested items indented two spaces per level. */
export function itemsToBody(tasks: Task[]): string {
    const lines: string[] = [];
    const walk = (nodes: TaskNode[], depth: number, completed: boolean) => {
        for (const n of nodes) {
            if (n.task.is_completed !== completed && depth === 0) continue;
            lines.push(`${'  '.repeat(depth)}${n.task.description}`);
            walk(n.children, depth + 1, completed);
        }
    };
    const tree = buildTaskTree(tasks);
    walk(tree, 0, false);
    walk(tree, 0, true);
    return lines.join('\n');
}

/** What "Hide checkboxes" would throw away. `unreadable` items block the
 *  conversion outright: deleting them would delete ciphertext this device
 *  cannot even show. */
export interface ConversionLosses {
    nested: boolean;
    due: number;
    attachments: number;
    completed: number;
    unreadable: number;
}

export function conversionLosses(tasks: Task[]): ConversionLosses {
    const out: ConversionLosses = { nested: false, due: 0, attachments: 0, completed: 0, unreadable: 0 };
    for (const t of tasks) {
        if (t.parent_id !== null) out.nested = true;
        if (t.due_at) out.due++;
        if (t.attachments) out.attachments++;
        if (t.is_completed) out.completed++;
        if (isUndecryptable(t.description)) out.unreadable++;
    }
    return out;
}

/** The confirmation text for a lossy "Hide checkboxes", or null when nothing
 *  is lost (a flat list of open, plain items converts without asking). */
export function describeLosses(l: ConversionLosses): string | null {
    const parts: string[] = [];
    if (l.nested) parts.push('nesting');
    if (l.due > 0) parts.push(`${l.due} due time${l.due === 1 ? '' : 's'}`);
    if (l.attachments > 0) parts.push(`the attachments on ${l.attachments} item${l.attachments === 1 ? '' : 's'}`);
    if (l.completed > 0) parts.push(`which ${l.completed === 1 ? 'item is' : `${l.completed} items are`} done`);
    if (parts.length === 0) return null;
    const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `Turning this list into text drops ${list}. Undo brings the items back.`;
}

/** Items in an order they can be re-created in (every parent before its
 *  children), for Undo after "Hide checkboxes". */
export function recreationOrder(tasks: Task[]): Task[] {
    const out: Task[] = [];
    const walk = (nodes: TaskNode[]) => {
        for (const n of nodes) {
            out.push(n.task);
            walk(n.children);
        }
    };
    walk(buildTaskTree(tasks));
    return out;
}
