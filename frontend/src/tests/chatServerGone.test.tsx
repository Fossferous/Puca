/**
 * A server going when no moderator did it: its owner disbanded it, or this account left
 * it on another device (RemovedFromServer with a `reason`, src/protocol.rs). Through the
 * real Chat and real frames, with a stand-in VoicePanel that says when it mounts and
 * unmounts (chatCallGone.test.tsx says why). A kick and the words kept in the box have
 * tests of their own there and in chatUnsentWhenGone.test.tsx; here, what is different.
 *
 * The device that pressed Leave or Disband hears the frame as well, and it and the answer
 * come over two connections in either order. Both orders are here, because the frame goes
 * home and the answer goes on to the next server.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { mountAppDialogs } from './appDialogsHost';

const ME = 1;

const h = vi.hoisted(() => ({
    servers: [] as Record<string, unknown>[],
    channels: [] as Record<string, unknown>[],
    panels: [] as string[],
    /** The answer to a Leave or a Disband is on its way until this settles. */
    answer: null as null | Promise<void>,
    answerStatus: 200,
    asked: [] as string[],
    /** Server ids this person muted (the test setup's localStorage keeps nothing). */
    muted: new Set<string>(),
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
vi.mock('../components/mutedServersStore', async importOriginal => ({
    ...(await importOriginal<typeof import('../components/mutedServersStore')>()),
    isServerMuted: (id: string) => h.muted.has(id),
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
        return <div data-testid="voice-panel-stand-in" data-room={roomId} />;
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

const row = (id: number, name: string, serverId: string, channelType = 0) =>
    ({ id, name, channel_type: channelType, server_id: serverId, my_permissions: 0x7fffffff });
const server = (id: string, name: string, ownerId = ME + 1) => ({ id, name, owner_id: ownerId, created_at: '2026-10-01T00:00:00Z' });
const NEAR = server('s1', 'Near');
const FAR = server('s2', 'Far');
const MINE = server('s3', 'Mine', ME);

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE' || (init?.method === 'POST' && /leave$/.test(u))) {
        h.asked.push(u.slice(u.indexOf('/', 8)));
        if (h.answer) await h.answer;
        if (h.answerStatus >= 400) return reply(h.answerStatus, { error: 'no' });
        const gone = /\/servers\/([^/]+)(\/leave)?$/.exec(u);
        if (gone) h.servers = h.servers.filter(s => s.id !== gone[1]);
        return reply(200, {});
    }
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, h.servers);
    const list = /\/servers\/([^/]+)\/channels$/.exec(u);
    if (list) return reply(200, h.channels.filter(c => c.server_id === list[1]));
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { wsClient } = await import('../api/websocket');
const { keys } = await import('../hooks/queries');
const { MODES_CHANGED_EVENT } = await import('../api/serverModes');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let queryClient: QueryClient;
let frames: Record<string, ((m: Frame) => void)[]> = {};
let dialogs: ReturnType<typeof mountAppDialogs>;

beforeEach(() => {
    dialogs = mountAppDialogs();
    frames = {};
    h.panels = [];
    h.asked = [];
    h.answer = null;
    h.answerStatus = 200;
    h.muted = new Set();
    h.servers = [NEAR, FAR, MINE];
    h.channels = [
        row(10, 'general', 's1'),
        row(15, 'Lounge', 's1', 1),
        row(30, 'far-general', 's2'),
        row(31, 'Far room', 's2', 1),
        row(40, 'mine-general', 's3'),
    ];
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const on = wsClient.on.bind(wsClient);
    vi.spyOn(wsClient, 'on').mockImplementation((type, handler) => {
        (frames[type] ??= []).push(handler as unknown as (m: Frame) => void);
        return on(type, handler);
    });
    // Off as well as on: a handler keeps the server it was registered for, and one left
    // behind here would answer for a server nobody is looking at any more.
    const off = wsClient.off.bind(wsClient);
    vi.spyOn(wsClient, 'off').mockImplementation((type, handler) => {
        frames[type] = (frames[type] ?? []).filter(f => f !== (handler as unknown));
        return off(type, handler);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    dialogs.unmount();
    vi.restoreAllMocks();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const settled = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await settle(); };
const headerText = () => document.querySelector('.chat-header')?.textContent ?? '';
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea.message-textarea');
const roomUp = () => document.querySelector('[data-testid="voice-panel-stand-in"]')?.getAttribute('data-room') ?? null;
const toasts = () => [...document.querySelectorAll('.app-toast-text')].map(t => t.textContent);
const onHome = () => !!document.querySelector('.friends-dashboard');
const icon = (name: string) => document.querySelector<HTMLElement>(`.server-icon[title="${name}"]`);

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={queryClient}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 60 && !headerText().includes('general'); i++) await settle();
    expect(headerText(), 'the landing channel opened').toContain('general');
}

async function goToServer(name: string, landing: string) {
    await act(async () => { icon(name)!.click(); });
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

async function write(words: string) {
    const box = composer()!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(composer()!.value).toBe(words);
}

/** What the server now lists, and the frame it sends. */
async function gone(serverId: string, reason?: string) {
    h.servers = h.servers.filter(s => s.id !== serverId);
    await act(async () => { for (const f of frames.RemovedFromServer) f({ type: 'RemovedFromServer', payload: { server_id: serverId, ...(reason ? { reason } : {}) } }); });
    await settled();
}

/** The rail's own menu: `item` pressed, and the confirm it asks answered yes. */
async function press(name: string, item: RegExp) {
    await act(async () => { icon(name)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const found = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(el => item.test(el.textContent?.trim() ?? ''));
    expect(found, `the server's menu has ${item}`).toBeTruthy();
    await act(async () => { found!.click(); });
    await settle();
}

const holdTheAnswer = () => {
    let release!: () => void;
    h.answer = new Promise<void>(r => { release = r; });
    return async () => {
        await act(async () => { release(); });
        await settled();
    };
};

describe('a disband, seen by a member', () => {
    it('on the server, words in the box: it says so, goes home, and the words are in a notice', async () => {
        await mountChat();
        await write('for the people of Near');
        await gone('s1', 'disbanded');
        expect(toasts()).toEqual(['Near was disbanded by its owner.']);
        expect(onHome()).toBe(true);
        expect(icon('Near')).toBeNull();
        const notices = dialogs.notices();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('What you wrote in #general:\nfor the people of Near');
        expect(composer()!.value, 'the next conversation\'s box').toBe('');
        expect(document.body.textContent).not.toMatch(/kicked|banned|removed from/i);
    });

    it('in a call on it, on the server: the call ends, and one toast says why', async () => {
        await mountChat();
        await joinRoom(15);
        await gone('s1', 'disbanded');
        expect(roomUp()).toBeNull();
        expect(h.panels).toEqual(['mount voice_15', 'unmount voice_15']);
        expect(toasts()).toEqual(['Near was disbanded by its owner, so this call ended.']);
        expect(onHome()).toBe(true);
    });

    it('in a call on it, looking at another server: the call ends and says why, and they stay where they are', async () => {
        await mountChat();
        await joinRoom(15);
        await goToServer('Far', 'far-general');
        expect(roomUp(), 'CONTROL: looking at another server keeps the call').toBe('voice_15');
        await write('for the people of Far');
        await gone('s1', 'disbanded');
        expect(roomUp()).toBeNull();
        expect(toasts()).toEqual(['Near was disbanded by its owner, so this call ended.']);
        expect(headerText()).toContain('far-general');
        expect(onHome()).toBe(false);
        expect(composer()!.value, 'the words are theirs to keep here').toBe('for the people of Far');
        expect(dialogs.notices()).toEqual([]);
    });

    it('CONTROL: on the server, in a call on ANOTHER: that call goes on and nothing says it ended', async () => {
        await mountChat();
        await goToServer('Far', 'far-general');
        await joinRoom(31);
        await goToServer('Near', 'general');
        await gone('s1', 'disbanded');
        expect(roomUp()).toBe('voice_31');
        expect(h.panels).toEqual(['mount voice_31']);
        expect(toasts()).toEqual(['Near was disbanded by its owner.']);
        expect(onHome()).toBe(true);
    });

    it('a server they are not on and not in a call on: it goes from the rail, says so, and nothing here moves', async () => {
        await mountChat();
        await write('for the people of Near');
        await gone('s2', 'disbanded');
        expect(icon('Far')).toBeNull();
        expect(toasts()).toEqual(['Far was disbanded by its owner.']);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('for the people of Near');
        expect(dialogs.notices()).toEqual([]);
    });

    it('a server they muted, not on screen, stays quiet; on screen it still says', async () => {
        await mountChat();
        h.muted = new Set(['s1', 's2']);
        await gone('s2', 'disbanded');
        expect(icon('Far')).toBeNull();
        expect(toasts(), 'nothing they were doing is affected').toEqual([]);
        await gone('s1', 'disbanded');
        expect(toasts(), 'they were looking at it').toEqual(['Near was disbanded by its owner.']);
    });

    it('a server this account owns says it was them, on another device', async () => {
        await mountChat();
        await gone('s3', 'disbanded');
        expect(toasts()).toEqual(['You disbanded Mine on another device.']);
    });
});

describe('a leave on another device', () => {
    it('on the server, words in the box: it says so, goes home, and the words are in a notice', async () => {
        await mountChat();
        await write('for the people of Near');
        await gone('s1', 'left');
        expect(toasts()).toEqual(['You left Near on another device.']);
        expect(onHome()).toBe(true);
        expect(dialogs.notices()).toHaveLength(1);
        expect(dialogs.notices()[0]).toContain('for the people of Near');
    });

    it('in a call on it: the call ends and says why', async () => {
        await mountChat();
        await joinRoom(15);
        await gone('s1', 'left');
        expect(roomUp()).toBeNull();
        expect(toasts()).toEqual(['You left Near on another device, so this call ended.']);
    });

    it('CONTROL: in a call on another server: it goes on', async () => {
        await mountChat();
        await goToServer('Far', 'far-general');
        await joinRoom(31);
        await gone('s1', 'left');
        expect(roomUp()).toBe('voice_31');
        expect(toasts()).toEqual(['You left Near on another device.']);
    });
});

describe('CONTROL: a kick has no reason, and still says nothing', () => {
    it('on the server, in a call on it', async () => {
        await mountChat();
        await joinRoom(15);
        await gone('s1');
        expect(roomUp()).toBeNull();
        expect(onHome()).toBe(true);
        expect(toasts()).toEqual([]);
    });
});

describe('the device that pressed', () => {
    it('Leave, the frame first: nothing moves until the answer, then on to the next server, and nothing says what it just did', async () => {
        await mountChat();
        await write('for the people of Near');
        const release = holdTheAnswer();
        await press('Near', /^leave/i);
        await gone('s1', 'left');
        expect(onHome(), 'the frame takes nobody home from here').toBe(false);
        expect(headerText(), 'still where they were').toContain('general');
        expect(icon('Near'), 'the row goes with the answer').not.toBeNull();
        await release();
        for (let i = 0; i < 40 && !headerText().includes('far-general'); i++) await settle();
        expect(headerText()).toContain('far-general');
        expect(onHome()).toBe(false);
        expect(icon('Near')).toBeNull();
        expect(toasts()).toEqual([]);
        expect(dialogs.notices()).toHaveLength(1);
        expect(dialogs.notices()[0]).toContain('for the people of Near');
        expect(composer()!.value).toBe('');
    });

    it('Leave, the answer first: the same, and the frame after it says nothing', async () => {
        await mountChat();
        await write('for the people of Near');
        await press('Near', /^leave/i);
        for (let i = 0; i < 40 && !headerText().includes('far-general'); i++) await settle();
        expect(headerText()).toContain('far-general');
        await gone('s1', 'left');
        expect(headerText(), 'stays').toContain('far-general');
        expect(onHome()).toBe(false);
        expect(toasts()).toEqual([]);
        expect(dialogs.notices()).toHaveLength(1);
    });

    it('Disband, the frame first: the same', async () => {
        h.servers = [MINE, FAR];
        h.channels = [row(40, 'general', 's3'), row(41, 'Mine room', 's3', 1), row(30, 'far-general', 's2')];
        await mountChat();
        await joinRoom(41);
        const release = holdTheAnswer();
        await press('Mine', /^disband/i);
        await gone('s3', 'disbanded');
        expect(onHome()).toBe(false);
        await release();
        for (let i = 0; i < 40 && !headerText().includes('far-general'); i++) await settle();
        expect(headerText()).toContain('far-general');
        expect(roomUp(), 'its call ends with it').toBeNull();
        expect(toasts(), 'theirs to know').toEqual([]);
    });

    it('in a call on it, the answer first: the call ends here, whatever a server of any age sends', async () => {
        await mountChat();
        await joinRoom(15);
        await press('Near', /^leave/i);
        for (let i = 0; i < 40 && roomUp() !== null; i++) await settle();
        expect(roomUp()).toBeNull();
        expect(toasts(), 'not the room-gone toast either: nobody needs telling').toEqual([]);
    });

    it('the frame came and the answer was lost: it happened, so no failure is claimed', async () => {
        await mountChat();
        h.answerStatus = 502;
        const release = holdTheAnswer();
        await press('Near', /^leave/i);
        await gone('s1', 'left');
        await release();
        for (let i = 0; i < 40 && !headerText().includes('far-general'); i++) await settle();
        expect(headerText()).toContain('far-general');
        expect(window.alert).not.toHaveBeenCalled();
        expect(dialogs.notices().join(' ')).not.toContain('Failed');
    });

    it('CONTROL: refused and no frame: it says it failed, stays where it was, and a later frame is another device\'s', async () => {
        await mountChat();
        h.answerStatus = 500;
        await press('Near', /^leave/i);
        await settled();
        expect(dialogs.notices().concat((window.alert as unknown as { mock: { calls: string[][] } }).mock.calls.flat())).toContain('Failed to leave server');
        expect(headerText()).toContain('general');
        expect(icon('Near')).not.toBeNull();
        h.answerStatus = 200;
        await gone('s1', 'left');
        expect(toasts()).toEqual(['You left Near on another device.']);
        expect(onHome()).toBe(true);
    });
});

describe('no frame reached this device', () => {
    const refreshTheList = async () => {
        await act(async () => { await queryClient.invalidateQueries({ queryKey: keys.servers }); });
        await settled();
    };

    it('a call on a server not on screen ends when the list no longer has it, and says the room is gone', async () => {
        await mountChat();
        await joinRoom(15);
        await goToServer('Far', 'far-general');
        h.servers = [FAR, MINE];
        await refreshTheList();
        expect(roomUp()).toBeNull();
        expect(toasts()).toEqual(['Lounge is no longer available, so you left its call.']);
        expect(headerText()).toContain('far-general');
    });

    it('CONTROL: another server leaving the list leaves the call alone', async () => {
        await mountChat();
        await joinRoom(15);
        h.servers = [NEAR, MINE];
        await refreshTheList();
        expect(roomUp()).toBe('voice_15');
        expect(toasts()).toEqual([]);
    });

    it('the server says so on waking (RoomLeft room_gone): that call says why, and any other RoomLeft does not', async () => {
        await mountChat();
        await joinRoom(15);
        const roomLeft = async (payload: Record<string, unknown>) => {
            await act(async () => { for (const f of frames.RoomLeft) f({ type: 'RoomLeft', payload }); });
            await settle();
        };
        await roomLeft({ room_id: 'voice_15' });
        expect(toasts(), 'CONTROL: a plain RoomLeft').toEqual([]);
        await roomLeft({ room_id: 'voice_99', reason: 'room_gone' });
        expect(toasts(), 'CONTROL: a room this call is not in').toEqual([]);
        await roomLeft({ room_id: 'voice_15', reason: 'room_gone' });
        expect(toasts()).toEqual(['Lounge is no longer available, so you left its call.']);
    });
});

describe('what was open over it', () => {
    it('the invite dialog goes with the server and does not open over the next one', async () => {
        await mountChat();
        await press('Near', /^invite people/i);
        expect(document.querySelector('.invite-modal'), 'CONTROL: it was open').not.toBeNull();
        await gone('s1', 'disbanded');
        expect(document.querySelector('.invite-modal')).toBeNull();
        await goToServer('Far', 'far-general');
        expect(document.querySelector('.invite-modal'), 'the next server').toBeNull();
    });

    it('CONTROL: another server going leaves the dialog open over the one on screen', async () => {
        await mountChat();
        await press('Near', /^invite people/i);
        expect(document.querySelector('.invite-modal')).not.toBeNull();
        await gone('s2', 'disbanded');
        expect(document.querySelector('.invite-modal')).not.toBeNull();
    });
});

describe('Notes, with a query client of its own', () => {
    const heard = () => {
        const told = vi.fn();
        window.addEventListener(MODES_CHANGED_EVENT, told);
        return told;
    };

    it('is told a server went on another device or under them, and when this device pressed', async () => {
        await mountChat();
        const told = heard();
        await gone('s2', 'disbanded');
        expect(told).toHaveBeenCalledTimes(1);
        await press('Near', /^leave/i);
        for (let i = 0; i < 40 && icon('Near'); i++) await settle();
        expect(icon('Near')).toBeNull();
        expect(told).toHaveBeenCalledTimes(2);
        window.removeEventListener(MODES_CHANGED_EVENT, told);
    });
});
