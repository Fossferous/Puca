/**
 * A note's pictures and voice notes, and a Púca Notes card's thumbnails, hold
 * their decrypted copies the way a chat message does
 * (components/useHeldAttachmentUrl.ts): with the app in the background a
 * moment they are let go (in the Android WebView every decrypted blob beyond
 * ~1% of the RAM is a plaintext FILE in app_webview/Default/blob_storage,
 * there while the app sits in the background and after a kill), except what
 * is in use: a voice note that is playing, a picture open in the lightbox.
 *
 * Each of those was a mutation no suite caught (review, 2026-10-05): the
 * voice note's `keep: playing` or the picture's `keep: zoomed` turned off,
 * and the card's thumbnails told to keep their copy in the background.
 *
 * The REAL attachments module (fetch, AES-GCM, the cache); jsdom has no
 * Worker, so the page makes the blob: URLs itself, and `created`/`revoked`
 * are the ones it made and took back. Nothing ever plays: `play` is a DOM
 * event dispatched by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({
    wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} },
}));

import { NoteImages } from '../components/NoteImages';
import { NoteCard } from '../notes/components/NoteCard';
import { buildNoteCards } from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import type { NoteActions } from '../notes/model/notesQueries';
import type { Task } from '../api/tasks';
import { clearBlobCache, attachmentCacheStats } from '../api/attachments';
import { __resetAttachmentsAwake, __setSuspendAfterHiddenMs } from '../api/attachmentAwake';

let served: Map<string, Uint8Array>;
let requested: string[];
let created: string[];
let revoked: string[];
let seq = 0;
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
/** Serve `id` encrypted; the ref that opens it. */
async function encRef(id: string, mime: string, name: string): Promise<{ href: string; name: string }> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new Uint8Array(1000).fill(7)));
    served.set(id, cat(nonce, ct));
    const key = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { href: `sovereign-enc:${id}?k=${key}&m=${encodeURIComponent(mime)}`, name };
}

let container: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState = 'visible';

const settle = async () => {
    await act(async () => {
        for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
        for (let j = 0; j < 3; j++) {
            await new Promise(r => setTimeout(r, 5));
            for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
        }
    });
};
async function until<T>(cond: () => T, what: string): Promise<T> {
    for (let i = 0; i < 60; i++) {
        const v = cond();
        if (v) return v;
        await settle();
    }
    throw new Error(`${what} never held`);
}
/** The app goes to the background (or comes back): what the WebView reports. */
async function setVisibility(v: DocumentVisibilityState) {
    visibility = v;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
}
const srcOf = (sel: string) => document.querySelector(sel)?.getAttribute('src') ?? null;

beforeEach(() => {
    served = new Map(); requested = []; created = []; revoked = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const id = String(input).split('/files/')[1];
        requested.push(id);
        const body = served.get(id);
        return body ? new Response(body.slice()) : new Response('', { status: 404 });
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    URL.createObjectURL = (() => { const u = `blob:note-${++seq}`; created.push(u); return u; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => {
        // Never while anything on the page still uses it (the lightbox is a
        // portal: the whole document).
        expect(document.querySelector(`[src="${u}"]`), `${u} was revoked while still in the DOM`).toBeNull();
        revoked.push(u);
    }) as typeof URL.revokeObjectURL;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    __setSuspendAfterHiddenMs(0);
});

afterEach(async () => {
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
    clearBlobCache();
    delete (document as { visibilityState?: unknown }).visibilityState;
    __resetAttachmentsAwake();
    __setSuspendAfterHiddenMs(null);
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.restoreAllMocks();
});

describe("a note's own pictures and voice notes (NoteImages)", { timeout: 30000 }, () => {
    async function renderNote(...refs: Array<{ href: string; name: string }>) {
        await act(async () => { root.render(<NoteImages opened={JSON.stringify(refs)} editable={false} />); });
        await settle();
    }

    it('in the background, a voice note that is playing keeps its copy; paused, it lets go', async () => {
        await renderNote(await encRef('voice', 'audio/webm', 'voice-1.webm'), await encRef('pic', 'image/png', 'pic.png'));
        const voice = await until(() => srcOf('.ni-audio audio'), 'the voice note');
        const pic = await until(() => srcOf('.ni-open img'), 'the picture');
        await act(async () => { document.querySelector('.ni-audio audio')!.dispatchEvent(new Event('play')); });
        await setVisibility('hidden');
        // POSITIVE CONTROL: the picture beside it, not in use, was let go.
        expect(revoked).toEqual([pic]);
        expect(srcOf('.ni-audio audio')).toBe(voice);
        await act(async () => { document.querySelector('.ni-audio audio')!.dispatchEvent(new Event('pause')); });
        await settle();
        expect([...revoked].sort()).toEqual([pic, voice].sort());
        expect(attachmentCacheStats().plainBytes).toBe(0);
    });

    it('in the background, a picture open in the lightbox keeps its copy; closed, it lets go', async () => {
        await renderNote(await encRef('pic', 'image/png', 'pic.png'), await encRef('other', 'image/png', 'other.png'));
        await until(() => document.querySelectorAll('.ni-open img[src]').length === 2, 'both pictures');
        const [pic, other] = [...document.querySelectorAll('.ni-open img')].map((i) => i.getAttribute('src')!);
        await act(async () => { document.querySelector<HTMLButtonElement>('.ni-open')!.click(); });
        expect(document.querySelector('.image-lightbox')).not.toBeNull();
        await setVisibility('hidden');
        expect(revoked).toEqual([other]);
        expect(document.querySelector(`.image-lightbox [src="${pic}"]`)).not.toBeNull();
        await act(async () => { document.querySelector<HTMLButtonElement>('.image-lightbox-close')!.click(); });
        await settle();
        expect([...revoked].sort()).toEqual([pic, other].sort());
        expect(attachmentCacheStats().plainBytes).toBe(0);
    });
});

describe('a Púca Notes card (NoteCard)', { timeout: 30000 }, () => {
    const actions = { togglePin: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions;
    const task = (id: number, attachments: string): Task => ({
        id, channel_id: null, list_id: 7, parent_id: null, description: `item ${id}`, is_completed: false, position: id,
        created_at: '', created_by: 7, attachments, due_at: null,
    });

    it('lets its thumbnails and its picture go in the background, and shows them again on the way back with no download', async () => {
        const thumb = await encRef('thumb', 'image/png', 'thumb.png');
        const hero = await encRef('hero', 'image/png', 'hero.png');
        const card = buildNoteCards(
            [{ ref: { kind: 'list', id: 7 }, title: 'Trip', noteAttachments: JSON.stringify([hero]) }],
            new Map([['list:7', [task(1, JSON.stringify([thumb]))]]]), [], EMPTY_KEEP_PREFS,
        )[0];
        await act(async () => {
            root.render(
                <NoteCard
                    card={card} actions={actions} now={Date.parse('2026-10-05T10:00:00Z')} compactTools={false}
                    onOpen={() => {}} onMenu={() => {}} onPickColor={() => {}} onPickLabels={() => {}}
                    onLabelClick={() => {}} onArchive={() => {}} registerEl={() => {}}
                />,
            );
        });
        const thumbUrl = await until(() => srcOf('img.notes-thumb'), 'the thumbnail');
        const heroUrl = await until(() => srcOf('.notes-card img:not(.notes-thumb)'), 'the picture');
        await setVisibility('hidden');
        expect([...revoked].sort()).toEqual([thumbUrl, heroUrl].sort());
        expect(document.querySelectorAll('img[src]')).toHaveLength(0);
        expect(attachmentCacheStats()).toMatchObject({ plainBytes: 0, heldBytes: 0 });
        await setVisibility('visible');
        await until(() => srcOf('img.notes-thumb') && srcOf('.notes-card img:not(.notes-thumb)'), 'both shown again');
        expect(requested.sort()).toEqual(['hero', 'thumb']);
    });
});
