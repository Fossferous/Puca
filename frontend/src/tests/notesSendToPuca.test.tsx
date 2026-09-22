/**
 * "Send to Púca…" — posting a note into a channel or a DM.
 *
 * What would have to break for these to go red:
 *  - noteToMessage writing a decrypt-failure MARKER into a message other
 *    people read (the regression that matters: noteToMarkdown does exactly
 *    that, correctly, for an export);
 *  - a clip ref keeping its payload, which IS the clip key;
 *  - the picker offering a checklist channel, a non-text channel, or one this
 *    account cannot post in (ForwardModal cannot tell — this picker can);
 *  - the channel send posting plaintext, or sending at all without a key;
 *  - the DM send going anywhere near the WebSocket;
 *  - anything at all being sent before the confirm step is pressed;
 *  - a note too long to survive the seal being discovered as a generic
 *    failure rather than said before the send;
 *  - the sheet being dismissable mid-send, which posts the note twice.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const captured = {
    channelPosts: [] as { url: string; content: string }[],
    dmPosts: [] as { url: string; content: string }[],
};
const wsSends = { count: 0 };
/** Hold the channel POST open, to test the sheet while a send is in flight. */
const hold = { on: false, release: null as null | (() => void) };
/** Make the next channel POST fail with this status (413 in particular). */
const failChannelPostWith = { status: 0 };

const serverKeys = {
    currentEpoch: 0,
    published: [] as { epoch: number; wrapped_key: string; sender_public_key: string; member_generation: number }[],
    members: [] as { user_id: number; public_key: string | null }[],
};

// If anything in this tree reaches for the socket, this records it and the
// assertion below fails — the same rule tests/notesNoSocket.test.ts enforces
// over the source text.
vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        sendDirectMessage: () => { wsSends.count++; },
        send: () => { wsSends.count++; },
    },
}));

// The server is faked at `fetch`, not at apiClient: the REAL ApiClient then
// runs, and — the reason this is not a module mock — api/dms.ts binds its
// `apiClient` before a module-level mock of api/client can reach it in this
// import graph, so a mocked client would have silently let the DM send hit
// the network and pass for the wrong reason.
function json(data: unknown): Response {
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const realFetch = globalThis.fetch;
beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
        const path = url.pathname;
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (method === 'GET') {
            if (path === '/servers') return json([{ id: 's1', name: 'Home' }]);
            if (path === '/servers/s1/channels') return json([
                { id: 10, name: 'general', channel_type: 0, has_checklist: false, my_permissions: 0b11 },
                { id: 11, name: 'groceries', channel_type: 0, has_checklist: true, my_permissions: 0b11 },
                { id: 12, name: 'lounge', channel_type: 1, has_checklist: false, my_permissions: 0b11 },
                { id: 13, name: 'announcements', channel_type: 0, has_checklist: false, my_permissions: 0b101 },
            ]);
            if (path === '/dms') return json([{
                id: 'dm1', other_user_id: 2, other_username: 'sam', other_display_name: 'Sam',
                last_message: null, last_message_at: null, created_at: '',
            }]);
            if (path.endsWith('/keys')) return json({
                current_epoch: serverKeys.currentEpoch, current_generation: 0, epoch_generation: 0,
                keys: serverKeys.published.filter(k => k.epoch === serverKeys.currentEpoch),
            });
            if (path.endsWith('/member-keys')) return json(serverKeys.members);
            if (/^\/users\/\d+\/public-key$/.test(path)) return json({ public_key: peerPublicKey });
        }
        if (method === 'POST') {
            if (path.endsWith('/keys')) {
                serverKeys.currentEpoch = body.epoch as number;
                const keys = body.keys as Array<{ recipient_id: number; wrapped_key: string; sender_public_key: string }>;
                const mine = keys.find(k => k.recipient_id === 1);
                if (mine) serverKeys.published.push({ epoch: body.epoch as number, wrapped_key: mine.wrapped_key, sender_public_key: mine.sender_public_key, member_generation: 0 });
                return json({});
            }
            if (/^\/channels\/\d+\/messages$/.test(path)) {
                if (failChannelPostWith.status) return new Response('Message too long', { status: failChannelPostWith.status });
                captured.channelPosts.push({ url: path, content: body.content as string });
                if (hold.on) await new Promise<void>(r => { hold.release = r; });
                return json({ id: 'srv-1' });
            }
            if (/^\/dms\/[^/]+\/messages$/.test(path)) {
                captured.dmPosts.push({ url: path, content: body.content as string });
                return json({ id: 'dm-msg-1' });
            }
        }
        return new Response('not found', { status: 404 });
    }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

import { setActiveIdentity, parseEnvelope, clearActiveIdentity } from '../api/e2ee';
import { clearChannelKeyCache } from '../api/channelKeys';
import { pinServedIdentityKey } from '../api/keyVerification';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';
import { ENC_KEY_UNAVAILABLE } from '../api/decryptMarkers';
import { MAX_MESSAGE_BYTES, noteToMessage, sealedMessageBytes } from '../notes/model/noteText';
import { SendToPucaSheet } from '../notes/components/SendToPucaSheet';
import type { NoteCard } from '../notes/model/notesModel';
import type { Task } from '../api/tasks';

const ME = ['me', 'a1'.repeat(16)] as const;
const PEER = ['peer', 'b2'.repeat(16)] as const;
let peerPublicKey = '';

beforeAll(() => warmIdentities([ME, PEER]), WARM_TIMEOUT_MS);

function task(id: number, description: string, extra: Partial<Task> = {}): Task {
    return {
        id, description, is_completed: false, position: id, parent_id: null,
        created_by: 1, created_at: '', attachments: null,
        ...extra,
    } as unknown as Task;
}

function makeCard(over: Partial<NoteCard> = {}): NoteCard {
    return {
        key: 'list:1',
        ref: { kind: 'list', id: 1 },
        title: 'Groceries',
        pinned: false,
        archived: false,
        color: 'default',
        labels: [],
        tasks: [task(1, 'Milk')],
        body: null,
        noteAttachments: null,
        ...over,
    } as unknown as NoteCard;
}

async function mountSheet(card: NoteCard) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const sent: string[] = [];
    const closes = { count: 0 };
    await act(async () => {
        createRoot(host).render(
            <QueryClientProvider client={qc}>
                <SendToPucaSheet card={card} onClose={() => { closes.count++; }} onSent={w => sent.push(w)} />
            </QueryClientProvider>,
        );
    });
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return { sent, closes };
}

const sendButton = () => document.querySelector('.notes-send-go') as HTMLButtonElement;
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

function targets(): string[] {
    return [...document.querySelectorAll('.notes-send-target')].map(e => (e.textContent ?? '').trim());
}

function clickTarget(label: string) {
    const el = [...document.querySelectorAll('.notes-send-target')]
        .find(e => (e.textContent ?? '').includes(label)) as HTMLButtonElement | undefined;
    if (!el) throw new Error(`no target matching ${label} (have: ${targets().join(' | ')})`);
    act(() => { el.click(); });
}

function clickSend() {
    const el = document.querySelector('.notes-send-go') as HTMLButtonElement | null;
    if (!el) throw new Error('no Send button');
    act(() => { el.click(); });
}

// A real token, not a module mock: api/dms binds `currentUserIdFromToken`
// eagerly in this import graph, so a mocked api/auth reached the sheet but
// NOT the DM seal — which failed closed and would have passed the socket
// assertion for entirely the wrong reason.
function fakeToken(sub: number, username: string): string {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, username, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

// setup.ts replaces localStorage with bare vi.fn()s that store nothing, so a
// token written there would not be readable: give this file a real one.
const store = new Map<string, string>();
beforeAll(() => {
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, v); });
    vi.mocked(localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
});

beforeEach(async () => {
    store.clear();
    store.set('auth_token', fakeToken(1, 'me'));
    document.body.innerHTML = '';
    captured.channelPosts = [];
    captured.dmPosts = [];
    wsSends.count = 0;
    hold.on = false;
    hold.release = null;
    failChannelPostWith.status = 0;
    serverKeys.currentEpoch = 0;
    serverKeys.published = [];
    clearChannelKeyCache();
    const me = await testIdentity(...ME);
    const peer = await testIdentity(...PEER);
    peerPublicKey = peer.publicKeyEncoded;
    setActiveIdentity(me);
    serverKeys.members = [{ user_id: 1, public_key: me.publicKeyEncoded }];
    await pinServedIdentityKey(2, peerPublicKey);
});

describe('noteToMessage', () => {
    it('LEAVES OUT a row this device cannot read, and counts it', () => {
        const out = noteToMessage(makeCard({ tasks: [task(1, 'Milk'), task(2, ENC_KEY_UNAVAILABLE)] }));
        expect(out.omitted).toBe(1);
        // The regression that matters: a marker must never be posted as content.
        expect(out.text).not.toContain(ENC_KEY_UNAVAILABLE);
        expect(out.text).toContain('Milk');
    });

    it('positive control: a fully readable note omits nothing and keeps every row', () => {
        const out = noteToMessage(makeCard({ tasks: [task(1, 'Milk'), task(2, 'Eggs')], body: 'from the market' }));
        expect(out.omitted).toBe(0);
        expect(out.text).toContain('Milk');
        expect(out.text).toContain('Eggs');
        expect(out.text).toContain('from the market');
        expect(out.text).toContain('# Groceries');
    });

    it('drops a clip ref’s payload — the packed manifest IS the clip key', () => {
        const out = noteToMessage(makeCard({ body: 'see sovereign-clip:v1?AAAABBBBCCCC here' }));
        expect(out.text).toContain('sovereign-clip:v1');
        expect(out.text).not.toContain('AAAABBBBCCCC');
    });

    it('names pictures instead of sending them', () => {
        const out = noteToMessage(makeCard({
            noteAttachments: JSON.stringify([{ href: 'sovereign-enc:f1?k=K&m=image/png', name: 'beach.png' }]),
        }));
        expect(out.pictures).toEqual(['beach.png']);
        expect(out.text).toContain('beach.png');
        // The ref — and its key — never rides along.
        expect(out.text).not.toContain('sovereign-enc:');
        expect(out.text).not.toContain('k=K');
    });

    it('an unreadable title becomes no heading, not a heading of the marker', () => {
        const out = noteToMessage(makeCard({ title: ENC_KEY_UNAVAILABLE }));
        expect(out.text).not.toContain(ENC_KEY_UNAVAILABLE);
        expect(out.omitted).toBeGreaterThanOrEqual(1);
    });
});

describe('how long a note can be', () => {
    it('measures the SEALED size, not the note: nonce, tag, base64 and the envelope', () => {
        // 12-byte nonce + 16-byte tag, base64'd, plus the JSON envelope.
        expect(sealedMessageBytes('')).toBe(48 + 40);
        expect(sealedMessageBytes('a'.repeat(3000))).toBeGreaterThan(4000);
        // Non-ASCII counts as its UTF-8 bytes, which is what the server counts.
        expect(sealedMessageBytes('é'.repeat(100))).toBeGreaterThan(sealedMessageBytes('e'.repeat(100)));
    });

    it('positive control: the cap is reachable from a plausible note, and 5k is not', () => {
        expect(sealedMessageBytes('a'.repeat(6000))).toBeGreaterThan(MAX_MESSAGE_BYTES);
        expect(sealedMessageBytes('a'.repeat(5000))).toBeLessThan(MAX_MESSAGE_BYTES);
    });

    it('says so at the confirm step and refuses to send, rather than failing with a shrug', async () => {
        await mountSheet(makeCard({ body: 'a'.repeat(6000) }));
        clickTarget('general');
        expect(document.querySelector('.notes-send-confirm')!.textContent).toMatch(/too long/i);
        expect(sendButton().disabled).toBe(true);
        // Forced anyway: still nothing posted.
        sendButton().disabled = false;
        clickSend();
        await settle();
        expect(captured.channelPosts).toHaveLength(0);
    });

    it('positive control: the same note just under the cap sends normally', async () => {
        await mountSheet(makeCard({ body: 'a'.repeat(5000) }));
        clickTarget('general');
        expect(document.querySelector('.notes-send-confirm')!.textContent).not.toMatch(/too long/i);
        expect(sendButton().disabled).toBe(false);
        clickSend();
        await settle();
        expect(captured.channelPosts).toHaveLength(1);
    });

    it('a 413 from the server is named for what it is, not folded into the generic failure', async () => {
        failChannelPostWith.status = 413;
        await mountSheet(makeCard());
        clickTarget('general');
        clickSend();
        await settle();
        expect(document.querySelector('.notes-send-error')!.textContent).toMatch(/too long/i);
    });
});

describe('while a send is in flight', () => {
    it('Escape and the backdrop do not dismiss the sheet — a message cannot be unsent', async () => {
        hold.on = true;
        const { closes } = await mountSheet(makeCard());
        clickTarget('general');
        clickSend();
        await settle(4);
        expect(sendButton().textContent).toMatch(/Sending/);

        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        act(() => { (document.querySelector('.notes-dialog-backdrop') as HTMLElement).click(); });
        act(() => { (document.querySelector('.notes-dialog-head button') as HTMLButtonElement).click(); });
        expect(closes.count).toBe(0);
        expect(document.querySelector('.notes-dialog')).not.toBeNull();

        hold.release?.();
        await settle(20);
        // Exactly one post, and the sheet closed itself when it was done.
        expect(captured.channelPosts).toHaveLength(1);
        expect(closes.count).toBe(1);
    });

    it('positive control: the same three gestures DO close it when nothing is in flight', async () => {
        const { closes } = await mountSheet(makeCard());
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(closes.count).toBe(1);
        act(() => { (document.querySelector('.notes-dialog-backdrop') as HTMLElement).click(); });
        expect(closes.count).toBe(2);
        act(() => { (document.querySelector('.notes-dialog-head button') as HTMLButtonElement).click(); });
        expect(closes.count).toBe(3);
    });
});

describe('the destination picker', () => {
    it('offers a text channel this account can post in, and NOTHING else', async () => {
        await mountSheet(makeCard());
        const rows = targets();
        expect(rows.some(t => t.includes('general'))).toBe(true);     // text, postable
        expect(rows.some(t => t.includes('groceries'))).toBe(false);  // has_checklist: it IS a note
        expect(rows.some(t => t.includes('lounge'))).toBe(false);     // channel_type !== 0
        expect(rows.some(t => t.includes('announcements'))).toBe(false); // no SEND_MESSAGES
        expect(rows.some(t => t.includes('Sam'))).toBe(true);         // the DM conversation
    });
});

describe('sending', () => {
    it('posts NOTHING until the confirm step is pressed, and names the destination first', async () => {
        await mountSheet(makeCard());
        clickTarget('general');
        expect(captured.channelPosts).toHaveLength(0);
        const confirm = document.querySelector('.notes-send-confirm')!.textContent ?? '';
        expect(confirm).toContain('#general');
        expect(confirm).toContain('Home');
        expect(confirm).toMatch(/read it/);
        clickSend();
        for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(captured.channelPosts).toHaveLength(1);
    });

    it('a channel send posts CIPHERTEXT, never the note’s words', async () => {
        await mountSheet(makeCard());
        clickTarget('general');
        clickSend();
        for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        const body = captured.channelPosts[0].content;
        expect(body).not.toContain('Milk');
        expect(body).not.toContain('Groceries');
        expect(parseEnvelope(body)!.t).toBe('ch');
    });

    it('FAILS CLOSED with no channel key — nothing is posted', async () => {
        clearActiveIdentity();
        clearChannelKeyCache();
        await mountSheet(makeCard());
        clickTarget('general');
        clickSend();
        for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(captured.channelPosts).toHaveLength(0);
        expect(document.querySelector('.notes-send-error')).not.toBeNull();
    });

    it('a DM send goes over REST and NEVER touches the socket', async () => {
        await mountSheet(makeCard());
        clickTarget('Sam');
        clickSend();
        for (let i = 0; i < 20; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(captured.dmPosts).toHaveLength(1);
        expect(captured.dmPosts[0].url).toBe('/dms/dm1/messages');
        expect(captured.dmPosts[0].content).not.toContain('Milk');
        expect(parseEnvelope(captured.dmPosts[0].content)).not.toBeNull();
        expect(wsSends.count).toBe(0);
    });
});
