/**
 * A new note goes FIRST among the unpinned — directly under the pinned ones —
 * in the default order (the owner's ask). That order is not Notes' own: it is
 * `task_tab_prefs`, the saved order Púca's Tasks tab bar renders from, so the
 * same insert puts a new list first after the favourites there, and on every
 * device the account is signed in on.
 *
 * Here: where the insert goes (api/tasks.ts placeNewTabPrefs), what the grid
 * then shows and what it leaves alone (the pinned notes, the order of the
 * others, the other sort modes), the placement through Notes' offline outbox
 * — queued behind its own create, and placed against the order the server
 * holds when it lands — and the read-insert-write for a note made where no
 * copy of the order is at hand (api/listContent.ts placeNewListFirst).
 *
 * Each display check has its positive control: the same fixture WITHOUT the
 * placement puts the new note last, so a green here is the placement, not
 * the natural order happening to agree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get, post, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get, post, put } };
});
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
// A list's title is sealed to the account on the way out.
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(6));
    return { ...real, getActiveIdentity: () => id };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));

import { ApiError } from '../api/client';
import { makeIdentity } from '../api/e2ee';
import { placeNewTabPrefs, type TaskTabPref } from '../api/tasks';
import { placeNewListFirst } from '../api/listContent';
import { buildNoteCards, sortNoteCards, splitPinned, type NoteSource, type NotesNoteState } from '../notes/model/notesModel';
import { applyPrefsIntent, createOutbox, execOp, ops, referencesTemp, type ReplaySummary } from '../notes/model/notesOutbox';
import { memoryStore } from '../notes/model/notesCache';
import { resetNoteBusy } from '../notes/model/noteBusy';

const pref = (id: number, fav = false): TaskTabPref => ({ kind: 'list', ref_id: id, is_favorite: fav });
const show = (prefs: TaskTabPref[] | null) => prefs?.map(p => `${p.ref_id}${p.is_favorite ? '*' : ''}`).join(',') ?? null;
const NEW = { kind: 'list' as const, id: 50 };

beforeEach(() => {
    get.mockReset(); post.mockReset(); put.mockReset();
    put.mockResolvedValue({});
    resetNoteBusy();
});

describe('where a new note goes in the saved order', () => {
    it('first among the unpinned: the pinned keep their places, the others their order', () => {
        expect(show(placeNewTabPrefs([pref(1, true), pref(2, true), pref(3), pref(4)], NEW))).toBe('1*,2*,50,3,4');
    });

    it('no pins: first of all — and on an account that has never saved an order, the only entry', () => {
        expect(show(placeNewTabPrefs([pref(3), pref(4)], NEW))).toBe('50,3,4');
        expect(show(placeNewTabPrefs([], NEW))).toBe('50');
    });

    it('only pins: after all of them', () => {
        expect(show(placeNewTabPrefs([pref(1, true), pref(2, true)], NEW))).toBe('1*,2*,50');
    });

    it('a favourite dragged behind other tabs on Púca’s bar: in front of the first tab that is not one', () => {
        // Notes shows 2 pinned and 50 first of the others; the bar has 50 first.
        expect(show(placeNewTabPrefs([pref(3), pref(2, true), pref(4)], NEW))).toBe('50,3,2*,4');
    });

    it('only inserts: a note in the trash or the archive — hidden, still in the order — keeps its place among the rest', () => {
        // 8 is in the trash, 9 archived: neither is on screen, both are saved.
        const before = [pref(1, true), pref(8), pref(3), pref(9), pref(4)];
        const after = placeNewTabPrefs(before, NEW)!;
        expect(show(after)).toBe('1*,50,8,3,9,4');
        expect(after.filter(p => p.ref_id !== 50)).toEqual(before);
    });

    it('a channel checklist is a note too: the new one goes in front of an unpinned channel', () => {
        const before: TaskTabPref[] = [pref(1, true), { kind: 'channel', ref_id: 70, is_favorite: false }, pref(3)];
        expect(placeNewTabPrefs(before, NEW)!.map(p => `${p.kind}:${p.ref_id}`)).toEqual(['list:1', 'list:50', 'channel:70', 'list:3']);
    });

    it('a note already in the saved order is left where it is (a replay, or moved since)', () => {
        expect(placeNewTabPrefs([pref(3), pref(50), pref(4)], NEW)).toBeNull();
        expect(placeNewTabPrefs([pref(50, true)], NEW)).toBeNull();
    });
});

describe('what the grid shows', () => {
    // The server lists personal notes oldest first (src/task_handlers.rs:
    // is_self, then id) — which is why, before, a new note sat at the end.
    const source = (id: number, createdAt: string, title = `n${id}`): NoteSource => ({
        ref: { kind: 'list', id }, title, createdAt, updatedAt: createdAt,
    });
    const sources = [
        source(1, '2026-09-01T00:00:00Z', 'Groceries'),
        source(2, '2026-09-02T00:00:00Z', 'Poem'),
        source(3, '2026-09-03T00:00:00Z', 'Holiday'),
        source(4, '2026-09-04T00:00:00Z', 'Sketch'),
        source(50, '2026-09-29T00:00:00Z', 'Brand new'),
    ];
    const local: NotesNoteState = { colors: {}, labels: {}, archived: {} };
    // Pinned Groceries; the others saved as Holiday, Poem, Sketch (a move).
    const saved = [pref(1, true), pref(3), pref(2), pref(4)];
    const grid = (prefs: TaskTabPref[]) => {
        const { pinned, others } = splitPinned(buildNoteCards(sources, new Map(), prefs, local));
        return { pinned: pinned.map(c => c.ref.id), others: others.map(c => c.ref.id) };
    };

    it('POSITIVE CONTROL: without the placement the new note is LAST of the others', () => {
        expect(grid(saved)).toEqual({ pinned: [1], others: [3, 2, 4, 50] });
    });

    it('with it, the new note is first under the pinned one, and nothing else moved', () => {
        expect(grid(placeNewTabPrefs(saved, NEW)!)).toEqual({ pinned: [1], others: [50, 3, 2, 4] });
    });

    it('Title, Newest and Edited do not move for it; only Púca order does', () => {
        const before = buildNoteCards(sources, new Map(), saved, local);
        const after = buildNoteCards(sources, new Map(), placeNewTabPrefs(saved, NEW)!, local);
        const ids = (mode: Parameters<typeof sortNoteCards>[1], cards: typeof before) => sortNoteCards(cards, mode).map(c => c.ref.id);
        for (const mode of ['title', 'created', 'edited'] as const) {
            expect(ids(mode, after), mode).toEqual(ids(mode, before));
        }
        expect(ids('title', after)).toEqual([50, 1, 3, 2, 4]);       // Brand new, Groceries, Holiday, Poem, Sketch
        expect(ids('created', after)).toEqual([50, 4, 3, 2, 1]);
        // Positive control: the saved order really did change underneath.
        expect(ids('puca', after)).not.toEqual(ids('puca', before));
    });
});

describe('placed through the outbox', () => {
    const identity = makeIdentity(new Uint8Array(32).fill(5));
    const parked = { park: async () => {}, read: async () => [], remove: async () => {}, sweep: async () => {}, waiting: async () => ({ bytes: 0, items: 0 }) };
    function harness() {
        const store = memoryStore();
        let online = true;
        const summaries: ReplaySummary[] = [];
        const ob = createOutbox({
            sub: () => 7,
            identity: () => identity,
            store: () => store,
            exec: (op, ids, fromQueue) => execOp(op, ids, fromQueue, parked),
            online: () => online,
            lock: (_n, fn) => fn(),
            onReplayed: s => summaries.push(s),
            parked,
        });
        return { ob, summaries, setOnline: (v: boolean) => { online = v; } };
    }
    const row = (id: number) => ({ id, title: 'sealed', created_at: '2026-09-29T00:00:00Z', total_tasks: 0, completed_tasks: 0 });
    const prefsPuts = () => put.mock.calls.filter(c => c[0] === '/task-tab-prefs').map(c => show((c[1] as { prefs: TaskTabPref[] }).prefs));

    it('a placement naming a note made offline can never run ahead of its create', () => {
        const temp = { kind: 'list' as const, id: -5 };
        expect(referencesTemp(ops.prefs([pref(-5)], { type: 'created', tab: temp }))).toBe(true);
        // ...while one naming a real note may run at once.
        expect(referencesTemp(ops.prefs([pref(50)], { type: 'created', tab: NEW }))).toBe(false);
    });

    it('made offline: once it lands it goes first — in the order the server holds THEN, not the one this device saw', async () => {
        const h = harness();
        h.setOnline(false);
        await h.ob.send(ops.createList(-5, 'Groceries'));
        // What this device showed: its own order with the temporary note in it.
        const shown = placeNewTabPrefs([pref(1, true), pref(3), pref(4)], { kind: 'list', id: -5 })!;
        expect((await h.ob.send(ops.prefs(shown, { type: 'created', tab: { kind: 'list', id: -5 } }))).queued).toBe(true);
        expect(post).not.toHaveBeenCalled();
        // Meanwhile another device pinned 9 and put 4 above 3.
        post.mockResolvedValue(row(60));
        get.mockImplementation(async (path: string) => {
            if (path === '/task-tab-prefs') return [pref(9, true), pref(1, true), pref(4), pref(3)];
            throw new Error(`unexpected GET ${path}`);
        });
        h.setOnline(true);
        await h.ob.replay();
        expect(post.mock.calls.map(c => c[0])).toEqual(['/task-lists']);
        expect(prefsPuts()).toEqual(['9*,1*,60,4,3']);   // the real id, the other device's order kept
        expect(h.ob.pending()).toBe(0);
    });

    it('a create the server refuses takes its place with it — and the toast names only the note', async () => {
        const h = harness();
        h.setOnline(false);
        await h.ob.send(ops.createList(-5, 'Groceries'));
        await h.ob.send(ops.prefs([pref(-5)], { type: 'created', tab: { kind: 'list', id: -5 } }));
        post.mockRejectedValue(new ApiError('Too many notes', 409));
        h.setOnline(true);
        await h.ob.replay();
        expect(put).not.toHaveBeenCalled();
        expect(h.ob.pending()).toBe(0);
        expect(h.summaries.flatMap(s => s.dropped.map(o => o.label))).toEqual(['new note “Groceries”']);
    });

    it('run again after its answer was lost, it changes nothing: the note is in the order already', async () => {
        get.mockResolvedValue([pref(1, true), pref(60), pref(3)]);
        await execOp(ops.prefs([], { type: 'created', tab: { kind: 'list', id: -5 } }), { '-5': 60 }, true);
        expect(put).not.toHaveBeenCalled();
        expect(applyPrefsIntent([pref(1, true), pref(60)], { type: 'created', tab: { kind: 'list', id: 60 } })).toBeNull();
    });

    it('a temporary id that never became real places nothing', () => {
        expect(applyPrefsIntent([pref(1)], { type: 'created', tab: { kind: 'list', id: -5 } }, {})).toBeNull();
    });

    it('online, it is the set this device shows, sent as it is (like every pin)', async () => {
        const shown = placeNewTabPrefs([pref(1, true), pref(3)], NEW)!;
        await execOp(ops.prefs(shown, { type: 'created', tab: NEW }), {}, false);
        expect(prefsPuts()).toEqual(['1*,50,3']);
        expect(get).not.toHaveBeenCalled();
    });
});

describe('placeNewListFirst — a note made where no copy of the order is at hand', () => {
    it('reads the order the server holds, puts the note first among the unpinned, and saves it', async () => {
        get.mockResolvedValue([pref(5, true), pref(7), pref(9)]);
        expect(show(await placeNewListFirst(99))).toBe('5*,99,7,9');      // the order as now saved
        expect(get).toHaveBeenCalledWith('/task-tab-prefs');
        expect(put).toHaveBeenCalledWith('/task-tab-prefs', { prefs: [pref(5, true), pref(99), pref(7), pref(9)] });
    });

    it('an order it cannot read is never replaced — nothing is written, and it does not throw', async () => {
        put.mockRejectedValueOnce(new ApiError('Bad Gateway', 502));
        get.mockResolvedValueOnce([pref(7)]);
        expect(await placeNewListFirst(99)).toBeNull();                  // a refused write is not "saved" either
        put.mockClear();
        for (const err of [new ApiError('Not Found', 404), new TypeError('Failed to fetch')]) {
            get.mockReset();
            get.mockRejectedValue(err);
            expect(await placeNewListFirst(99)).toBeNull();
        }
        expect(put).not.toHaveBeenCalled();
    });

    it('a note the order has already placed is left alone', async () => {
        get.mockResolvedValue([pref(99), pref(7)]);
        expect(show(await placeNewListFirst(99))).toBe('99,7');
        expect(put).not.toHaveBeenCalled();
    });
});
