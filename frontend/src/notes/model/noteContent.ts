/**
 * Púca Notes — the pure side of a note's own text (`body`): its title when
 * the composer's is blank, and the two conversions between a text note and a
 * checklist. (Its photos and drawings are api/noteMedia.ts.) No network, no
 * DOM; unit-tested (src/tests/noteContent.test.ts).
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
