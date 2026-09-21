/**
 * Púca Notes — notes as text: copy-as-text, and the export the account menu
 * offers. Pure over the decrypted cards the grid already holds; nothing here
 * talks to the server, and the download is a Blob the browser saves.
 */
import { type Task, type TaskAttachmentRef, buildTaskTree, type TaskNode, isAttachmentsLocked, parseTaskAttachments } from '../../api/tasks';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type NoteCard } from './notesModel';
import { isMobile } from '../../api/platform';
import { type SaveResult } from '../../api/saveAttachment';
import { NOTES_FOLDER, deviceWriteFailedMessage, saveTextToDevice, timestampedName } from '../../api/saveToDevice';
import { scheduleForExport } from './notesTiming';
import { readableBody } from './noteContent';
import { newUid, parseSchedule, serializeSchedule } from '../../api/taskSchedule';
import { describeSchedule } from '../../api/scheduleFormat';

function lines(nodes: TaskNode[], depth: number, out: string[]): void {
    for (const n of nodes) {
        const box = n.task.is_completed ? '[x]' : '[ ]';
        const sched = parseSchedule(n.task.schedule);
        const due = sched.state === 'ok'
            ? (() => { const d = describeSchedule(sched.schedule, Date.now()); return `  (${d.when}${d.repeat ? `, ${d.repeat}` : ''}${sched.schedule.location ? `, at ${sched.schedule.location}` : ''})`; })()
            : n.task.due_at ? `  (due ${n.task.due_at})` : '';
        out.push(`${'  '.repeat(depth)}- ${box} ${n.task.description}${due}`);
        const refs = parseTaskAttachments(n.task.attachments);
        for (const r of refs) out.push(`${'  '.repeat(depth + 1)}- attachment: ${r.name}`);
        lines(n.children, depth + 1, out);
    }
}

/** One note as a Markdown checklist. Undecryptable rows are written as their
 *  marker — the export must not pretend to know text it cannot read. */
export function noteToMarkdown(card: NoteCard): string {
    const out: string[] = [`# ${card.title}`];
    const meta: string[] = [];
    if (card.serverName) meta.push(`shared in ${card.serverName}`);
    if (card.pinned) meta.push('pinned');
    if (card.archived) meta.push('archived');
    if (card.labels.length) meta.push(`labels: ${card.labels.join(', ')}`);
    if (meta.length) out.push(`_${meta.join(' · ')}_`);
    out.push('');
    // The note's own text and pictures (a marker is written as itself, as
    // an unreadable item is — the export does not pretend to know it).
    if (card.body) out.push(card.body, '');
    for (const r of parseTaskAttachments(isAttachmentsLocked(card.noteAttachments ?? null) ? null : card.noteAttachments ?? null)) out.push(`- attachment: ${r.name}`);
    if (card.tasks === null) {
        out.push('_(items not loaded)_');
    } else if (card.tasks.length === 0) {
        if (!card.body && !card.noteAttachments) out.push('_(empty)_');
    } else {
        lines(buildTaskTree(card.tasks), 0, out);
    }
    return out.join('\n') + '\n';
}

export function notesToMarkdown(cards: NoteCard[]): string {
    return cards.map(noteToMarkdown).join('\n');
}

/** Machine-readable export: the decrypted fields, nothing sealed. */
export function notesToJson(cards: NoteCard[], exportedAt: string): string {
    const notes = cards.map(c => ({
        key: c.key,
        kind: c.ref.kind,
        id: c.ref.id,
        title: c.title,
        server: c.serverName ?? null,
        pinned: c.pinned,
        archived: c.archived,
        color: c.color,
        labels: c.labels,
        createdAt: c.createdAt ?? null,
        text: c.body ?? null,
        textUnreadable: !!c.body && isUndecryptable(c.body),
        pictures: parseTaskAttachments(isAttachmentsLocked(c.noteAttachments ?? null) ? null : c.noteAttachments ?? null).map(r => r.name),
        items: (c.tasks ?? []).map((t: Task) => ({
            id: t.id,
            parentId: t.parent_id,
            text: t.description,
            unreadable: isUndecryptable(t.description),
            completed: t.is_completed,
            position: t.position,
            dueAt: t.due_at,
            schedule: scheduleForExport(t),
            updatedAt: t.updated_at ?? null,
            createdAt: t.created_at,
            attachments: parseTaskAttachments(t.attachments).map(r => r.name),
        })),
    }));
    return JSON.stringify({ app: 'Púca Notes', exportedAt, notes }, null, 2) + '\n';
}

// --- Make a copy ------------------------------------------------------------------------
//
// A copy is the whole note again: its text, its pictures and drawings, and
// every item — ticked or not — with its nesting, its due time and its date
// & repeat. Two rules keep it honest:
//
//  - The schedule is re-sealed under a NEW uid with `doneThrough` cleared: a
//    copy is a new series, not the same event twice.
//  - Pictures are RE-ENCRYPTED for the copy rather than re-pointed (that is
//    createNoteFromPlan's job, not this file's). Copying the source's href
//    would put two notes' names on one upload, which is exactly the hazard
//    docs/SECURITY_MODEL.md describes: *Delete forever* on either note would
//    delete files the other still shows.
//
// A note holding something this device cannot read is not copied at all,
// rather than copied with the unreadable part quietly missing — the same
// choice "Hide checkboxes" makes.

export interface CopyItem {
    text: string;
    completed: boolean;
    dueAt: string | null;
    /** A re-sealed schedule (new uid, no progress), or null. */
    schedule: string | null;
    attachments: TaskAttachmentRef[];
    children: CopyItem[];
}

export interface CopyPlan {
    title: string;
    body: string;
    /** The note's OWN sidecar, as the source holds it (to be re-encrypted). */
    noteRefs: TaskAttachmentRef[];
    items: CopyItem[];
    /** Uploads the copy must encrypt again; a drawing is two of them. */
    files: number;
}

export interface CopyBlockers {
    /** The items query has not resolved: copying now would make an EMPTY note
     *  and report success. */
    itemsNotLoaded: boolean;
    unreadableItems: number;
    unreadableSchedules: number;
    unreadableBody: boolean;
    lockedSidecar: boolean;
}

export function copyBlockersOf(card: NoteCard): CopyBlockers {
    const out: CopyBlockers = {
        itemsNotLoaded: card.tasks === null,
        unreadableItems: 0,
        unreadableSchedules: 0,
        unreadableBody: !!card.body && isUndecryptable(card.body),
        lockedSidecar: isAttachmentsLocked(card.noteAttachments ?? null),
    };
    for (const t of card.tasks ?? []) {
        if (isUndecryptable(t.description)) out.unreadableItems++;
        if (parseSchedule(t.schedule).state === 'readonly') out.unreadableSchedules++;
        if (isAttachmentsLocked(t.attachments)) out.lockedSidecar = true;
    }
    return out;
}

/** The one thing to say when a note cannot be copied here, or null when it
 *  can. The wording matches the "Hide checkboxes" refusal. */
export function copyRefusal(b: CopyBlockers): string | null {
    if (b.itemsNotLoaded) return 'Still opening this note — try the copy again in a moment';
    if (b.unreadableItems > 0 || b.unreadableSchedules > 0 || b.unreadableBody || b.lockedSidecar) {
        return 'Some of this note can’t be read on this device, so it can’t be copied here';
    }
    return null;
}

/**
 * What to make. Only valid once `copyRefusal(copyBlockersOf(card))` is null;
 * `schedules` is false against a server that does not store them (it would
 * drop the field silently), and then only the due time is carried.
 */
export function copyPlanOf(card: NoteCard, opts: { schedules?: boolean } = {}): CopyPlan {
    const schedules = opts.schedules !== false;
    let files = 0;
    const refsOf = (attachments: string | null): TaskAttachmentRef[] => {
        const refs = isAttachmentsLocked(attachments) ? [] : parseTaskAttachments(attachments);
        files += refs.length;
        return refs;
    };
    const walk = (nodes: TaskNode[]): CopyItem[] => nodes.map(n => {
        const p = parseSchedule(n.task.schedule);
        let schedule: string | null = null;
        if (schedules && p.state === 'ok') {
            try {
                schedule = serializeSchedule({ ...p.schedule, uid: newUid(), doneThrough: undefined }, p.raw);
            } catch {
                schedule = null;
            }
        }
        return {
            text: n.task.description,
            completed: n.task.is_completed,
            dueAt: n.task.due_at,
            schedule,
            attachments: refsOf(n.task.attachments),
            children: walk(n.children),
        };
    });
    const noteRefs = refsOf(card.noteAttachments ?? null);
    const items = walk(buildTaskTree(card.tasks ?? []));
    return { title: `${card.title} (copy)`, body: readableBody(card.body), noteRefs, items, files };
}

/** Every item of a plan, parents before children. */
export function flattenCopyItems(items: CopyItem[]): Array<{ item: CopyItem; parent: CopyItem | null }> {
    const out: Array<{ item: CopyItem; parent: CopyItem | null }> = [];
    const walk = (list: CopyItem[], parent: CopyItem | null) => {
        for (const item of list) {
            out.push({ item, parent });
            walk(item.children, item);
        }
    };
    walk(items, null);
    return out;
}

/** YYYY-MM-DD for file names, in local time. */
export function fileStamp(now: number): string {
    const d = new Date(now);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Save an export where this platform keeps files. In the Android app that is
 * Documents/Puca Notes/<name-with-timestamp> through the filesystem plugin
 * (a WebView ignores the download attribute — the anchor would write
 * nothing); it throws with a real reason when the write fails. In a browser
 * it is the download below. Either way the file is PLAINTEXT, and the caller
 * says so.
 */
export async function saveNotesExport(name: string, text: string, mime: string): Promise<SaveResult> {
    if (isMobile()) {
        try {
            // The timestamp carries the date: drop the name's own -YYYY-MM-DD.
            return await saveTextToDevice(NOTES_FOLDER, timestampedName(name.replace(/-\d{4}-\d{2}-\d{2}(?=\.[^.]+$)/, '')), text);
        } catch (e) {
            console.warn('[notes] export could not be written:', e);
            throw new Error(deviceWriteFailedMessage('Púca Notes', 'the export'));
        }
    }
    downloadTextFile(name, text, mime);
    return { where: name, onDisk: false };
}

/** Hand the browser a file to save. BROWSER only: the Android app's WebView
 *  ignores the download attribute — saveNotesExport routes around it. */
export function downloadTextFile(name: string, text: string, mime: string): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has been dispatched; some browsers read lazily.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
