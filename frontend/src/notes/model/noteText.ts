/**
 * Púca Notes — notes as text: copy-as-text, and the export the account menu
 * offers. Pure over the decrypted cards the grid already holds; nothing here
 * talks to the server, and the download is a Blob the browser saves.
 */
import { type Task, buildTaskTree, type TaskNode, isAttachmentsLocked, parseTaskAttachments } from '../../api/tasks';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type NoteCard } from './notesModel';
import { isMobile } from '../../api/platform';
import { type SaveResult } from '../../api/saveAttachment';
import { NOTES_FOLDER, deviceWriteFailedMessage, saveTextToDevice, timestampedName } from '../../api/saveToDevice';
import { scheduleForExport } from './notesTiming';
import { type NewTaskTiming } from '../../api/tasks';
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

/** The open (unchecked) items of a note as flat text lines — what "Make a
 *  copy" recreates. Nesting is not carried: a copy is a fresh list. */
export function openItemsOf(card: NoteCard): string[] {
    const out: string[] = [];
    const walk = (nodes: TaskNode[]) => {
        for (const n of nodes) {
            if (n.task.is_completed || isUndecryptable(n.task.description)) continue;
            out.push(n.task.description);
            walk(n.children);
        }
    };
    walk(buildTaskTree(card.tasks ?? []));
    return out;
}

/** The timing of each item openItemsOf returns, in the same order, for
 *  "Make a copy": a scheduled item keeps its schedule — under a NEW uid, as
 *  a copy is a new event, not the same one twice — and its next reminder; a plain
 *  item's due time is not copied, as before. A schedule this device cannot
 *  read is not copied. */
export function openItemTimingOf(card: NoteCard): (NewTaskTiming | undefined)[] {
    const out: (NewTaskTiming | undefined)[] = [];
    const walk = (nodes: TaskNode[]) => {
        for (const n of nodes) {
            if (n.task.is_completed || isUndecryptable(n.task.description)) continue;
            const p = parseSchedule(n.task.schedule);
            let schedule: string | null = null;
            if (p.state === 'ok') {
                try { schedule = serializeSchedule({ ...p.schedule, uid: newUid(), doneThrough: undefined }, p.raw); } catch { schedule = null; }
            }
            out.push(schedule ? { dueAt: n.task.due_at, schedule } : undefined);
            walk(n.children);
        }
    };
    walk(buildTaskTree(card.tasks ?? []));
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
