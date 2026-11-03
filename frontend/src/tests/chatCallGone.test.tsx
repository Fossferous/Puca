/**
 * How a call ends when nobody hung up: a kick from a server, a channel deleted, View
 * taken away. Through the real Chat and real frames, with the real voiceState behind
 * it. VoicePanel is not mountable under vitest (quickGoLive.test.tsx), so it is a stand-in
 * that says when it mounts and unmounts: which call is up is what these ask about.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FakeStreamAudioContext } from './fixtures/fakeStreamAudio';

const ME = 1;

const h = vi.hoisted(() => ({
    servers: [] as Record<string, unknown>[],
    channels: [] as Record<string, unknown>[],
    /** Each mount and unmount of the voice panel, in order. */
    panels: [] as string[],
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => `h.${btoa(JSON.stringify({ sub: ME, username: 'me' })).replace(/=+$/, '')}.s`,
    currentUserIdFromToken: () => ME,
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));
vi.mock('../components/VoicePanel', () => ({
    VoicePanel: ({ roomId }: { roomId: string }) => {
        useEffect(() => {
            h.panels.push(`mount ${roomId}`);
            return () => { h.panels.push(`unmount ${roomId}`); };
        }, [roomId]);
        return <i data-testid="voice-panel-stand-in" data-room={roomId} />;
    },
}));
vi.mock('../components/VoiceStage', () => ({ VoiceStage: () => <div data-testid="voice-stage" /> }));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);
vi.stubGlobal('AudioContext', FakeStreamAudioContext);

const row = (id: number, name: string, serverId: string, channelType = 0) =>
    ({ id, name, channel_type: channelType, server_id: serverId, my_permissions: 0x7fffffff });
const server = (id: string, name: string) => ({ id, name, owner_id: ME + 1, created_at: '2026-10-01T00:00:00Z' });

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, h.servers);
    const list = /\/servers\/([^/]+)\/channels$/.exec(u);
    if (list) return reply(200, h.channels.filter(c => c.server_id === list[1]));
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { wsClient } = await import('../api/websocket');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let frames: Record<string, ((m: Frame) => void)[]> = {};

beforeEach(() => {
    frames = {};
    h.panels = [];
    h.servers = [server('s1', 'Near'), server('s2', 'Far')];
    h.channels = [
        row(10, 'general', 's1'),
        row(15, 'Lounge', 's1', 1),
        row(30, 'far-general', 's2'),
        row(31, 'Far room', 's2', 1),
    ];
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    const on = wsClient.on.bind(wsClient);
    vi.spyOn(wsClient, 'on').mockImplementation((type, handler) => {
        (frames[type] ??= []).push(handler as unknown as (m: Frame) => void);
        return on(type, handler);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    vi.restoreAllMocks();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const settled = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await settle(); };
const headerText = () => document.querySelector('.chat-header')?.textContent ?? '';
const roomUp = () => document.querySelector('[data-testid="voice-panel-stand-in"]')?.getAttribute('data-room') ?? null;

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 60 && !headerText().includes('general'); i++) await settle();
    expect(headerText(), 'the landing channel opened').toContain('general');
}

async function goToServer(name: string, landing: string) {
    await act(async () => { document.querySelector<HTMLElement>(`.server-icon[title="${name}"]`)!.click(); });
    for (let i = 0; i < 60 && !headerText().includes(landing); i++) await settle();
    expect(headerText()).toContain(landing);
}

async function joinRoom(id: number) {
    let voiceRow: HTMLElement | null = null;
    for (let i = 0; i < 60 && !(voiceRow = document.querySelector<HTMLElement>(`[data-testid="voice-channel"][data-channel-id="${id}"]`)); i++) await settle();
    expect(voiceRow, `the voice row of ${id} is listed`).toBeTruthy();
    await act(async () => { voiceRow!.click(); });
    for (let i = 0; i < 40 && roomUp() !== `voice_${id}`; i++) await settle();
    expect(roomUp()).toBe(`voice_${id}`);
}

const removedFrom = async (serverId: string) => {
    await act(async () => { for (const f of frames.RemovedFromServer) f({ type: 'RemovedFromServer', payload: { server_id: serverId } }); });
    await settled();
};

describe('a kick or ban ends a call on that server, and no other', () => {
    it('removed from the server on screen, in a call on ANOTHER server: that call goes on', async () => {
        await mountChat();
        await goToServer('Far', 'far-general');
        await joinRoom(31);
        await goToServer('Near', 'general');
        expect(roomUp(), 'CONTROL: looking at another server keeps the call').toBe('voice_31');
        h.servers = [server('s2', 'Far')];
        await removedFrom('s1');
        expect(document.querySelector('.server-icon[title="Near"]'), 'the server they were removed from has gone').toBeNull();
        expect(roomUp()).toBe('voice_31');
        expect(h.panels).toEqual(['mount voice_31']);
    });

    it('CONTROL: removed from the server on screen, in a call on it: that call ends', async () => {
        await mountChat();
        await joinRoom(15);
        h.servers = [server('s2', 'Far')];
        await removedFrom('s1');
        expect(roomUp()).toBeNull();
        expect(h.panels).toEqual(['mount voice_15', 'unmount voice_15']);
    });

    it('CONTROL: removed from a server NOT on screen: nothing here moves (the server\'s RoomLeft ends a call on it)', async () => {
        await mountChat();
        await joinRoom(15);
        h.servers = [server('s1', 'Near')];
        await removedFrom('s2');
        expect(headerText()).toContain('general');
        expect(roomUp()).toBe('voice_15');
    });
});
