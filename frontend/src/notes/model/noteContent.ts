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
import { asHeadingText, headingLabel, isHeadingTask, isHeadingText } from '../../api/taskHeading';
import { deriveQuickTitle, MAX_ITEM_LENGTH, type NoteRef } from './notesModel';

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
 *  note pasted as a Markdown list converts cleanly. A Markdown heading line
 *  ("## Setup", "# Setup") becomes a HEADING item (api/taskHeading.ts), kept
 *  in the one form a heading is stored in — which is also what "Hide
 *  checkboxes" writes a heading back out as, so the two undo each other. */
export function bodyToItems(body: string): string[] {
    return body
        .split(/\r?\n/)
        .map(l => {
            const t = l.trim();
            if (isHeadingText(t)) return asHeadingText(t);
            // A list marker (- * + • or a number "1." / "1)"), then a task
            // box: the item is what follows.
            return t.replace(/^(?:(?:[-*+•]|\d{1,3}[.)])\s+)?(?:\[[ xX]\]\s*)?/, '').trim();
        })
        .filter(l => l !== '');
}

// --- Checklists from elsewhere ------------------------------------------------------
//
// A step-by-step list written somewhere else — an assistant's answer, a web
// page, an email — shared into Notes or pasted into the composer. It used to
// arrive as ONE text note of raw Markdown (a share) or as items that kept
// their "1." and "**", their "## Setup" heading and their "Here's how:"
// intro (a paste). This reads it the way Notes itself writes a checklist
// out (noteText.ts noteToMarkdown: "# Title", then "- [ ] item", a section
// as "## Section"), plus the usual variants. Its sections become HEADING
// items (api/taskHeading.ts), not boxes to tick. It never saves anything:
// the composer opens on the result, and the note exists only once the user
// presses Done.

/** A list line: - * + • or "1." / "1)", then an optional task box; or a bare
 *  task box. [1] is the indent, [2] the item. */
const LIST_LINE = /^(\s*)(?:(?:[-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?|\[[ xX]\]\s+)(.*\S)\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
/** "Here's a checklist for X:" → "Checklist for X" — the lead-in is chat,
 *  not a title. */
const LEAD_IN = /^(?:(?:sure|okay|ok|of course)[,!.]?\s+)?(?:here(?:'|’)?s|here is|here are|below is|below are)\s+(?:a|an|the|your|some)\s+/i;

/** Inline Markdown an item does not need: emphasis, code ticks, strike-
 *  through, images (their alt text), links (kept as "text (url)"). Careful
 *  with the lone-mark forms, so "2 * 3" and snake_case survive. */
export function plainInline(s: string): string {
    return s
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g, (_m, t: string, u: string) => (t === u ? u : `${t} (${u})`))
        .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1$2')
        .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1$2')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

/** A title the composer can take out of one line: no heading marks, no
 *  chat lead-in, no trailing colon, capitalised. */
export function titleFromLine(s: string): string {
    const t = plainInline(s.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s#+\s*$/, ''))
        .replace(LEAD_IN, '').replace(/[:：]\s*$/, '').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** True for a Markdown list line ("- x", "1. x", "[ ] x"…). */
export function isListLine(line: string): boolean {
    return LIST_LINE.test(line);
}

/** A line that introduces what follows: it ends in a colon, or it is chat
 *  ("Here's a checklist for…"). */
const introduces = (line: string): boolean => /[:：]\s*$/.test(line.trim()) || LEAD_IN.test(line.trim());

/** A line of PROSE rather than a bare item: a sentence (it ends like one,
 *  and has at least three words). "Milk" is an item; "You're all set!" is
 *  prose. */
const isSentence = (line: string): boolean => {
    const t = line.trim();
    return /[.!?…]["'”’)\]]?$/.test(t) && t.split(/\s+/).length >= 3;
};

export interface ReadChecklist {
    /** The heading before the list, else the line that introduced it; null
     *  when there was neither. */
    title: string | null;
    items: string[];
}

/**
 * Read `text` AS A CHECKLIST — or null when it is not one, so prose stays
 * prose: it takes at least two Markdown list lines, and no more sentences
 * of prose around them than list lines.
 *
 * - The first heading before the list is the title; failing that, a line
 *   that introduced the list ("Here's a checklist for X:" → "Checklist for
 *   X", "Steps:" → "Steps").
 * - A heading after that, or a line ending in a colon inside the list, is a
 *   section and becomes a HEADING item ("## Setup", api/taskHeading.ts), so
 *   the grouping is not lost and it is not one more box to tick. One left
 *   with nothing under it at the end is dropped.
 * - A bare short line is an item ("Milk" in "Milk / - Bread"); a sentence
 *   is prose and is dropped ("That's it, you're done!").
 * - An indented line under an item, and a fenced code block under it (the
 *   command a step says to run), join that item.
 * - Nested items are flattened in order: the composer's list is flat.
 * - Inline Markdown is dropped (plainInline); [x] boxes arrive unticked.
 */
export function readChecklist(text: string): ReadChecklist | null {
    let title: string | null = null;
    let intro: string | null = null;
    const items: string[] = [];
    /** Parallel to `items`: true for a section, which nothing joins. */
    const section: boolean[] = [];
    let listLines = 0;
    let proseLines = 0;
    let inFence = false;
    const push = (item: string, isSection: boolean) => { if (item) { items.push(item); section.push(isSection); } };
    /** A section: its label, colon gone, as a heading item. */
    const pushSection = (label: string) => {
        const l = label.replace(/[:：]\s*$/, '').trim();
        if (l) push(asHeadingText(l), true);
    };
    const join = (extra: string) => {
        const last = items.length - 1;
        if (last >= 0 && !section[last] && extra) items[last] = `${items[last]} — ${extra}`;
    };
    for (const raw of text.split(/\r?\n/)) {
        if (FENCE.test(raw)) { inFence = !inFence; continue; }
        if (inFence) {
            // Code under a step belongs to that step; code before any step is
            // not part of the list.
            join(raw.trim());
            continue;
        }
        if (!raw.trim()) continue;
        const h = HEADING.exec(raw);
        if (h) {
            const t = plainInline(h[1]);
            if (!t) continue;
            if (items.length === 0 && title === null) title = titleFromLine(t);
            else pushSection(t);
            continue;
        }
        const m = LIST_LINE.exec(raw);
        if (m) {
            push(plainInline(m[2]), false);
            listLines++;
            continue;
        }
        if (items.length > 0 && /^\s{2,}\S/.test(raw)) {
            join(plainInline(raw));
            continue;
        }
        if (items.length === 0 && introduces(raw)) {
            if (intro === null) intro = titleFromLine(raw);
            continue;
        }
        if (isSentence(raw)) { proseLines++; continue; }
        if (introduces(raw)) { pushSection(plainInline(raw)); continue; }
        push(plainInline(raw), false);
    }
    if (listLines < 2 || listLines < proseLines) return null;
    // A section with nothing under it (the last thing in the text) is not
    // worth a box.
    while (section.length > 0 && section[section.length - 1]) { items.pop(); section.pop(); }
    return { title: title || intro || null, items };
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
 *  would have taken it had we not intercepted the paste. An ITEM, whatever
 *  the paste began with: "## Setup - a - b" would otherwise land as a
 *  heading (api/taskHeading.ts), which "Add as one item" did not offer. */
export function pasteAsOneLine(text: string): string {
    return headingLabel(text.replace(/\s+/g, ' ').trim());
}

/** The most items one share or one paste may fill in, wherever it lands.
 *  Each is one create (paced, PACE_MS apart), so a pasted document of a
 *  thousand lines would otherwise be a minute of requests. */
export const MAX_TAKEN_ITEMS = 200;

export interface PastedItems {
    /** One per item, in order: at most MAX_TAKEN_ITEMS, each cut to what
     *  the field it lands in accepts (MAX_ITEM_LENGTH). */
    items: string[];
    /** How many the paste held before the cap. */
    total: number;
    /** The checklist's own title, when it read as one (readChecklist). */
    title: string | null;
}

/**
 * What a paste into an item field becomes, or null when there is nothing to
 * ask about and the browser should paste it as usual (a single line).
 *
 * The one rule every paste path shares (the Notes composer, an open note,
 * Púca's Tasks view): a checklist from elsewhere reads as one — numbers,
 * "**" and the "Here's how:" intro gone, its title taken and its sections
 * kept as headings (readChecklist) — and anything else splits by line
 * (linesFromPaste, which keeps a "## " line as a heading too).
 * `checklistOnly` is for a TITLE field, where only a real checklist is
 * taken and any other text pastes as a title.
 *
 * NOT READ YET: the clipboard's HTML. A copy of a RENDERED checklist (an
 * assistant's answer selected on the page rather than taken with its Copy
 * button) carries no "#" or "- [ ]" in `text/plain`, so readChecklist
 * rightly says it is not one, and the title and every heading land as one
 * item per line. Its `text/html` still has the <h1>/<h2> and the <li>. The
 * place to read it is here, before `text`: every paste path (usePasteItems,
 * the Notes composer) comes through this one function.
 */
export function readPastedItems(text: string, opts: { checklistOnly?: boolean } = {}): PastedItems | null {
    const list = readChecklist(text);
    if (opts.checklistOnly && !list) return null;
    const lines = list?.items ?? linesFromPaste(text);
    if (lines.length < 2) return null;
    return {
        items: lines.slice(0, MAX_TAKEN_ITEMS).map(l => l.slice(0, MAX_ITEM_LENGTH)),
        total: lines.length,
        title: list?.title ?? null,
    };
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
 *  items, then completed), nested items indented two spaces per level. A
 *  heading is a "## " line where it stands among the open items — which is
 *  where TaskTree shows it, ticked by an older client or not — and "Show
 *  checkboxes" reads that line back as a heading (bodyToItems). */
export function itemsToBody(tasks: Task[]): string {
    const lines: string[] = [];
    const walk = (nodes: TaskNode[], depth: number, completed: boolean) => {
        for (const n of nodes) {
            const heading = isHeadingTask(n.task);
            if ((n.task.is_completed && !heading) !== completed && depth === 0) continue;
            lines.push(`${'  '.repeat(depth)}${heading ? asHeadingText(n.task.description) : n.task.description}`);
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
        // A heading is never done here, whatever an older client set.
        if (t.is_completed && !isHeadingTask(t)) out.completed++;
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
