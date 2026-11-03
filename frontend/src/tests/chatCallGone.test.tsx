/**
 * How a call ends when nobody hung up: a kick from a server, a channel deleted, View
 * taken away. Through the real Chat and real frames, with the real voiceState and the
 * real StreamStage behind it. VoicePanel is not mountable under vitest
 * (quickGoLive.test.tsx), so it is a stand-in that says when it mounts and unmounts:
 * which call is up, and what is still being watched once it is not, is what these ask
 * about. Its real unmount closes the media and touches none of the stream state.
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
    /** A touch screen narrow enough for the phone layout (Chat's isMobile). */
    coarse: false,
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
vi.mock('../components/VoicePanel', async () => {
    const { clearAllStreams: leaveVoiceClears } = await import('../components/voiceState');
    return {
        VoicePanel: ({ roomId, onDisconnect }: { roomId: string; onDisconnect: () => void }) => {
            useEffect(() => {
                h.panels.push(`mount ${roomId}`);
                return () => { h.panels.push(`unmount ${roomId}`); };
            }, [roomId]);
            // Pressed, it hangs up as the real leaveVoice does.
            return <button data-testid="voice-panel-stand-in" data-room={roomId} onClick={() => { leaveVoiceClears(); onDisconnect(); }} />;
        },
    };
});
vi.mock('../components/VoiceStage', () => ({ VoiceStage: () => <div data-testid="voice-stage" /> }));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
        matches: h.coarse && q === '(pointer: coarse) and (max-width: 1024px)',
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);
vi.stubGlobal('AudioContext', FakeStreamAudioContext);
// jsdom's video plays nothing and answers with no promise; the stage asks for one.
HTMLMediaElement.prototype.play = async function play() {};

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
const { clearAllStreams, getAllStreamers, getSelectedStreams, globalStreamData, notifyVoiceUsersChange, selectStream } = await import('../components/voiceState');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let frames: Record<string, ((m: Frame) => void)[]> = {};

beforeEach(() => {
    frames = {};
    h.panels = [];
    h.coarse = false;
    clearAllStreams();
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

const BOB = 5;
/** Watching Bob's share on the stage, as the panel leaves it for the rest of the app. */
async function watchBob() {
    const stream = new MediaStream();
    stream.addTrack({ kind: 'video', id: 'v-5' } as MediaStreamTrack);
    globalStreamData.set(BOB, { username: 'bob', stream });
    await act(async () => { selectStream(BOB); });
    for (let i = 0; i < 40 && !stageUp(); i++) await settle();
    expect(stageUp(), 'CONTROL: the stage is up').toBe(true);
}
const stageUp = () => !!document.querySelector('.stream-stage');
const toasts = () => [...document.querySelectorAll('.app-toast-text')].map(t => t.textContent);
const frame = async (type: string, payload: unknown) => {
    await act(async () => { for (const f of frames[type] ?? []) f({ type, payload }); });
    await settled();
};
/** What the server lists now, and the frame every member gets after a delete. */
async function goneFromTheList(id: number, serverId: string, type = 'ChannelUpdated') {
    h.channels = h.channels.filter(c => c.id !== id);
    await frame(type, { server_id: serverId });
}
const nothingWatched = () => {
    expect(stageUp(), 'the stage is down').toBe(false);
    expect(getSelectedStreams()).toEqual([]);
    expect(getAllStreamers()).toEqual([]);
    expect(document.body.textContent, 'no stale Watch Streams').not.toContain('Watch Streams');
};

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

describe('a call that ends with nobody hanging up takes what it was watching with it, and says so', () => {
    const SAID = 'Lounge is no longer available, so you left its call.';

    it('the room deleted while watching a stream: out of the stage, nothing stale left, and one toast', async () => {
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await goneFromTheList(15, 's1');
        expect(roomUp()).toBeNull();
        nothingWatched();
        expect(headerText(), 'back in the chat').toContain('general');
        expect(toasts()).toEqual([SAID]);
    });

    it('View of the room taken away is the same', async () => {
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await goneFromTheList(15, 's1', 'ChannelPermsChanged');
        expect(roomUp()).toBeNull();
        nothingWatched();
        expect(toasts()).toEqual([SAID]);
    });

    it('with no stream open, it still says so', async () => {
        await mountChat();
        await joinRoom(15);
        await goneFromTheList(15, 's1');
        expect(roomUp()).toBeNull();
        expect(toasts()).toEqual([SAID]);
    });

    it('a call on a server not on screen has its own list, and is the same', async () => {
        await mountChat();
        await goToServer('Far', 'far-general');
        await joinRoom(31);
        await goToServer('Near', 'general');
        await watchBob();
        await goneFromTheList(31, 's2');
        expect(roomUp()).toBeNull();
        nothingWatched();
        expect(toasts()).toEqual(['Far room is no longer available, so you left its call.']);
    });

    it('a kick while watching: the stage goes with the call', async () => {
        await mountChat();
        await joinRoom(15);
        await watchBob();
        h.servers = [server('s2', 'Far')];
        await removedFrom('s1');
        expect(roomUp()).toBeNull();
        nothingWatched();
    });

    it('moved to another room while watching: no stage with a header and no tiles, and the voice view instead', async () => {
        h.channels.push(row(16, 'Annex', 's1', 1));
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await frame('VoiceMoved', { from_channel_id: 15, channel_id: 16, server_id: 's1', moved_by: 'mod' });
        expect(roomUp()).toBe('voice_16');
        expect(h.panels).toEqual(['mount voice_15', 'unmount voice_15', 'mount voice_16']);
        nothingWatched();
        expect(document.querySelector('[data-testid="voice-stage"]'), 'the new call\'s tiles').not.toBeNull();
    });

    it('their own click on another room is the same: the old call\'s share is not this one\'s', async () => {
        h.channels.push(row(16, 'Annex', 's1', 1));
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await joinRoom(16);
        nothingWatched();
    });

    it('CONTROL: a hang-up says nothing', async () => {
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="voice-panel-stand-in"]')!.click(); });
        await settled();
        expect(roomUp()).toBeNull();
        nothingWatched();
        expect(toasts()).toEqual([]);
    });

    it('CONTROL: another channel deleted: the call and the stage stay, and nothing is said', async () => {
        h.channels.push(row(16, 'Annex', 's1', 1));
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await goneFromTheList(16, 's1');
        expect(roomUp()).toBe('voice_15');
        expect(stageUp()).toBe(true);
        expect(getSelectedStreams()).toEqual([BOB]);
        expect(toasts()).toEqual([]);
    });

    it('CONTROL: another server\'s channel deleted, same', async () => {
        h.channels.push(row(32, 'Far annex', 's2', 1));
        await mountChat();
        await goToServer('Far', 'far-general');
        await joinRoom(31);
        await goToServer('Near', 'general');
        await watchBob();
        await goneFromTheList(32, 's2');
        expect(roomUp()).toBe('voice_31');
        expect(getSelectedStreams()).toEqual([BOB]);
        expect(toasts()).toEqual([]);
    });

    it('CONTROL: browsing to another server keeps the call and the stream', async () => {
        await mountChat();
        await joinRoom(15);
        await watchBob();
        await goToServer('Far', 'far-general');
        expect(roomUp()).toBe('voice_15');
        expect(getSelectedStreams()).toEqual([BOB]);
        expect(h.panels).toEqual(['mount voice_15']);
    });

    // The one remount that is not the end of a call: on a touch screen crossing the phone
    // layout's width (a tablet turned sideways), the panel moves in and out of its portal
    // to <body>, which React can only do by remounting it. It rejoins the SAME room, and
    // the share comes back to the stage. So the stream state cannot go on the panel's unmount.
    it('CONTROL: a layout change remounts the panel in the same call, and what is watched stays', async () => {
        await mountChat();
        await joinRoom(15);
        await watchBob();
        h.coarse = true;
        await act(async () => { notifyVoiceUsersChange(); });
        await settled();
        expect(h.panels, 'it really did remount').toEqual(['mount voice_15', 'unmount voice_15', 'mount voice_15']);
        expect(roomUp()).toBe('voice_15');
        expect(stageUp()).toBe(true);
        expect(getSelectedStreams()).toEqual([BOB]);
        expect(toasts()).toEqual([]);
    });
});
