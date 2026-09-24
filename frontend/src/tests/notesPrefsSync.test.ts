/**
 * Colour, labels, archive and the four reminder times follow the account
 * (notes/model/notesPrefsSync.ts).
 *
 * Two "devices" share one in-memory server that implements the real
 * compare-and-swap (src/sealed_blob_handlers.rs), and every document goes
 * through the real sealing (api/e2ee.ts sealAccountBlob). What these pin:
 *  - the merge-ONCE rule (a never-synced local copy is unioned in once,
 *    after which the server wins) — "unarchive on A survives B reload";
 *  - a 409 replays this device's change onto the newer document;
 *  - 413 keeps the local copy and says so; an old backend stays local-only;
 *  - the server cannot roll the document back or swap the envelope.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));

import { makeIdentity, openAccountBlob, sealAccountBlob, type Identity } from '../api/e2ee';
import type { GetBlobResult, PutBlobResult, SealedBlobDoc } from '../api/sealedBlobs';
import type { NotesNoteState } from '../notes/model/notesModel';
const {
    createPrefsSync, threeWayMerge, unionMerge, mergeTimes, encodePrefsDoc, decodePrefsDoc, EMPTY_NOTE_STATE, sameNoteState,
} = await import('../notes/model/notesPrefsSync');
import { DEFAULT_REMINDER_TIMES, type ReminderTimes } from '../api/reminderTimes';
type SyncRecord = import('../notes/model/notesPrefsSync').SyncRecord;

const UID = 7;
const identity: Identity = makeIdentity(new Uint8Array(32).fill(9));

class FakeServer {
    doc: SealedBlobDoc = { rev: 0, blob: null };
    supported = true;
    maxBytes = 1 << 20;
    puts = 0;
    async get(): Promise<GetBlobResult> {
        return this.supported ? { kind: 'ok', doc: { ...this.doc } } : { kind: 'unsupported' };
    }
    async put(expected: number, blob: string): Promise<PutBlobResult> {
        this.puts++;
        if (!this.supported) return { kind: 'unsupported' };
        if (blob.length > this.maxBytes) return { kind: 'too-large' };
        if (expected !== this.doc.rev) return { kind: 'conflict', current: { ...this.doc } };
        this.doc = { rev: this.doc.rev + 1, blob };
        return { kind: 'written', rev: this.doc.rev };
    }
    async state(): Promise<NotesNoteState | null> {
        if (!this.doc.blob) return null;
        const text = await openAccountBlob(identity, UID, 'notes-prefs', this.doc.blob);
        return text ? decodePrefsDoc(text)!.state : null;
    }
}

function device(server: FakeServer, initial: NotesNoteState = EMPTY_NOTE_STATE) {
    let local = initial;
    const records = new Map<number, SyncRecord>();
    const sync = createPrefsSync({
        uid: () => UID,
        identity: () => identity,
        get: () => server.get(),
        put: (r, b) => server.put(r, b),
        readLocal: () => local,
        writeLocal: s => { local = s; },
        records: { load: u => records.get(u) ?? null, save: (u, r) => { records.set(u, r); } },
    });
    return {
        sync,
        get local() { return local; },
        edit(fn: (s: NotesNoteState) => NotesNoteState) { local = fn(local); },
        records,
    };
}

const st = (o: Partial<NotesNoteState>): NotesNoteState => ({ colors: {}, labels: {}, archived: {}, ...o });

describe('merge rules (pure)', () => {
    it('the one-time union keeps what only this device had, and the server colour wins', () => {
        const merged = unionMerge(
            st({ colors: { 'list:1': 'mint', 'list:2': 'sand' }, labels: { 'list:1': ['Home'] }, archived: { 'list:3': true } }),
            st({ colors: { 'list:1': 'coral' }, labels: { 'list:1': ['Work'] }, archived: { 'list:4': true } }),
        );
        expect(merged.colors).toEqual({ 'list:1': 'coral', 'list:2': 'sand' });
        expect(merged.labels['list:1']).toEqual(['Work', 'Home']);
        expect(merged.archived).toEqual({ 'list:3': true, 'list:4': true });
    });

    it('three-way: an untouched field takes the server, a changed one keeps the local value', () => {
        const base = st({ colors: { 'list:1': 'mint' }, labels: { 'list:1': ['a', 'b'] }, archived: { 'list:9': true } });
        const local = st({ colors: { 'list:1': 'mint', 'list:2': 'sage' }, labels: { 'list:1': ['a', 'c'] }, archived: { 'list:9': true } });
        const server = st({ colors: { 'list:1': 'dusk' }, labels: { 'list:1': ['a', 'b', 'z'] }, archived: {} });
        const m = threeWayMerge(base, local, server);
        expect(m.colors).toEqual({ 'list:1': 'dusk', 'list:2': 'sage' });   // server's change + our new one
        expect(m.labels['list:1']).toEqual(['a', 'z', 'c']);                   // our -b +c onto their +z
        expect(m.archived).toEqual({});                                         // they unarchived; we did not touch it
    });
});

describe('two devices, one account', () => {
    it('first sync uploads a never-synced local copy as revision 1', async () => {
        const server = new FakeServer();
        const a = device(server, st({ labels: { 'list:1': ['Old'] }, colors: { 'list:1': 'mint' } }));
        expect(await a.sync.pull()).toBe('synced');
        expect(server.doc.rev).toBe(1);
        expect(await server.state()).toEqual(st({ labels: { 'list:1': ['Old'] }, colors: { 'list:1': 'mint' } }));
    });

    it('a never-synced copy is merged ONCE into an existing document', async () => {
        const server = new FakeServer();
        const a = device(server, st({ labels: { 'list:1': ['FromA'] } }));
        await a.sync.pull();
        const b = device(server, st({ labels: { 'list:1': ['FromB'] }, archived: { 'list:2': true } }));
        expect(await b.sync.pull()).toBe('synced');
        expect((await server.state())!.labels['list:1']).toEqual(['FromA', 'FromB']);
        expect((await server.state())!.archived).toEqual({ 'list:2': true });
    });

    it('unarchive on A survives B reload (the server wins after the first sync)', async () => {
        const server = new FakeServer();
        const a = device(server, st({ archived: { 'list:5': true }, labels: { 'list:5': ['x'] } }));
        await a.sync.pull();
        const b = device(server);
        await b.sync.pull();
        expect(b.local.archived).toEqual({ 'list:5': true });

        a.edit(s => ({ ...s, archived: {}, labels: {} }));   // A unarchives and removes the label
        expect(await a.sync.push()).toBe('synced');

        expect(await b.sync.pull()).toBe('synced');          // B "reloads"
        expect(b.local.archived).toEqual({});
        expect(b.local.labels).toEqual({});
        expect(await server.state()).toEqual(st({}));       // and B did not push them back
    });

    it('a 409 replays this device’s change onto the newer document', async () => {
        const server = new FakeServer();
        const a = device(server);
        const b = device(server);
        await a.sync.pull();
        await b.sync.pull();
        a.edit(s => ({ ...s, colors: { 'list:1': 'coral' } }));
        b.edit(s => ({ ...s, labels: { 'list:2': ['Groceries'] } }));
        expect(await a.sync.push()).toBe('synced');
        const putsBefore = server.puts;
        expect(await b.sync.push()).toBe('synced');
        expect(server.puts - putsBefore).toBe(2);            // one conflict, one retry
        expect(await server.state()).toEqual(st({ colors: { 'list:1': 'coral' }, labels: { 'list:2': ['Groceries'] } }));
        expect(sameNoteState(b.local, (await server.state())!)).toBe(true);
    });

    it('413: the local copy is kept and the status says so', async () => {
        const server = new FakeServer();
        const a = device(server);
        await a.sync.pull();
        server.maxBytes = 10;
        a.edit(s => ({ ...s, labels: { 'list:1': ['Keep me'] } }));
        expect(await a.sync.push()).toBe('too-large');
        expect(a.local.labels).toEqual({ 'list:1': ['Keep me'] });
        // Once it fits again, the same change goes up — it was never dropped.
        server.maxBytes = 1 << 20;
        expect(await a.sync.push()).toBe('synced');
        expect((await server.state())!.labels).toEqual({ 'list:1': ['Keep me'] });
    });

    it('an old backend (no route) leaves everything local', async () => {
        const server = new FakeServer();
        server.supported = false;
        const a = device(server, st({ colors: { 'list:1': 'mint' } }));
        expect(await a.sync.pull()).toBe('local-only');
        expect(a.local.colors).toEqual({ 'list:1': 'mint' });
    });

    it('refuses a rollback to an older revision', async () => {
        const server = new FakeServer();
        const a = device(server, st({ colors: { 'list:1': 'mint' } }));
        await a.sync.pull();
        const old = { ...server.doc };
        a.edit(s => ({ ...s, colors: { 'list:1': 'dusk' } }));
        await a.sync.push();                                // rev 2
        server.doc = old;                                    // the server replays revision 1
        expect(await a.sync.pull()).toBe('rollback');
        expect(a.local.colors).toEqual({ 'list:1': 'dusk' });
    });

    it('refuses a document whose inner revision disagrees with the server’s', async () => {
        const server = new FakeServer();
        const a = device(server);
        server.doc = { rev: 5, blob: await sealAccountBlob(identity, UID, 'notes-prefs', encodePrefsDoc(2, st({ colors: { 'list:1': 'mint' } }))) };
        expect(await a.sync.pull()).toBe('unreadable');
        expect(a.local).toEqual(EMPTY_NOTE_STATE);
    });
});

describe('Púca and Notes open at once (two writers, one document)', () => {
    it('a colour from one tab and an archive from the other both land on the same note', async () => {
        const server = new FakeServer();
        const notes = device(server);
        const puca = device(server);
        await notes.sync.pull();
        await puca.sync.pull();

        notes.edit(s => ({ ...s, archived: { 'list:3': true } }));
        puca.edit(s => ({ ...s, colors: { 'list:3': 'sage' } }));
        expect(await notes.sync.push()).toBe('synced');
        const putsBefore = server.puts;
        expect(await puca.sync.push()).toBe('synced');

        expect(server.puts - putsBefore, 'one conflict, one retry').toBe(2);
        expect(await server.state()).toEqual(st({ archived: { 'list:3': true }, colors: { 'list:3': 'sage' } }));
        // Not last-write-wins: the archive the OTHER tab set is in this one's
        // own copy now, which is what stops the two undoing each other all day.
        expect(puca.local.archived).toEqual({ 'list:3': true });
    });

    it('a label removed in one tab is not resurrected by the other tab’s edit to the same note', async () => {
        const server = new FakeServer();
        const notes = device(server, st({ labels: { 'list:3': ['Shopping', 'Urgent'] } }));
        await notes.sync.pull();
        const puca = device(server);
        await puca.sync.pull();
        expect(puca.local.labels['list:3'], 'both tabs start from the same document').toEqual(['Shopping', 'Urgent']);

        notes.edit(s => ({ ...s, labels: { 'list:3': ['Shopping'] } }));      // drops Urgent
        expect(await notes.sync.push()).toBe('synced');
        puca.edit(s => ({ ...s, labels: { 'list:3': ['Shopping', 'Urgent', 'Later'] } }));   // adds Later
        expect(await puca.sync.push()).toBe('synced');

        // The three-way merge is what decides this: a union would have brought
        // Urgent back, and a last write would have lost Later.
        expect((await server.state())!.labels['list:3']).toEqual(['Shopping', 'Later']);
        expect(puca.local.labels['list:3']).toEqual(['Shopping', 'Later']);
    });
});

describe('nothing is lost in a slow conflict, and a rollback has a way out', () => {
    it('an edit made DURING a slow 409 round trip survives the merge', async () => {
        const server = new FakeServer();
        const a = device(server);
        const b = device(server);
        await a.sync.pull();
        await b.sync.pull();
        a.edit(s => ({ ...s, colors: { 'list:1': 'coral' } }));
        await a.sync.push();                                        // B is now one revision behind
        b.edit(s => ({ ...s, labels: { 'list:2': ['First'] } }));
        // The server answers B's PUT slowly; while it is out, B edits again.
        const realPut = server.put.bind(server);
        let releases = 0;
        server.put = async (expected, blob) => {
            const r = await realPut(expected, blob);
            if (r.kind === 'conflict' && releases++ === 0) {
                await new Promise(res => setTimeout(res, 20));
                b.edit(s => ({ ...s, colors: { ...s.colors, 'list:3': 'sage' } }));   // typed during the round trip
            }
            return r;
        };
        expect(await b.sync.push()).toBe('synced');
        expect(b.local.colors['list:3']).toBe('sage');              // not written over by the merge
        expect(b.local.colors['list:1']).toBe('coral');             // and the other device's change arrived
        expect(b.local.labels['list:2']).toEqual(['First']);
        // The late edit goes up with the next push (it is this device's change).
        expect(await b.sync.push()).toBe('synced');
        expect((await server.state())!.colors).toEqual({ 'list:1': 'coral', 'list:3': 'sage' });
    });

    async function rolledBack() {
        const server = new FakeServer();
        const a = device(server, st({ colors: { 'list:1': 'mint' } }));
        await a.sync.pull();
        const old = { ...server.doc };                              // revision 1: mint
        a.edit(s => ({ ...s, colors: { 'list:1': 'dusk' } }));
        await a.sync.push();                                        // revision 2: dusk
        a.edit(s => ({ ...s, colors: { ...s.colors, 'list:2': 'sand' } }));
        await a.sync.push();                                        // revision 3
        server.doc = old;                                           // a restored backup
        expect(await a.sync.pull()).toBe('rollback');
        return { server, a };
    }

    it('rollback -> "use the server’s copy" takes it, and syncing resumes', async () => {
        const { server, a } = await rolledBack();
        expect(await a.sync.acceptServer()).toBe('synced');
        expect(a.local.colors).toEqual({ 'list:1': 'mint' });
        // Resumed: a later edit syncs, and a later pull is not refused.
        a.edit(s => ({ ...s, colors: { 'list:1': 'coral' } }));
        expect(await a.sync.push()).toBe('synced');
        expect(await a.sync.pull()).toBe('synced');
        expect((await server.state())!.colors).toEqual({ 'list:1': 'coral' });
    });

    it('rollback -> "keep this device’s" replaces the server’s, and syncing resumes', async () => {
        const { server, a } = await rolledBack();
        expect(await a.sync.overwriteServer()).toBe('synced');
        expect((await server.state())!.colors).toEqual({ 'list:1': 'dusk', 'list:2': 'sand' });
        expect(await a.sync.pull()).toBe('synced');                 // not refused as a rollback again
        const b = device(server);
        expect(await b.sync.pull()).toBe('synced');
        expect(b.local.colors).toEqual({ 'list:1': 'dusk', 'list:2': 'sand' });
    });

    it('accepting the server’s copy still refuses one that will not open', async () => {
        const { server, a } = await rolledBack();
        server.doc = { rev: 1, blob: await sealAccountBlob(makeIdentity(new Uint8Array(32).fill(3)), UID, 'notes-prefs', encodePrefsDoc(1, st({}))) };
        expect(await a.sync.acceptServer()).toBe('unreadable');
        expect(a.local.colors).toEqual({ 'list:1': 'dusk', 'list:2': 'sand' });
    });
});

describe('what a sign-out would lose', () => {
    it('unsynced(): a local change not yet in the account’s document', async () => {
        const server = new FakeServer();
        const a = device(server);
        expect(a.sync.unsynced()).toBe(false);                      // empty: nothing to lose
        a.edit(s => ({ ...s, labels: { 'list:1': ['Mine'] } }));
        expect(a.sync.unsynced()).toBe(true);                       // never synced
        expect(await a.sync.pull()).toBe('synced');
        expect(a.sync.unsynced()).toBe(false);                      // positive control: in the document now
        a.edit(s => ({ ...s, colors: { 'list:1': 'mint' } }));
        expect(a.sync.unsynced()).toBe(true);                       // edited since
        server.maxBytes = 10;
        expect(await a.sync.push()).toBe('too-large');
        expect(a.sync.unsynced()).toBe(true);                       // kept here only
        server.maxBytes = 1 << 20;
        expect(await a.sync.push()).toBe('synced');
        expect(a.sync.unsynced()).toBe(false);
    });

    it('unsynced(): clearing the LAST colour or label is a change a sign-out would lose', async () => {
        const server = new FakeServer();
        const a = device(server, st({ colors: { 'list:1': 'mint' } }));
        expect(await a.sync.pull()).toBe('synced');
        expect(a.sync.unsynced()).toBe(false);
        a.edit(() => st({}));                                       // offline: the copy is now empty
        expect(a.sync.unsynced()).toBe(true);                       // the document still holds 'mint'
        expect(await a.sync.push()).toBe('synced');
        expect(await server.state()).toEqual(st({}));
        expect(a.sync.unsynced()).toBe(false);                      // positive control: the removal landed
        // An empty copy against an empty document, or never synced (an old backend), is nothing.
        const b = device(new FakeServer());
        expect(await b.sync.pull()).toBe('synced');
        expect(b.sync.unsynced()).toBe(false);
        const old = new FakeServer();
        old.supported = false;
        const c = device(old);
        expect(await c.sync.pull()).toBe('local-only');
        expect(c.sync.unsynced()).toBe(false);
    });

    it('unsynced(): a refused rollback or an old backend counts even when local equals the last base', async () => {
        const server = new FakeServer();
        server.supported = false;
        const a = device(server, st({ colors: { 'list:1': 'mint' } }));
        expect(await a.sync.pull()).toBe('local-only');
        expect(a.sync.unsynced()).toBe(true);
        const s2 = new FakeServer();
        const b = device(s2, st({ colors: { 'list:1': 'mint' } }));
        await b.sync.pull();
        const old = { ...s2.doc };
        b.edit(s => ({ ...s, colors: { 'list:1': 'dusk' } }));
        await b.sync.push();
        s2.doc = old;
        expect(await b.sync.pull()).toBe('rollback');
        expect(b.sync.unsynced()).toBe(true);
    });
});

describe('the envelope', () => {
    it('opens only its own account, name and key — never plaintext', async () => {
        const blob = await sealAccountBlob(identity, UID, 'notes-prefs', 'secret');
        expect(blob).not.toContain('secret');
        expect(await openAccountBlob(identity, UID, 'notes-prefs', blob)).toBe('secret');   // positive control
        expect(await openAccountBlob(identity, UID + 1, 'notes-prefs', blob)).toBeNull();   // another account's slot
        expect(await openAccountBlob(makeIdentity(new Uint8Array(32).fill(1)), UID, 'notes-prefs', blob)).toBeNull();
        expect(await openAccountBlob(identity, UID, 'notes-prefs', JSON.stringify({ colors: {} }))).toBeNull();
        expect(await openAccountBlob(identity, UID, 'notes-prefs', '{"v":1,"t":"notes-prefs","ct":"not base64 at all"}')).toBeNull();
    });

    it('carries colour, labels and archive only — never the per-device view or sort', () => {
        const text = encodePrefsDoc(1, { colors: {}, labels: {}, archived: {}, view: 'list', sort: 'title' } as unknown as NotesNoteState);
        expect(text).not.toContain('view');
        expect(text).not.toContain('sort');
    });
});

// THE REMINDER TIMES ride in the same document. Two things have to hold or the
// setting is worse than not shipping it: a changed time must actually PUSH
// (sameNoteState is what decides that, and what a sign-out warns from), and a
// document written by a build that predates the setting — which drops the key
// on its own next write — must never be read as "the user cleared them".
const times = (o: Partial<ReminderTimes>): ReminderTimes => ({ ...DEFAULT_REMINDER_TIMES, ...o });

describe('the reminder times follow the account', () => {
    it('a changed time is a difference worth pushing; the defaults are not', () => {
        expect(sameNoteState(st({}), st({ times: DEFAULT_REMINDER_TIMES }))).toBe(true);
        expect(sameNoteState(st({}), st({ times: times({ morning: '07:30' }) }))).toBe(false);
        expect(sameNoteState(st({ times: times({ morning: '07:30' }) }), st({ times: times({ morning: '07:30' }) }))).toBe(true);
    });

    it('mergeTimes keeps what this device changed and takes the server for the rest', () => {
        const base = times({});
        const local = times({ morning: '07:30' });                    // we changed Morning
        const server = times({ evening: '22:00', morning: '10:00' }); // they changed Evening (and Morning)
        expect(mergeTimes(base, local, server)).toEqual(times({ morning: '07:30', evening: '22:00' }));
        // A server that carries none changes nothing — and one absent locally
        // (only possible from an old stored record) takes the server's.
        expect(mergeTimes(base, local, undefined)).toEqual(local);
        expect(mergeTimes(base, undefined, server)).toEqual(server);
        expect(mergeTimes(undefined, undefined, undefined)).toBeUndefined();
    });

    it('a document that carries no times decodes as ABSENT, not as the defaults', async () => {
        const withNone = encodePrefsDoc(1, st({ colors: { 'list:1': 'mint' } }));
        expect(JSON.parse(withNone).prefs.times).toBeUndefined();
        expect(decodePrefsDoc(withNone)!.state.times).toBeUndefined();
        // Positive control: one that carries them decodes them.
        const withSome = encodePrefsDoc(1, st({ times: times({ morning: '07:30' }) }));
        expect(decodePrefsDoc(withSome)!.state.times).toEqual(times({ morning: '07:30' }));
        // And a malformed times survives validation rather than throwing.
        expect(decodePrefsDoc(JSON.stringify({ v: 1, rev: 1, prefs: { times: 'nope' } }))!.state.times).toBeUndefined();
        // An OBJECT with not one usable field is unreadable too, not "the
        // user chose the defaults": parsed it is all-defaults and would
        // overwrite another device's real times on the fields it never
        // carried.
        expect(decodePrefsDoc(JSON.stringify({ v: 1, rev: 1, prefs: { times: { morning: 'x', evening: 25 } } }))!.state.times).toBeUndefined();
        expect(decodePrefsDoc(JSON.stringify({ v: 1, rev: 1, prefs: { times: {} } }))!.state.times).toBeUndefined();
        // Positive control: ONE usable field is a document that carries them,
        // and the rest fall back to the defaults as they always did.
        expect(decodePrefsDoc(JSON.stringify({ v: 1, rev: 1, prefs: { times: { morning: 'x', evening: '22:00' } } }))!.state.times)
            .toEqual(times({ evening: '22:00' }));
    });

    it('a corrupt times does not overwrite another device’s real ones', async () => {
        // The merge is what the decode protects: server.times absent means
        // UNKNOWN, so the local value stands (and heals the document on the
        // next push). Server.times present-and-default would win instead.
        const base = times({ morning: '07:30' });
        const local = times({ morning: '07:30' });
        const corrupt = decodePrefsDoc(JSON.stringify({ v: 1, rev: 1, prefs: { times: { morning: 'half-typed' } } }))!.state.times;
        expect(mergeTimes(base, local, corrupt)).toEqual(times({ morning: '07:30' }));
        // Positive control: a READABLE server change to the same field wins,
        // because this device did not touch it since `base`.
        const real = decodePrefsDoc(JSON.stringify({ v: 1, rev: 1, prefs: { times: { morning: '10:00' } } }))!.state.times;
        expect(mergeTimes(base, base, real)).toEqual(times({ morning: '10:00' }));
    });

    it('a time set on A reaches B', async () => {
        const server = new FakeServer();
        const a = device(server);
        await a.sync.pull();
        const b = device(server);
        await b.sync.pull();

        a.edit(s => ({ ...s, times: times({ morning: '07:30' }) }));
        expect(await a.sync.push()).toBe('synced');
        expect(await b.sync.pull()).toBe('synced');
        expect(b.local.times).toEqual(times({ morning: '07:30' }));
    });

    it('a 409 replays a time change onto the newer document', async () => {
        const server = new FakeServer();
        const a = device(server);
        await a.sync.pull();
        const b = device(server);
        await b.sync.pull();

        b.edit(s => ({ ...s, colors: { 'list:1': 'mint' } }));
        await b.sync.push();                                        // B gets in first
        a.edit(s => ({ ...s, times: times({ evening: '22:00' }) }));
        expect(await a.sync.push()).toBe('synced');                 // A conflicts, replays

        const final = (await server.state())!;
        expect(final.times).toEqual(times({ evening: '22:00' }));
        expect(final.colors).toEqual({ 'list:1': 'mint' });          // and B's change survived
    });

    it('unsynced() is true when only a reminder time differs — a sign-out must warn', async () => {
        const server = new FakeServer();
        const a = device(server);
        await a.sync.pull();
        expect(a.sync.unsynced()).toBe(false);                       // positive control
        a.edit(s => ({ ...s, times: times({ afternoon: '13:00' }) }));
        expect(a.sync.unsynced()).toBe(true);
        await a.sync.push();
        expect(a.sync.unsynced()).toBe(false);
    });

    it('a document written by a build that does not know the times does NOT wipe them', async () => {
        const server = new FakeServer();
        const a = device(server, st({ times: times({ morning: '07:30' }) }));
        await a.sync.pull();
        expect((await server.state())!.times).toEqual(times({ morning: '07:30' }));

        // An older Notes build pulls, drops what it cannot parse, and writes
        // its own colour change back — a document with NO times at all.
        server.doc = { rev: 9, blob: await sealAccountBlob(identity, UID, 'notes-prefs', encodePrefsDoc(9, st({ colors: { 'list:1': 'mint' } }))) };

        expect(await a.sync.pull()).toBe('synced');
        expect(a.local.times).toEqual(times({ morning: '07:30' }));  // kept, not reset
        expect(a.local.colors).toEqual({ 'list:1': 'mint' });        // and the old build's change applied
        expect((await server.state())!.times).toEqual(times({ morning: '07:30' }));   // healed on the way back
    });

    it('an account that never set a time keeps the document free of them', async () => {
        const server = new FakeServer();
        const a = device(server, st({ colors: { 'list:1': 'mint' } }));
        await a.sync.pull();
        server.doc = { rev: 9, blob: await sealAccountBlob(identity, UID, 'notes-prefs', encodePrefsDoc(9, st({ colors: { 'list:2': 'sage' } }))) };
        const puts = server.puts;
        expect(await a.sync.pull()).toBe('synced');
        expect(server.puts).toBe(puts);                              // nothing to heal: no write at all
    });
});

/**
 * A sync operation is async; the account is not. Notes' sign-out and Púca's
 * handleLogout never reload the page, so an operation still in flight when A
 * signs out (the 3 s sign-out flush that lost its race, a focus pull) resolves
 * into whatever the page has become: signed out, or signed in as B. Nothing it
 * learned about A may land after that — not in B's local copy, not in B's
 * document, and not as a re-created plaintext `pucaNotesPrefsSync:A` record
 * the sign-out had just scrubbed.
 */
describe('an operation that outlives its account does nothing', () => {
    const idA = identity;
    const idB = makeIdentity(new Uint8Array(32).fill(4));

    function deferred<T>() {
        let resolve!: (v: T) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
        return { promise, resolve, reject };
    }

    /** One page whose account the test switches under a running operation. */
    function page(initialLocal: NotesNoteState = EMPTY_NOTE_STATE) {
        const acct = { uid: 1 as number | null, id: idA as Identity | null, epoch: 0 };
        let local = initialLocal;
        const writes: Array<{ state: NotesNoteState; uid: number | undefined }> = [];
        const saves: Array<{ uid: number; rec: SyncRecord }> = [];
        const records = new Map<number, SyncRecord>();
        const gets: Array<{ promise: Promise<GetBlobResult>; resolve: (v: GetBlobResult) => void; reject: (e: unknown) => void }> = [];
        const puts: Array<{ rev: number; blob: string; resolve: (v: PutBlobResult) => void; reject: (e: unknown) => void }> = [];
        let onReadLocal: (() => void) | null = null;
        const sync = createPrefsSync({
            uid: () => acct.uid,
            identity: () => acct.id,
            epoch: () => acct.epoch,
            get: () => { const d = deferred<GetBlobResult>(); gets.push(d); return d.promise; },
            put: (rev, blob) => { const d = deferred<PutBlobResult>(); puts.push({ rev, blob, resolve: d.resolve, reject: d.reject }); return d.promise; },
            readLocal: () => { const f = onReadLocal; onReadLocal = null; f?.(); return local; },
            writeLocal: (s, uid) => { writes.push({ state: s, uid }); local = s; },
            records: {
                load: u => records.get(u) ?? null,
                save: (u, r) => { saves.push({ uid: u, rec: r }); records.set(u, r); },
            },
        });
        return {
            sync, acct, writes, saves, records, gets, puts,
            get local() { return local; },
            set local(s: NotesNoteState) { local = s; },
            /** Run `f` inside the next readLocal() — synchronously, just
             *  before the operation's next await. */
            atNextRead(f: () => void) { onReadLocal = f; },
        };
    }

    const flush = () => new Promise(r => setTimeout(r, 0));
    const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) await flush(); };
    /** Let the operation run to completion — or, where the unfixed code goes
     *  on to a PUT nobody answers, as far as it gets — then assert. */
    const settle = (op: Promise<unknown>) => Promise.race([op, until(() => false)]);
    const aDoc = async (rev: number, s: NotesNoteState) =>
        ({ rev, blob: await sealAccountBlob(idA, 1, 'notes-prefs', encodePrefsDoc(rev, s)) });
    const A_STATE = st({ labels: { 'list:1': ['A-private'] }, colors: { 'list:1': 'coral' }, times: times({ morning: '05:15' }) });
    const B_STATE = st({ labels: { 'list:9': ['B-own'] } });

    it('pull: A signs out and B signs in while the GET is out — nothing of A lands anywhere', async () => {
        const p = page(B_STATE);
        const op = p.sync.pull();
        await until(() => p.gets.length > 0);
        expect(p.gets.length).toBe(1);                              // A's GET is in flight
        p.acct.uid = 2; p.acct.id = idB; p.acct.epoch++;            // sign-out, then B signs in
        p.gets[0].resolve({ kind: 'ok', doc: await aDoc(1, A_STATE) });
        await settle(op);
        expect(p.writes).toEqual([]);                               // B's copy untouched
        expect(p.saves).toEqual([]);                                // no record for A (or B)
        expect(p.puts).toEqual([]);                                 // nothing sealed under A with B's token
        expect(p.local).toEqual(B_STATE);
        expect(p.sync.status()).toBe('idle');                       // B's shell shows no bogus status
    });

    it('pull: A signs out (no one signs in) — the scrubbed record is NOT re-created', async () => {
        const p = page();
        const op = p.sync.pull();
        await until(() => p.gets.length > 0);
        p.acct.uid = null; p.acct.id = null; p.acct.epoch++;
        p.gets[0].resolve({ kind: 'ok', doc: await aDoc(1, A_STATE) });
        await settle(op);
        expect(p.saves).toEqual([]);
        expect(p.writes).toEqual([]);
    });

    it('pull: A signs out and straight back in as A — a new session all the same, the stale pull does nothing', async () => {
        const p = page();
        const op = p.sync.pull();
        await until(() => p.gets.length > 0);
        p.acct.epoch++;                                             // same uid, same key: only the epoch tells
        p.gets[0].resolve({ kind: 'ok', doc: await aDoc(1, A_STATE) });
        await settle(op);
        expect(p.saves).toEqual([]);
        expect(p.writes).toEqual([]);
    });

    it('pull: the identity re-derived for the SAME account (a new object) is not an account change', async () => {
        const p = page();
        const op = p.sync.pull();
        await until(() => p.gets.length > 0);
        p.acct.id = makeIdentity(new Uint8Array(32).fill(9));      // same seed as idA, a different object
        p.gets[0].resolve({ kind: 'ok', doc: await aDoc(1, A_STATE) });
        expect(await op).toBe('synced');
        expect(p.local).toEqual(A_STATE);
        expect(p.saves.map(s => s.uid)).toEqual([1]);
        expect(p.writes.map(w => w.uid)).toEqual([1]);             // and the write names its account
    });

    it('push: the account changes while the blob is being sealed — the PUT is never sent', async () => {
        const p = page(A_STATE);
        p.records.set(1, { rev: 1, base: EMPTY_NOTE_STATE, maxRev: 1 });
        p.atNextRead(() => { p.acct.uid = 2; p.acct.id = idB; p.acct.epoch++; });
        const op = p.sync.push();
        await until(() => p.puts.length > 0);
        expect(p.puts).toEqual([]);                                 // B's token never carries A's blob
        p.puts[0]?.resolve({ kind: 'written', rev: 2 });
        await settle(op);
        expect(p.saves).toEqual([]);
    });

    it('push: the account changes while the PUT is out — the written revision is not recorded', async () => {
        const p = page(A_STATE);
        p.records.set(1, { rev: 1, base: EMPTY_NOTE_STATE, maxRev: 1 });
        const op = p.sync.push();
        await until(() => p.puts.length > 0);
        expect(p.puts.length).toBe(1);
        p.acct.uid = null; p.acct.id = null; p.acct.epoch++;        // the sign-out flush lost its 3 s race
        p.puts[0].resolve({ kind: 'written', rev: 2 });
        await settle(op);
        expect(p.saves).toEqual([]);
    });

    it('push: a 409 answered after the switch is not merged into the next account', async () => {
        const p = page(A_STATE);
        p.records.set(1, { rev: 1, base: EMPTY_NOTE_STATE, maxRev: 1 });
        const op = p.sync.push();
        await until(() => p.puts.length > 0);
        p.acct.uid = 2; p.acct.id = idB; p.acct.epoch++;
        p.local = B_STATE;                                          // B's copy is what readLocal sees now
        p.puts[0].resolve({ kind: 'conflict', current: await aDoc(3, st({ colors: { 'list:2': 'sage' } })) });
        await settle(op);
        expect(p.writes).toEqual([]);
        expect(p.saves).toEqual([]);
        expect(p.local).toEqual(B_STATE);
    });

    it('acceptServer: the account changes while the GET is out — B’s copy is not replaced by A’s', async () => {
        const p = page(B_STATE);
        const op = p.sync.acceptServer();
        await until(() => p.gets.length > 0);
        p.acct.uid = 2; p.acct.id = idB; p.acct.epoch++;
        p.gets[0].resolve({ kind: 'ok', doc: await aDoc(4, A_STATE) });
        await settle(op);
        expect(p.writes).toEqual([]);
        expect(p.saves).toEqual([]);
        expect(p.local).toEqual(B_STATE);
    });

    it('overwriteServer: the account changes while the GET is out — no record, no PUT', async () => {
        const p = page(A_STATE);
        const op = p.sync.overwriteServer();
        await until(() => p.gets.length > 0);
        p.acct.uid = null; p.acct.id = null; p.acct.epoch++;
        p.gets[0].resolve({ kind: 'ok', doc: await aDoc(4, A_STATE) });
        await settle(op);
        expect(p.saves).toEqual([]);
        expect(p.puts).toEqual([]);
    });

    it('a GET that fails at the network AFTER the switch does not show the new session ‘offline’', async () => {
        const p = page(B_STATE);
        const op = p.sync.pull();
        await until(() => p.gets.length > 0);
        p.acct.uid = 2; p.acct.id = idB; p.acct.epoch++;            // B signed in; A's GET then fails
        p.gets[0].reject(new TypeError('Failed to fetch'));
        await op;
        expect(p.sync.status()).toBe('idle');
        // Positive control: the same failure with NO switch is reported.
        const r = page(B_STATE);
        const op2 = r.sync.pull();
        await until(() => r.gets.length > 0);
        r.gets[0].reject(new TypeError('Failed to fetch'));
        expect(await op2).toBe('offline');
    });

    it('a PUT that fails AFTER the sign-out sets no ‘error’ and logs no warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const q = page(A_STATE);
            q.records.set(1, { rev: 1, base: EMPTY_NOTE_STATE, maxRev: 1 });
            const op = q.sync.push();
            await until(() => q.puts.length > 0);
            q.acct.uid = null; q.acct.id = null; q.acct.epoch++;
            q.puts[0].reject(new Error('500 from the server'));
            await op;
            expect(q.sync.status()).toBe('idle');
            expect(warn).not.toHaveBeenCalled();
            // Positive control: the same failure with NO sign-out is reported.
            const r = page(A_STATE);
            r.records.set(1, { rev: 1, base: EMPTY_NOTE_STATE, maxRev: 1 });
            const op2 = r.sync.push();
            await until(() => r.puts.length > 0);
            r.puts[0].reject(new Error('500 from the server'));
            expect(await op2).toBe('error');
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });

    it('the app’s instance: every sign-out moves the epoch (a logout hook), and a record names its account', async () => {
        const mod = await import('../notes/model/notesPrefsSync');
        const { runLogoutCleanups } = await import('../api/logoutHooks');
        const before = mod.notesPrefsSignOutEpoch();
        runLogoutCleanups();
        expect(mod.notesPrefsSignOutEpoch()).toBe(before + 1);
        // The app's record store refuses an account that is not the signed-in
        // one (the mocked token says 7), so a stale operation cannot re-create
        // a scrubbed record even past a missed check. (localStorage is a
        // vi.fn() mock in this suite: assert on the calls.)
        const setItem = vi.mocked(localStorage.setItem);
        setItem.mockClear();
        mod.accountRecordStore.save(1, { rev: 1, base: A_STATE, maxRev: 1 });
        expect(setItem).not.toHaveBeenCalled();
        mod.accountRecordStore.save(7, { rev: 1, base: EMPTY_NOTE_STATE, maxRev: 1 });
        expect(setItem).toHaveBeenCalledWith('pucaNotesPrefsSync:7', expect.any(String));
    });

    it('replaceNoteState with an expected account refuses any other one', async () => {
        const { replaceNoteState, getNotesPrefs } = await import('../notes/model/notesPrefs');
        replaceNoteState(EMPTY_NOTE_STATE);
        replaceNoteState(A_STATE, 1);                               // signed in as 7, not 1
        expect(getNotesPrefs().labels).toEqual({});
        replaceNoteState(B_STATE, 7);
        expect(getNotesPrefs().labels).toEqual(B_STATE.labels);
        replaceNoteState(EMPTY_NOTE_STATE);
    });
});
