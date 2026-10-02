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
import {
    callOnOtherDevice,
    getOwnVoiceSnapshot,
    ownVoiceBannerText,
    parseOwnVoiceState,
    resetOwnVoice,
    roomLeftNotice,
    shouldTakeOver,
} from '../api/ownVoice';

type Frame = { type: string; payload?: Record<string, unknown> };
const [ELSEWHERE, NONE, ROOM_LEFT_MOVED, ROOM_LEFT_PLAIN] = fixture as Frame[];

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
        });
    });

    it('reads the not-in-voice frame', () => {
        expect(parseOwnVoiceState(NONE.payload)).toEqual({
            roomId: null, channelId: null, serverId: null, channelName: null, serverName: null, here: false, device: null,
        });
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
        expect(url.searchParams.get('caps')).toBe('own_voice');
        expect(['desktop', 'mobile', 'browser']).toContain(url.searchParams.get('kind'));
        expect(sock.protocols).toEqual(['bearer', 'token']);
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
    });

    it('the displaced device explains itself instead of dropping silently', () => {
        expect(roomLeftNotice(ROOM_LEFT_MOVED.payload)).toBe('You moved the call to your phone');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'left_elsewhere', by: 'desktop' })).toBe('You left voice from your PC');
        expect(roomLeftNotice({ room_id: 'voice_42', reason: 'moved' })).toBe('You moved the call to another device');
        // An ordinary RoomLeft (own hang-up, exclusivity, a kick) says nothing new.
        expect(roomLeftNotice(ROOM_LEFT_PLAIN.payload)).toBeNull();
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
