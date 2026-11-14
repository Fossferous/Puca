// @vitest-environment jsdom
/**
 * "You're in <channel> on your PC — Leave / Move here": the client half of the
 * wire contract and its capability gate.
 *
 * The gate is the point. An old server answers an unknown client frame with an
 * Error, and the stock client turns every Error into an alert() — a native
 * modal in the desktop app. So nothing here may send LeaveOwnVoice, or ask for
 * a take-over, until THIS socket has received OwnVoiceState: that frame is
 * only ever sent by a server that understands both. A new socket (a reconnect,
 * possibly to an older rollback host) starts unsupported again.
 *
 * The frames come from `fixtures/ownVoiceState.json`, the same file the
 * server's `own_voice_wire_tests` serializes against.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fixture from './fixtures/ownVoiceState.json';
import { wsClient } from '../api/websocket';
import { resetEmbedHostForTest } from '../api/embedHost';
import {
    callOnOtherDevice,
    carriedFromOtherDevice,
    currentClientForm,
    getOwnVoiceSnapshot,
    nameDevice,
    ownVoiceBannerText,
    parseOwnVoiceState,
    resetOwnVoice,
    roomLeftNotice,
    shouldTakeOver,
    whereDevice,
} from '../api/ownVoice';

type Frame = { type: string; payload?: Record<string, unknown> };
const [ELSEWHERE, NONE, ROOM_LEFT_MOVED, ROOM_LEFT_PLAIN, ON_TABLET, ROOM_LEFT_BY_TABLET] = fixture as Frame[];

/** A socket stand-in that records what the client sends. */
class FakeSocket {
    static last: FakeSocket | null = null;
    static OPEN = 1;
    readyState = 0;
    sent: Frame[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    url: string;
    protocols: string[];
    constructor(url: string, protocols: string[]) {
        this.url = url;
        this.protocols = protocols;
        FakeSocket.last = this;
    }
    send(text: string) {
        this.sent.push(JSON.parse(text));
    }
    close() {
        this.readyState = 3;
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    deliver(frame: Frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

beforeEach(() => {
    FakeSocket.last = null;
    vi.stubGlobal('WebSocket', Object.assign(FakeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }));
    resetOwnVoice();
});

afterEach(() => {
    wsClient.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function openSocket(): Promise<FakeSocket> {
    const p = wsClient.connect('token');
    const sock = FakeSocket.last!;
    sock.open();
    await p;
    return sock;
}

describe('OwnVoiceState parsing (the pinned fixture)', () => {
    it('reads the call-elsewhere frame', () => {
        expect(parseOwnVoiceState(ELSEWHERE.payload)).toEqual({
            roomId: 'voice_42',
            channelId: 42,
            serverId: '5f1d2c3e-0000-4000-8000-000000000042',
            channelName: 'Lounge',
            serverName: 'Friends',
            here: false,
            device: 'desktop',
            deviceForm: null,
            selfMuted: true,
            deafened: false,
        });
    });

    it('reads the not-in-voice frame', () => {
        expect(parseOwnVoiceState(NONE.payload)).toEqual({
            roomId: null, channelId: null, serverId: null, channelName: null, serverName: null, here: false, device: null,
            deviceForm: null, selfMuted: null, deafened: null,
        });
    });

    it('reads a call on a TABLET: mobile, with the form beside it', () => {
        expect(parseOwnVoiceState(ON_TABLET.payload)).toMatchObject({ device: 'mobile', deviceForm: 'tablet' });
        // A server from before the form sends no key: a phone, as it always was.
        const { device_form: _f, ...older } = ON_TABLET.payload as Record<string, unknown>;
        expect(parseOwnVoiceState(older)).toMatchObject({ device: 'mobile', deviceForm: null });
        // Only the exact word, and only beside `mobile`.
        expect(parseOwnVoiceState({ ...ON_TABLET.payload, device_form: 'Tablet' })?.deviceForm).toBeNull();
        expect(parseOwnVoiceState({ ...ON_TABLET.payload, device_form: 7 })?.deviceForm).toBeNull();
        expect(parseOwnVoiceState({ ...ELSEWHERE.payload, device_form: 'tablet' })?.deviceForm, 'a desktop is not a tablet').toBeNull();
    });

    it("reads the call's mute and deafen only when they are real booleans", () => {
        // A server from before 0.9.839 sends neither key: unknown, never "unmuted".
        const { self_muted: _s, deafened: _d, ...older } = ELSEWHERE.payload as Record<string, unknown>;
        const old = parseOwnVoiceState(older);
        expect(old?.selfMuted).toBeNull();
        expect(old?.deafened).toBeNull();
        const odd = parseOwnVoiceState({ ...ELSEWHERE.payload, self_muted: 'true', deafened: 1 });
        expect(odd?.selfMuted).toBeNull();
        expect(odd?.deafened).toBeNull();
        expect(parseOwnVoiceState({ ...ELSEWHERE.payload, self_muted: false, deafened: true })).toMatchObject({ selfMuted: false, deafened: true });
    });

    it('refuses junk rather than inventing a call', () => {
        expect(parseOwnVoiceState(null)).toBeNull();
        expect(parseOwnVoiceState({ room_id: 7, here: false })).toBeNull();
        expect(parseOwnVoiceState({ room_id: 'voice_1', here: 'no' })).toBeNull();
        // An unknown device kind is not trusted as a label.
        expect(parseOwnVoiceState({ ...ELSEWHERE.payload, device: 'toaster' })?.device).toBeNull();
    });
});

describe('the capability gate: nothing new is sent before this socket saw OwnVoiceState', () => {
    it('announces the capability and the device kind on the WebSocket URL', async () => {
        const sock = await openSocket();
        const url = new URL(sock.url);
        // ONE caps list carrying every capability: the server reads `caps`
        // once, so a repeated key would fail the upgrade (w2 integration).
        expect(url.searchParams.getAll('caps')).toHaveLength(1);
        expect(url.searchParams.get('caps')?.split(',')).toEqual(expect.arrayContaining(['own_voice', 'presence']));
        expect(['desktop', 'mobile', 'browser']).toContain(url.searchParams.get('kind'));
        expect(sock.protocols).toEqual(['bearer', 'token']);
    });

    describe('a tablet says so beside kind=mobile; a phone sends no form', () => {
        const saved = { mm: window.matchMedia, w: window.screen.width, h: window.screen.height };
        /** A screen of w x h with the window filling it: `(pointer: coarse)`
         *  matches a touch screen, `(max-width: 1024px)` a window that narrow. */
        const be = (touch: boolean, w: number, h: number) => {
            Object.defineProperty(window, 'matchMedia', {
                configurable: true, writable: true,
                value: (q: string) => ({
                    matches: touch && q.includes('coarse') && (!q.includes('max-width: 1024px') || w <= 1024),
                    media: q, addEventListener() {}, removeEventListener() {},
                }),
            });
            Object.defineProperty(window.screen, 'width', { configurable: true, get: () => w });
            Object.defineProperty(window.screen, 'height', { configurable: true, get: () => h });
        };
        afterEach(() => {
            Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: saved.mm });
            Object.defineProperty(window.screen, 'width', { configurable: true, get: () => saved.w });
            Object.defineProperty(window.screen, 'height', { configurable: true, get: () => saved.h });
        });
        const params = async () => new URL((await openSocket()).url).searchParams;

        it('an iPad-sized touch screen (820x1180): kind=mobile&form=tablet, ONE of each', async () => {
            be(true, 820, 1180);
            const q = await params();
            expect(q.getAll('kind')).toEqual(['mobile']);
            expect(q.getAll('form')).toEqual(['tablet']);
        });

        it('a tablet held sideways (window 1180 px wide) is still a tablet, not "a browser"', async () => {
            be(true, 1180, 820);
            const q = await params();
            expect(q.get('kind')).toBe('mobile');
            expect(q.get('form')).toBe('tablet');
            // CONTROL: the same screen with a mouse is a computer's browser.
            wsClient.disconnect();
            be(false, 1180, 820);
            const c = await params();
            expect(c.get('kind')).toBe('browser');
            expect(c.has('form')).toBe(false);
        });

        it('the line is the SHORT side at 600 px, whichever way the screen is turned', () => {
            be(true, 1180, 820);
            expect(currentClientForm('mobile')).toBe('tablet');
            be(true, 600, 960);
            expect(currentClientForm('mobile')).toBe('tablet');
            be(true, 599, 960);
            expect(currentClientForm('mobile')).toBeNull();
            be(true, 960, 599);
            expect(currentClientForm('mobile')).toBeNull();
        });

        it('inside an embedding host (Steam Deck, 1280x800) a coarse pointer is no tablet', async () => {
            const w = window as unknown as { __PUCA_EMBED_HOST__?: unknown };
            w.__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'Steam Deck host' };
            resetEmbedHostForTest();
            try {
                be(true, 1280, 800);
                const q = await params();
                expect(q.get('kind')).toBe('browser');
                expect(q.has('form')).toBe(false);
                expect(currentClientForm('mobile')).toBeNull();
            } finally {
                delete w.__PUCA_EMBED_HOST__;
                resetEmbedHostForTest();
            }
            // CONTROL: the same screen in a plain tab is a tablet held sideways.
            wsClient.disconnect();
            be(true, 1280, 800);
            const c = await params();
            expect(c.get('kind')).toBe('mobile');
            expect(c.get('form')).toBe('tablet');
        });

        it('CONTROL: a 390x844 phone sends kind=mobile and no form; a desktop browser neither', async () => {
            be(true, 390, 844);
            let q = await params();
            expect(q.get('kind')).toBe('mobile');
            expect(q.has('form')).toBe(false);
            wsClient.disconnect();
            be(false, 1920, 1080);
            q = await params();
            expect(q.get('kind')).toBe('browser');
            expect(q.has('form')).toBe(false);
            expect(currentClientForm('desktop')).toBeNull();
            expect(currentClientForm('browser')).toBeNull();
        });
    });

    it('LeaveOwnVoice is withheld from a server that never said it understands it', async () => {
        const sock = await openSocket();
        expect(wsClient.leaveOwnVoice('voice_42')).toBe(false);
        expect(sock.sent.filter(f => f.type === 'LeaveOwnVoice')).toHaveLength(0);
        expect(getOwnVoiceSnapshot().supported).toBe(false);
    });

    it('is sent once the frame has arrived, and withheld again on the next socket', async () => {
        const sock = await openSocket();
        sock.deliver(ELSEWHERE);
        expect(getOwnVoiceSnapshot().supported).toBe(true);
        expect(wsClient.leaveOwnVoice('voice_42')).toBe(true);
        expect(sock.sent.filter(f => f.type === 'LeaveOwnVoice')).toEqual([
            { type: 'LeaveOwnVoice', payload: { room_id: 'voice_42' } },
        ]);

        // A reconnect may land on an older (rollback) server.
        const next = await openSocket();
        expect(getOwnVoiceSnapshot()).toEqual({ supported: false, state: null });
        expect(wsClient.leaveOwnVoice('voice_42')).toBe(false);
        expect(next.sent.filter(f => f.type === 'LeaveOwnVoice')).toHaveLength(0);
    });

    it('a dropped socket forgets the state too', async () => {
        const sock = await openSocket();
        sock.deliver(ELSEWHERE);
        sock.onclose?.({ code: 1006, reason: '', wasClean: false });
        expect(getOwnVoiceSnapshot()).toEqual({ supported: false, state: null });
    });
});

describe('Move here: take_over rides one deliberate join, never the replay', () => {
    it('shouldTakeOver only for the room the account is in on ANOTHER device, on a capable server', async () => {
        expect(shouldTakeOver('voice_42')).toBe(false); // nothing known
        const sock = await openSocket();
        sock.deliver(ELSEWHERE);
        expect(shouldTakeOver('voice_42')).toBe(true);
        expect(shouldTakeOver('voice_43')).toBe(false); // a different channel: exclusivity handles it
        sock.deliver({ type: 'OwnVoiceState', payload: { ...ELSEWHERE.payload, here: true } });
        expect(shouldTakeOver('voice_42')).toBe(false); // already here
        sock.deliver(NONE);
        expect(shouldTakeOver('voice_42')).toBe(false);
    });

    it('joinRoom sends take_over only when asked, and the reconnect replay carries replay:true and never take_over', async () => {
        const sock = await openSocket();
        wsClient.joinRoom('channel_5');
        wsClient.joinRoom('voice_42', { takeOver: true });
        expect(sock.sent.filter(f => f.type === 'JoinRoom')).toEqual([
            { type: 'JoinRoom', payload: { room_id: 'channel_5' } },
            { type: 'JoinRoom', payload: { room_id: 'voice_42', take_over: true } },
        ]);

        const again = await openSocket();
        const replays = again.sent.filter(f => f.type === 'JoinRoom');
        expect(replays).toEqual([
            { type: 'JoinRoom', payload: { room_id: 'channel_5', replay: true } },
            { type: 'JoinRoom', payload: { room_id: 'voice_42', replay: true } },
        ]);
        wsClient.leaveRoom('channel_5');
        wsClient.leaveRoom('voice_42');
    });

    it('a RoomLeft (the PC was moved off the call) drops the room from the replay list', async () => {
        const sock = await openSocket();
        wsClient.joinRoom('voice_42');
        sock.deliver(ROOM_LEFT_MOVED);
        const again = await openSocket();
        expect(again.sent.filter(f => f.type === 'JoinRoom')).toEqual([]);
    });
});

describe('what each device says', () => {
    it('the banner names the channel and the device holding the call', () => {
        const s = parseOwnVoiceState(ELSEWHERE.payload)!;
        expect(ownVoiceBannerText(s)).toBe("You're in Lounge on your PC");
        expect(ownVoiceBannerText({ ...s, device: 'mobile' })).toBe("You're in Lounge on your phone");
        expect(ownVoiceBannerText({ ...s, device: 'browser' })).toBe("You're in Lounge in a browser");
        expect(ownVoiceBannerText({ ...s, device: null })).toBe("You're in Lounge on another device");
        expect(ownVoiceBannerText({ ...s, channelName: null })).toBe("You're in a voice channel on your PC");
        expect(ownVoiceBannerText(parseOwnVoiceState(ON_TABLET.payload)!)).toBe("You're in Lounge on your tablet");
    });

    it('a tablet is "your tablet"; a phone, or a server that sends no form, "your phone"', () => {
        expect(roomLeftNotice(ROOM_LEFT_BY_TABLET.payload)).toBe('You moved the call to your tablet');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'left_elsewhere', by: 'mobile', by_form: 'tablet' })).toBe('You left voice from your tablet');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'left_elsewhere', by: 'mobile' })).toBe('You left voice from your phone');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'moved', by: 'desktop', by_form: 'tablet' })).toBe('You moved the call to your PC');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'moved', by: 'mobile', by_form: 'phablet' })).toBe('You moved the call to your phone');
        expect(nameDevice('mobile', 'tablet')).toBe('your tablet');
        expect(whereDevice('mobile', 'tablet')).toBe('on your tablet');
        expect(whereDevice('mobile')).toBe('on your phone');
    });

    it('the displaced device explains itself instead of dropping silently', () => {
        expect(roomLeftNotice(ROOM_LEFT_MOVED.payload)).toBe('You moved the call to your phone');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'left_elsewhere', by: 'desktop' })).toBe('You left voice from your PC');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'moved' })).toBe('You moved the call to another device');
        // An ordinary RoomLeft (own hang-up, exclusivity, a kick) says nothing new.
        expect(roomLeftNotice(ROOM_LEFT_PLAIN.payload)).toBeNull();
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'mode_ended' }, 'Clocktower')).toBe('Clocktower ended, so this call ended.');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'mode_ended' }), 'a device that missed the frame').toBe('The mode ended, so this call ended.');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'something-else' })).toBeNull();
    });

    it('callOnOtherDevice: only a capable server, a call, and not here', async () => {
        expect(callOnOtherDevice(getOwnVoiceSnapshot())).toBeNull();
        const sock = await openSocket();
        sock.deliver(ELSEWHERE);
        expect(callOnOtherDevice(getOwnVoiceSnapshot())?.roomId).toBe('voice_42');
        sock.deliver({ type: 'OwnVoiceState', payload: { ...ELSEWHERE.payload, here: true } });
        expect(callOnOtherDevice(getOwnVoiceSnapshot())).toBeNull();
        sock.deliver(NONE);
        expect(callOnOtherDevice(getOwnVoiceSnapshot())).toBeNull();
    });
});

describe('carriedFromOtherDevice: how a call that comes over to this device arrives', () => {
    const elsewhere = (selfMuted: boolean | null, deafened: boolean | null, here = false) => ({
        supported: true,
        state: { roomId: 'voice_42', channelId: 42, serverId: 's', channelName: 'Lounge', serverName: 'Friends', here, device: 'desktop' as const, deviceForm: null, selfMuted, deafened },
    });
    it('as the other device left it', () => {
        expect(carriedFromOtherDevice(elsewhere(true, false))).toEqual({ muted: true, deafened: false });
        expect(carriedFromOtherDevice(elsewhere(false, false))).toEqual({ muted: false, deafened: false });
        expect(carriedFromOtherDevice(elsewhere(false, true))).toEqual({ muted: true, deafened: true });
    });
    it('nothing to carry: not reported, the call is here, or no call / no support', () => {
        expect(carriedFromOtherDevice(elsewhere(null, null))).toBeNull();
        expect(carriedFromOtherDevice(elsewhere(true, true, true))).toBeNull();
        expect(carriedFromOtherDevice({ supported: false, state: elsewhere(true, true).state })).toBeNull();
        expect(carriedFromOtherDevice({ supported: true, state: null })).toBeNull();
    });
});
