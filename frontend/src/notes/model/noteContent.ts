/**
 * Púca Notes — the pure side of a note's own text (`body`): its title when
 * the composer's is blank, the two conversions between a text note and a
 * checklist, and what a paste or a drop carries. (Its photos and drawings
 * are api/noteMedia.ts.) No network, no DOM; unit-tested
 * (src/tests/noteContent.test.ts).
 */
import {
    type NewTaskTiming, type Task, type TaskAttachmentRef, buildTaskTree, isAttachmentsLocked,
    parseTaskAttachments, type TaskNode,
} from '../../api/tasks';
import { isUndecryptable } from '../../api/decryptMarkers';
import { parseSchedule, parseSnooze, serializeSchedule } from '../../api/taskSchedule';
import { deriveQuickTitle, type NoteRef } from './notesModel';

/** An item's attachment refs when this device can read its sidecar, else
 *  none — a locked sidecar is ciphertext, not an empty list. */
export function readableAttachmentsOf(t: Task): TaskAttachmentRef[] {
    return t.attachments && !isAttachmentsLocked(t.attachments) ? parseTaskAttachments(t.attachments) : [];
}

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

// --- Putting items back ---------------------------------------------------------------

/** What `recreateSubtree` needs of the data layer. A structural type rather
 *  than NoteActions itself: this file is pure model code, so the tests hand
 *  it fakes and nothing here imports the query layer. */
export interface RecreateActions {
    addTask: (note: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming) => Promise<Task | null>;
    setAttachments: (note: NoteRef, task: Task, refs: TaskAttachmentRef[]) => Promise<void>;
    snoozeTask: (note: NoteRef, task: Task, until: number | null) => Promise<void>;
    /** Mark an item done exactly as it was — never the tick path, which
     *  ADVANCES a repeating series (api/taskCompletion.ts planToggle). */
    restoreCompleted: (note: NoteRef, task: Task) => Promise<void>;
}

export interface RecreateResult {
    /** The id each item came back as, by the id it had. */
    idMap: Map<number, number>;
    /** Items that did not come back (refused, or their parent did not). */
    missing: number;
    /** Items whose date & repeat or snooze this device cannot read, so they
     *  came back without it: sealing the failure marker back would write it
     *  over the ciphertext it stands in for. */
    unreadableTiming: number;
}

/**
 * Create these items again, parents before children, as close to what they
 * were as the wire allows: text, nesting, due time, date & repeat, snooze,
 * attachments and tick state. Used by the Undo of "Hide checkboxes" and by
 * the Undo of an item delete.
 *
 * What it deliberately does NOT do: it does not tick a completed item
 * through the normal path, because for a repeating to-do that MOVES the
 * series on to its next occurrence instead of marking it done — an item
 * brought back would come back at the wrong date. The schedule is restored
 * byte-for-byte (same uid, same doneThrough: this is a restore, not a copy)
 * and the completion goes as a plain timing patch.
 *
 * The items come back as NEW items: new ids, appended at the end of their
 * group, and in a shared note created by whoever pressed Undo. An item whose
 * parent is NOT in the snapshot (the root of a deleted subtree, which still
 * names the live item it hung under) goes back under that parent; only a
 * parent that WAS in the snapshot and did not come back takes its children
 * with it.
 *
 * Each tick is restored at the one moment that reproduces it. Completing an
 * item sweeps its subtree as it stands AT THAT MOMENT (src/task_handlers.rs,
 * the recursive UPDATE) and re-opening one un-completes every ancestor, so
 * "done parent, open child" — which a child added after the parent was
 * ticked really is — cannot be put back after the fact. So a tick waits
 * until every completed item below it exists (`doneClosure`) and goes before
 * the first open one is created.
 */
export async function recreateSubtree(
    actions: RecreateActions, note: NoteRef, snapshot: Task[],
): Promise<RecreateResult> {
    const out: RecreateResult = { idMap: new Map(), missing: 0, unreadableTiming: 0 };
    const inSnapshot = new Map(snapshot.map(t => [t.id, t]));
    const childrenOf = new Map<number, Task[]>();
    for (const t of snapshot) {
        if (t.parent_id === null || !inSnapshot.has(t.parent_id)) continue;
        const kids = childrenOf.get(t.parent_id);
        if (kids) kids.push(t); else childrenOf.set(t.parent_id, [t]);
    }
    /** The items that must ALREADY EXIST when this one's tick is restored:
     *  every descendant reachable through completed items only, which the
     *  server's sweep will tick along with it. Anything under an OPEN item
     *  must not exist yet, or the sweep would tick that too. */
    const doneClosure = (t: Task): Set<number> => {
        const ids = new Set<number>();
        const walk = (parent: Task) => {
            for (const c of childrenOf.get(parent.id) ?? []) {
                if (!c.is_completed) continue;
                ids.add(c.id);
                walk(c);
            }
        };
        walk(t);
        return ids;
    };
    // Ticks owed, outermost first (snapshot order is parents before children).
    const owed: Array<{ made: Task; waitingFor: Set<number> }> = [];
    /** Restore every tick that is not still waiting for `next` to exist —
     *  all of them once the snapshot is finished. */
    const settle = async (next?: Task) => {
        for (let i = 0; i < owed.length;) {
            if (next && owed[i].waitingFor.has(next.id)) { i++; continue; }
            const [p] = owed.splice(i, 1);
            await actions.restoreCompleted(note, p.made);
        }
    };
    for (const t of snapshot) {
        await settle(t);
        // Parents come first, so a missing mapping for a parent that WAS in
        // the snapshot means it never came back: its children go with it
        // rather than to the top level. A parent outside the snapshot is a
        // live item — the root of a deleted subtree hangs off one.
        const inSnap = t.parent_id !== null && inSnapshot.has(t.parent_id);
        const parent = t.parent_id === null
            ? undefined
            : (out.idMap.get(t.parent_id) ?? (inSnap ? undefined : t.parent_id));
        if (t.parent_id !== null && parent === undefined) { out.missing++; continue; }
        const sched = parseSchedule(t.schedule);
        let timing: NewTaskTiming | undefined;
        if (sched.state === 'ok') {
            try {
                timing = { dueAt: t.due_at, schedule: serializeSchedule(sched.schedule, sched.raw) };
            } catch {
                out.unreadableTiming++;
            }
        } else if (sched.state === 'readonly') {
            out.unreadableTiming++;
        }
        if (!timing && t.due_at) timing = { dueAt: t.due_at };
        const made = await actions.addTask(note, t.description, parent, timing);
        if (!made) { out.missing++; continue; }
        out.idMap.set(t.id, made.id);
        const refs = readableAttachmentsOf(t);
        if (refs.length > 0) await actions.setAttachments(note, made, refs);
        const snooze = parseSnooze(t.snooze);
        if (snooze) await actions.snoozeTask(note, made, Date.parse(snooze.until));
        else if (t.snooze && isUndecryptable(t.snooze)) out.unreadableTiming++;
        // Completing a parent sweeps its subtree, so only the top of each
        // completed branch is marked, and only once that branch exists.
        const parentDone = t.parent_id !== null && inSnapshot.get(t.parent_id)?.is_completed === true;
        if (t.is_completed && !parentDone) owed.push({ made, waitingFor: doneClosure(t) });
    }
    await settle();
    return out;
}
