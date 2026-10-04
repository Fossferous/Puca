/**
 * What a note's attachments are COUNTED as, on the three surfaces that sum a
 * note up instead of showing it: the All-tasks board's snippet
 * (listBodySnippet), a Púca Notes card's chip (NoteCard) and a trashed note's
 * line (TrashView).
 *
 * A voice note or any other audio file is its own gallery kind (`audio`, so
 * it gets a player), and each of the three counted by `kind === 'file'` or
 * `kind !== 'file'`. So a note holding only a song said nothing on the board,
 * read "Empty note" on its card, and was "1 picture" in the trash — the line
 * that says what Delete forever destroys. An audio file is a FILE in every
 * count, as it already is in the queued-op label (mediaCountLabel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({
    wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} },
}));

import { listBodySnippet } from '../components/useListContentSupport';
import { NoteCard } from '../notes/components/NoteCard';
import { TrashView } from '../notes/components/TrashView';
import { buildNoteCards } from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import type { NoteActions } from '../notes/model/notesQueries';
import { listContentKeys, type ListContentActions } from '../notes/model/useListContent';
import { DRAWING_STROKES_MIME, galleryItems } from '../api/noteMedia';

const enc = (id: string, mime: string, name: string) => ({ href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent(mime)}`, name });
const sidecar = (...refs: Array<{ href: string; name: string }>) => JSON.stringify(refs);

const VOICE_NOTE = enc('v', 'audio/webm;codecs=opus', 'voice-1.webm');
const OLD_SONG = enc('s', 'application/octet-stream', 'song.mp3');       // a ref from before types were recorded
const OPUS = enc('o', 'audio/ogg', 'take.opus');                           // what the upload side records now
const PHOTO = enc('p', 'image/png', 'photo.png');
const PDF = enc('d', 'application/pdf', 'tickets.pdf');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

it('control: each audio ref really is the `audio` kind, so these tests cover it', () => {
    expect(galleryItems(sidecar(VOICE_NOTE, OLD_SONG, OPUS, PHOTO, PDF)).map(i => i.kind))
        .toEqual(['audio', 'audio', 'audio', 'image', 'file']);
});

describe('the All-tasks board snippet', () => {
    const list = (attachments: string) => ({ id: 1, title: 't', created_at: '', total_tasks: 0, completed_tasks: 0, attachments });

    it.each([
        ['a voice note', VOICE_NOTE],
        ['an unlabelled .mp3', OLD_SONG],
        ['an .opus', OPUS],
    ])('counts %s as a file instead of saying nothing', (_what, ref) => {
        expect(listBodySnippet(list(sidecar(ref)))).toBe('1 file');
    });

    it('a picture is a picture and audio is a file, beside a PDF', () => {
        expect(listBodySnippet(list(sidecar(PHOTO, OLD_SONG, PDF)))).toBe('1 picture, 2 files');
    });

    it('control: a drawing is still a picture, and its strokes are not counted', () => {
        const drawing = sidecar(enc('a', 'image/png', 'drawing-1.png'), enc('b', DRAWING_STROKES_MIME, 'drawing-1.json'));
        expect(listBodySnippet(list(drawing))).toBe('1 picture');
    });
});

describe('a Púca Notes card', () => {
    const actions = { togglePin: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions;
    function render(noteAttachments: string) {
        const card = buildNoteCards([{ ref: { kind: 'list', id: 7 }, title: 'Song', noteAttachments }], new Map([['list:7', []]]), [], EMPTY_KEEP_PREFS)[0];
        act(() => {
            root.render(
                <NoteCard
                    card={card} actions={actions} now={Date.parse('2026-10-04T10:00:00Z')} compactTools={false}
                    onOpen={() => {}} onMenu={() => {}} onPickColor={() => {}} onPickLabels={() => {}}
                    onLabelClick={() => {}} onArchive={() => {}} registerEl={() => {}}
                />,
            );
        });
    }
    const chips = () => [...host.querySelectorAll('.notes-card-thumbs .notes-chip')].map(c => c.textContent);

    it.each([
        ['a voice note', VOICE_NOTE],
        ['an unlabelled .mp3', OLD_SONG],
    ])('holding only %s, says "1 file" and is not an "Empty note"', (_what, ref) => {
        render(sidecar(ref));
        expect(host.querySelector('.notes-card-empty')?.textContent ?? null, 'the card calls it empty').toBeNull();
        expect(chips()).toEqual(['1 file']);
    });

    it('control: a note holding only a PDF already said so', () => {
        render(sidecar(PDF));
        expect(host.querySelector('.notes-card-empty')).toBeNull();
        expect(chips()).toEqual(['1 file']);
    });
});

describe("a trashed note's line", () => {
    const features = { body: true, attachments: true, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 };
    function renderTrash(attachments: string) {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        qc.setQueryData(listContentKeys.features, features);
        qc.setQueryData(listContentKeys.trash, [{
            id: 5, title: 'Mixtape', created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
            body: null, attachments, trashed_at: '2026-09-10T00:00:00Z', is_self: false,
        }]);
        const content = { features, trashEnabled: true, deleteForever: vi.fn(async () => true), emptyTrash: vi.fn(async () => {}) } as unknown as ListContentActions;
        act(() => { root.render(<QueryClientProvider client={qc}><TrashView content={content} restoreNote={vi.fn(async () => true)} queuedDeletes={new Set()} /></QueryClientProvider>); });
        return host.querySelector('.notes-trash-meta')?.textContent ?? '';
    }

    it('calls a song a file, not a picture: it is what Delete forever destroys', () => {
        const meta = renderTrash(sidecar(OLD_SONG));
        expect(meta).toMatch(/^1 file · /);
        expect(meta).not.toContain('picture');
    });

    it('counts pictures, voice notes and other files each where they belong', () => {
        const meta = renderTrash(sidecar(PHOTO, VOICE_NOTE, OPUS, PDF));
        expect(meta).toMatch(/^1 picture · 3 files · /);
    });
});
