/**
 * A web address inside a checklist ITEM, in the OPEN NOTE.
 *
 * Púca Notes' editor hands TaskTree its own `renderDescription` so a search's
 * marks land inside item rows. TaskTree.describe PREFERS that renderer and
 * never reaches its own NoteLinkText — so a renderer that only highlighted
 * quietly took every link away in the editor, while the same item in Púca's
 * Tasks view (which passes no renderer) stayed a working link. Nothing was
 * red: the walk only taps links in the note's BODY, and
 * src/tests/taskTreeLinks.test.tsx mounts TaskTree with no renderDescription
 * at all — the one arrangement the editor never uses.
 *
 * So these mount the real NoteEditor, with and without a search, and demand
 * both halves at once. The positive controls are the other direction of the
 * same trap: marks must still appear (the composition must not lose the
 * highlight), and an item with no address must still be plain text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/openExternal', () => ({ openExternalUrl: vi.fn(), isExternalHref: () => true }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
const { shownTasks } = vi.hoisted(() => ({ shownTasks: { current: [] as unknown[] } }));
vi.mock('../notes/model/notesQueries', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesQueries')>();
    return { ...real, useNoteTasks: () => ({ data: shownTasks.current, isPending: false, isFetching: false }) };
});
vi.mock('../api/taskFeatures', async (orig) => ({
    ...(await orig<typeof import('../api/taskFeatures')>()), useTaskFeature: () => true,
}));

import { NoteEditor } from '../notes/components/NoteEditor';
import { openExternalUrl } from '../api/openExternal';
import { type Task } from '../api/tasks';
import { type NoteCard } from '../notes/model/notesModel';
import { type NoteActions } from '../notes/model/notesQueries';

function task(id: number, description: string): Task {
    return {
        id, channel_id: null, list_id: 5, parent_id: null, description, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null,
    };
}

const card = {
    ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Trip', body: null, noteAttachments: null,
    tasks: [], pinned: false, color: 'default', labels: [], archived: false, total: 1, completed: 0,
} as unknown as NoteCard;

const actions = {
    content: {
        features: { body: true, attachments: false, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 },
        setBody: vi.fn(async () => true),
    },
    deleteTaskFrom: vi.fn(), addTask: vi.fn(), setAttachments: vi.fn(), snoozeTask: vi.fn(),
    restoreCompleted: vi.fn(), toggleTask: vi.fn(), editTask: vi.fn(), moveTaskIn: vi.fn(),
    reorderTaskIn: vi.fn(), setDue: vi.fn(), setSchedule: vi.fn(), togglePin: vi.fn(),
    refreshNote: vi.fn(), renameNote: vi.fn(),
} as unknown as NoteActions;

let root: Root;
let container: HTMLDivElement;
const noop = () => { /* the editor's chrome is not under test */ };

function render(tasks: Task[], query?: string) {
    shownTasks.current = tasks;
    act(() => {
        root.render(
            <NoteEditor
                card={card} actions={actions} onClose={noop} onMenu={noop} onPickColor={noop}
                onPickLabels={noop} onArchive={noop} onSendToPuca={noop} pucaHref={null} query={query}
            />,
        );
    });
}

/** Anchors inside item rows only — the note's BODY has links of its own, and
 *  those were never broken (NoteBodyField renders them itself). */
const itemLinks = () => [...document.querySelectorAll('.tt-description a.note-link')] as HTMLAnchorElement[];
const itemMarks = () => [...document.querySelectorAll('.tt-description mark.notes-hl')].map(m => m.textContent);

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

describe('a link inside an item of the open note', () => {
    it('is a real anchor, not bare text', () => {
        render([task(1, 'book https://example.com/ferry today')]);
        const links = itemLinks();
        expect(links.length).toBe(1);
        expect(links[0].getAttribute('href')).toBe('https://example.com/ferry');
        expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('opens through the shell when it is tapped, and does not start an edit', () => {
        render([task(1, 'book https://example.com/ferry today')]);
        act(() => { itemLinks()[0].click(); });
        expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/ferry');
        // The row's own click handler starts an inline edit; the link's
        // stopPropagation is what keeps the tap from wiping the row.
        expect(document.querySelector('.tt-description input')).toBeNull();
    });

    it('keeps BOTH the link and the search marks while a search is on', () => {
        render([task(1, 'book https://example.com/ferry today')], 'book today');
        expect(itemLinks().length).toBe(1);
        expect(itemMarks()).toEqual(['book', 'today']);
    });

    it('POSITIVE CONTROL: the marks are the editor\'s own, and appear with no link in sight', () => {
        render([task(1, 'book the ferry today')], 'ferry');
        expect(itemLinks()).toEqual([]);
        expect(itemMarks()).toEqual(['ferry']);
    });

    it('POSITIVE CONTROL: an item with no address is plain text, marked or not', () => {
        render([task(1, 'book the ferry today')]);
        expect(itemLinks()).toEqual([]);
        expect(itemMarks()).toEqual([]);
        expect(document.querySelector('.tt-description')?.textContent).toBe('book the ferry today');
    });
});
