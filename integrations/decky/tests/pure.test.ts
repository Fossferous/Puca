import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_EVERY_MS, SilenceVerdict, SilentNotice, SILENT_AFTER_S } from '../src/micSilence';
import { HoldFollower, PressFollower } from '../src/ptt';
import { liveChannels, readPageMessage, readState, readVoiceChannels } from '../src/protocol';
import { assignButton, DEFAULT_SETTINGS, jobOf, normalizeAppUrl, readSettings, watchedButtons } from '../src/settings';

describe('the Púca address', () => {
    it('takes what a person types and makes it an https address', () => {
        expect(normalizeAppUrl('chat.example.com')).toEqual({ ok: true, url: 'https://chat.example.com/', origin: 'https://chat.example.com' });
        expect(normalizeAppUrl('  https://Chat.Example.com/  ')).toMatchObject({ ok: true, url: 'https://chat.example.com/' });
        expect(normalizeAppUrl('chat.example.com:8443/puca')).toMatchObject({ ok: true, url: 'https://chat.example.com:8443/puca/', origin: 'https://chat.example.com:8443' });
        // A query and a fragment are dropped: the address is where Púca lives.
        expect(normalizeAppUrl('https://chat.example.com/?x=1#y')).toMatchObject({ ok: true, url: 'https://chat.example.com/' });
    });

    it('refuses what the web client cannot run on, or should not be handed', () => {
        // Encryption needs a secure context: https, or http on the loopback only.
        expect(normalizeAppUrl('http://chat.example.com')).toMatchObject({ ok: false });
        expect(normalizeAppUrl('http://127.0.0.1:5173')).toMatchObject({ ok: true, url: 'http://127.0.0.1:5173/' });
        expect(normalizeAppUrl('http://localhost')).toMatchObject({ ok: true, origin: 'http://localhost' });
        expect(normalizeAppUrl('http://127.0.0.2')).toMatchObject({ ok: false });
        expect(normalizeAppUrl('ftp://chat.example.com')).toMatchObject({ ok: false });
        expect(normalizeAppUrl('https://user:pw@chat.example.com')).toMatchObject({ ok: false });
        expect(normalizeAppUrl('')).toMatchObject({ ok: false });
        expect(normalizeAppUrl('not an address')).toMatchObject({ ok: false });
        expect(normalizeAppUrl('intranet')).toMatchObject({ ok: false });
    });

    it('reads stored settings defensively', () => {
        const none = { pushToTalk: 'off', muteButton: 'off', deafenButton: 'off', micForCalls: true };
        expect(readSettings(null)).toEqual({ appUrl: '', ...none, notifications: true, notificationSound: true });
        expect(readSettings({ appUrl: 'http://x.example', pushToTalk: 'R9', notifications: 'yes', micForCalls: 'no' }))
            .toEqual({ appUrl: '', ...none, notifications: true, notificationSound: true });
        expect(readSettings({ appUrl: 'chat.example.com', pushToTalk: 'R4', notifications: false, notificationSound: false }))
            .toEqual({ appUrl: 'https://chat.example.com/', ...none, pushToTalk: 'R4', notifications: false, notificationSound: false });
        expect(readSettings({ micForCalls: false }).micForCalls).toBe(false);
    });
});

describe('the back buttons: one job each', () => {
    const with_ = (o: object) => readSettings({ ...DEFAULT_SETTINGS, ...o });

    it('a stored grip claimed twice keeps the first job and loses the rest', () => {
        const s = with_({ pushToTalk: 'R5', muteButton: 'R5', deafenButton: 'R5' });
        expect([s.pushToTalk, s.muteButton, s.deafenButton]).toEqual(['R5', 'off', 'off']);
        const t = with_({ muteButton: 'L4', deafenButton: 'L4' });
        expect([t.muteButton, t.deafenButton]).toEqual(['L4', 'off']);
    });

    it('says which job a grip has, and which grips to follow in a call', () => {
        const s = with_({ pushToTalk: 'R5', muteButton: 'L4', deafenButton: 'L5' });
        expect(jobOf(s, 'R5')).toBe('pushToTalk');
        expect(jobOf(s, 'L4')).toBe('muteButton');
        expect(jobOf(s, 'L5')).toBe('deafenButton');
        expect(jobOf(s, 'R4')).toBeNull();
        expect(jobOf(s, 'off')).toBeNull();
        expect(jobOf(s, 42)).toBeNull();
        expect(watchedButtons(s)).toEqual(['R5', 'L4', 'L5']);
        expect(watchedButtons(DEFAULT_SETTINGS)).toEqual([]);
    });

    it('giving a grip a new job takes it from the old one, and says so', () => {
        const s = with_({ pushToTalk: 'R5', muteButton: 'L4' });
        const moved = assignButton(s, 'muteButton', 'R5');
        expect([moved.settings.pushToTalk, moved.settings.muteButton]).toEqual(['off', 'R5']);
        expect(moved.took).toBe('pushToTalk');
        const fresh = assignButton(s, 'deafenButton', 'R4');
        expect(fresh.took).toBeNull();
        expect(fresh.settings.deafenButton).toBe('R4');
        const same = assignButton(s, 'pushToTalk', 'R5');
        expect(same.took).toBeNull();
        expect(assignButton(s, 'muteButton', 'off').took).toBeNull();
    });
});

describe('mute and deafen on a back button', () => {
    it('one press, one toggle, however long it is held', () => {
        const f = new PressFollower();
        expect(f.signal('L4', true)).toBe(true);
        expect(f.signal('L4', true)).toBe(false); // the half-second "still held"
        expect(f.signal('L4', true)).toBe(false);
        expect(f.signal('L4', false)).toBe(false);
        expect(f.signal('L4', true)).toBe(true); // pressed again
    });

    it('each button on its own, and a reset forgets what was down', () => {
        const f = new PressFollower();
        expect(f.signal('L4', true)).toBe(true);
        expect(f.signal('L5', true)).toBe(true);
        expect(f.signal('L4', true)).toBe(false);
        f.reset();
        expect(f.signal('L4', true)).toBe(true);
    });
});

describe('push-to-talk follows the backend', () => {
    // The backend (py_modules/puca_buttons.py) sends true when the button goes
    // down and every 500 ms while it stays down, false when it comes up.
    const follow = (staleMs = 1500) => {
        const calls: string[] = [];
        const f = new HoldFollower({ down: () => calls.push('down'), renew: () => calls.push('renew'), up: () => calls.push('up') }, staleMs);
        return { f, calls };
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('talks from the first "held", renews on each heartbeat, stops on the release', () => {
        const { f, calls } = follow();
        f.signal(true);
        expect(f.held).toBe(true);
        vi.advanceTimersByTime(500);
        f.signal(true);
        vi.advanceTimersByTime(500);
        f.signal(true);
        f.signal(false);
        f.signal(false);
        expect(calls).toEqual(['down', 'renew', 'renew', 'up']);
        expect(f.held).toBe(false);
    });

    it('lets go by itself when the heartbeat stops: a lost release never leaves the microphone on', () => {
        const { f, calls } = follow(1500);
        f.signal(true);
        vi.advanceTimersByTime(1000);
        f.signal(true); // renewed: the 1.5 s start over from here
        vi.advanceTimersByTime(1499);
        expect(calls).toEqual(['down', 'renew']);
        vi.advanceTimersByTime(1);
        expect(calls).toEqual(['down', 'renew', 'up']);
        expect(f.held).toBe(false);
        f.signal(true); // a later press is a new hold
        expect(calls).toEqual(['down', 'renew', 'up', 'down']);
    });

    it('lets go once on reset, and only when holding, with no timer left behind', () => {
        const { f, calls } = follow();
        f.reset();
        expect(calls).toEqual([]);
        f.signal(true);
        f.reset();
        f.reset();
        expect(calls).toEqual(['down', 'up']);
        vi.advanceTimersByTime(10000);
        expect(calls).toEqual(['down', 'up']);
    });

    it('ignores anything but a boolean, held or not', () => {
        const { f, calls } = follow();
        for (const x of [1, 'true', null, undefined, {}, [true]]) f.signal(x);
        expect(calls).toEqual([]);
        expect(f.held).toBe(false);
        f.signal(true);
        for (const x of [0, 'false', null, undefined, {}, [false]]) f.signal(x);
        expect(calls).toEqual(['down']);
        expect(f.held).toBe(true);
    });
});

describe("a muted Deck microphone is noticed", () => {
    // Fed RTCAudioSourceStats' running totals: totalAudioEnergy, totalSamplesDuration.
    it('says silent after a few seconds of captured audio with no energy at all, and says it once', () => {
        const v = new SilenceVerdict();
        expect(SILENT_AFTER_S).toBe(3);
        expect(v.update(0, 2)).toBeNull();
        expect(v.update(0, 4)).toBe(true);
        expect(v.isSilent).toBe(true);
        expect(v.update(0, 6)).toBeNull();
    });

    it('never calls a working microphone silent, however quiet the room', () => {
        const v = new SilenceVerdict();
        for (let i = 1; i <= 20; i++) expect(v.update(i * 1e-9, i * 2)).toBeNull();
        expect(v.isSilent).toBe(false);
    });

    it('notices a microphone muted in the middle of a call: what arrived since the last reading counts, not the totals', () => {
        const v = new SilenceVerdict();
        v.update(0.5, 2);
        v.update(1.0, 4);
        expect(v.update(1.0, 6)).toBeNull();
        expect(v.update(1.0, 8)).toBe(true);
    });

    it('clears as soon as any energy arrives again', () => {
        const v = new SilenceVerdict();
        v.update(0, 2);
        v.update(0, 4);
        expect(v.update(1e-7, 6)).toBe(false);
        expect(v.isSilent).toBe(false);
    });

    it('ignores readings with nothing new in them, and garbage', () => {
        const v = new SilenceVerdict();
        expect(v.update(0, 0)).toBeNull();
        expect(v.update(Number.NaN, 2)).toBeNull();
        expect(v.update(0, Number.POSITIVE_INFINITY)).toBeNull();
        expect(v.update(0, 2)).toBeNull();
        expect(v.update(0, 2)).toBeNull(); // no time passed: not "silent for longer"
        expect(v.isSilent).toBe(false);
    });

    describe('the notice over the game', () => {
        const live = { connected: true, muted: false, deafened: false, noMicrophone: false };

        it('pops up when someone in the call is trying to be heard, once', () => {
            const n = new SilentNotice();
            expect(n.update(true, live, 0)).toBe(true);
            expect(n.update(true, live, 1000)).toBe(false);
            expect(n.update(true, { ...live }, 2000), 'the same stretch of silence').toBe(false);
            expect(n.update(true, live, NOTICE_EVERY_MS * 2), 'however long it lasts: the panel keeps saying it').toBe(false);
        });

        it('stays quiet for someone who muted or deafened themselves, has no microphone, or is not in the call yet', () => {
            const n = new SilentNotice();
            expect(n.update(true, { ...live, muted: true }, 0)).toBe(false);
            expect(n.update(true, { ...live, deafened: true }, 0)).toBe(false);
            expect(n.update(true, { ...live, noMicrophone: true }, 0)).toBe(false);
            expect(n.update(true, { ...live, connected: false }, 0)).toBe(false);
            expect(n.update(true, null, 0)).toBe(false);
            expect(n.update(false, live, 0)).toBe(false);
            // POSITIVE CONTROL: the same silence, the moment they can be heard.
            expect(n.update(true, live, 0)).toBe(true);
        });

        it('comes back each time it starts again, but not more often than every five minutes', () => {
            const n = new SilentNotice();
            expect(NOTICE_EVERY_MS).toBe(5 * 60 * 1000);
            expect(n.update(true, live, 0)).toBe(true);
            expect(n.update(false, live, 1000), 'turned up').toBe(false);
            expect(n.update(true, live, 2000), 'down again, too soon').toBe(false);
            expect(n.update(false, live, 3000)).toBe(false);
            expect(n.update(true, live, NOTICE_EVERY_MS)).toBe(true);
        });
    });
});

describe('live now: who is talking where, on every server', () => {
    const ch = (id: number, name: string, n: number) => ({
        id, name, canConnect: true, members: Array.from({ length: n }, (_, i) => ({ id: id * 100 + i, username: `u${id}${i}` })),
    });

    it('keeps the channels with people in them, busiest first, then by server and channel', () => {
        const servers = [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }];
        const live = liveChannels(servers, new Map([
            ['a', [ch(1, 'Lounge', 2), ch(2, 'Empty', 0), ch(3, 'Games', 2)]],
            ['b', [ch(4, 'Raid', 3), ch(5, 'Chill', 0)]],
        ]));
        expect(live.map(l => `${l.serverName}/${l.channel.name}`)).toEqual(['Beta/Raid', 'Alpha/Games', 'Alpha/Lounge']);
        expect(live[0].serverId).toBe('b');
    });

    it('a tie goes by server name before channel name', () => {
        const live = liveChannels([{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }], new Map([
            ['b', [ch(1, 'Arena', 2)]],
            ['a', [ch(2, 'Lounge', 2)]],
        ]));
        expect(live.map(l => `${l.serverName}/${l.channel.name}`)).toEqual(['Alpha/Lounge', 'Beta/Arena']);
    });

    it('a server with nothing listed, or not known, adds nothing', () => {
        expect(liveChannels([{ id: 'x', name: 'X' }], new Map())).toEqual([]);
        expect(liveChannels([], new Map([['a', [ch(1, 'Lounge', 2)]]]))).toEqual([]);
    });
});

describe('what the page sends', () => {
    const state = {
        apiVersion: 1, appVersion: '0.9.845', signedIn: true,
        user: { id: 7, username: 'deck-user' },
        servers: [{ id: 's1', name: 'Family' }, { id: 7, name: 'bad id' }],
        currentServerId: 's1',
        call: {
            serverId: 's1', channelId: 42, channelName: 'Lounge', connected: true, connecting: false,
            muted: false, deafened: false, noMicrophone: false, inputMode: 'pushToTalk', holdDown: true,
            members: [{ id: 8, username: 'friend', speaking: true, muted: false, deafened: false, noMicrophone: false, self: false }, { id: 'x' }],
        },
    };

    it('keeps a well-formed state and drops malformed parts of it', () => {
        const s = readState(state)!;
        expect(s.servers).toEqual([{ id: 's1', name: 'Family' }]);
        expect(s.call?.members).toHaveLength(1);
        expect(s.call?.inputMode).toBe('pushToTalk');
        expect(readState({ ...state, apiVersion: '1' })).toBeNull();
        expect(readState({ ...state, call: { channelId: 'x' } })?.call).toBeNull();
    });

    it('caps text it will show', () => {
        const s = readState({ ...state, servers: [{ id: 's1', name: 'x'.repeat(5000) }] })!;
        expect(s.servers[0].name.length).toBe(200);
    });

    it("reads the page's optional calls, so an older page is told apart", () => {
        expect(readState(state)!.features).toEqual([]);
        expect(readState({ ...state, features: ['signIn', 'downloadSite', 7, '', 'x'.repeat(60)] })!.features)
            .toEqual(['signIn', 'downloadSite', 'x'.repeat(40)]);
        expect(readState({ ...state, features: 'signIn' })!.features).toEqual([]);
        expect(readState({ ...state, features: Array.from({ length: 80 }, (_, i) => `f${i}`) })!.features).toHaveLength(50);
    });

    it('accepts each message type, and nothing else', () => {
        expect(readPageMessage({ type: 'ready', apiVersion: 1 })).toEqual({ type: 'ready', apiVersion: 1, appVersion: '' });
        expect(readPageMessage({ type: 'ready', apiVersion: null })).toEqual({ type: 'ready', apiVersion: null, appVersion: '' });
        expect(readPageMessage({ type: 'state', state })).toMatchObject({ type: 'state' });
        expect(readPageMessage({ type: 'notify', notification: { id: 'n1', title: 'alice sent a message', body: 'New message', key: 'chan:s1', kind: 'message' } }))
            .toEqual({ type: 'notify', notification: { id: 'n1', title: 'alice sent a message', body: 'New message', key: 'chan:s1', kind: 'message' } });
        expect(readPageMessage({ type: 'notify', notification: { id: 'n2', title: 'Approval needed', body: 'Open Púca to approve or decline', key: 'clip:9', kind: 'clip' } }))
            .toMatchObject({ notification: { key: 'clip:9', kind: 'clip' } });
        expect(readPageMessage({ type: 'notify', notification: { id: 'n3', title: 'x', kind: 'shout' } }))
            .toMatchObject({ notification: { kind: 'message' } });
        expect(readPageMessage({ type: 'mic-release', id: 'm1' })).toEqual({ type: 'mic-release', id: 'm1' });
        expect(readPageMessage({ type: 'eval', code: 'x' })).toBeNull();
        expect(readPageMessage('state')).toBeNull();
        expect(readPageMessage(null)).toBeNull();
        expect(readPageMessage({ type: 'mic-release', id: '../../x' })).toBeNull();
    });

    it('reads a microphone request: an SDP offer and the processing Púca asked for', () => {
        const msg = readPageMessage({
            type: 'mic-request', id: 'mabc1',
            constraints: { channelCount: 1, deviceId: { exact: 'x' }, echoCancellation: true, noiseSuppression: false, autoGainControl: { ideal: true } },
            offer: { type: 'offer', sdp: 'v=0\r\n' },
        });
        expect(msg).toEqual({
            type: 'mic-request', id: 'mabc1',
            constraints: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
            offer: { type: 'offer', sdp: 'v=0\r\n' },
        });
        expect(readPageMessage({ type: 'mic-request', id: 'm1', offer: { type: 'answer', sdp: 'x' } })).toBeNull();
        expect(readPageMessage({ type: 'mic-request', id: 'm1', offer: { type: 'offer', sdp: 'x'.repeat(70000) } })).toBeNull();
    });

    it('reads a voice channel list', () => {
        expect(readVoiceChannels([{ id: 42, name: 'Lounge', canConnect: true, members: [{ id: 8, username: 'friend' }, {}] }, { name: 'no id' }]))
            .toEqual([{ id: 42, name: 'Lounge', canConnect: true, members: [{ id: 8, username: 'friend' }] }]);
        expect(readVoiceChannels('nope')).toEqual([]);
    });
});
