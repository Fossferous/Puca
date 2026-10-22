import { describe, expect, it, vi } from 'vitest';
import { BACK_BUTTON_IDS, PushToTalkTracker, readButtonEvents } from '../src/ptt';
import { readPageMessage, readState, readVoiceChannels } from '../src/protocol';
import { normalizeAppUrl, readSettings } from '../src/settings';

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
        expect(readSettings(null)).toEqual({ appUrl: '', pushToTalk: 'off', notifications: true, notificationSound: true });
        expect(readSettings({ appUrl: 'http://x.example', pushToTalk: 'R9', notifications: 'yes' }))
            .toEqual({ appUrl: '', pushToTalk: 'off', notifications: true, notificationSound: true });
        expect(readSettings({ appUrl: 'chat.example.com', pushToTalk: 'R4', notifications: false, notificationSound: false }))
            .toEqual({ appUrl: 'https://chat.example.com/', pushToTalk: 'R4', notifications: false, notificationSound: false });
    });
});

describe('push-to-talk on a back button', () => {
    it("reads Steam's current shape (controller, button, pressed, x, y)", () => {
        expect(readButtonEvents([0, 45, true, 0, 0])).toEqual([{ controller: 0, button: 45, pressed: true }]);
        expect(readButtonEvents([1, 33, false])).toEqual([{ controller: 1, button: 33, pressed: false }]);
    });

    it("reads the older array of { nA, bS } too, and ignores anything else", () => {
        expect(readButtonEvents([[{ nA: 33, bS: true }, { nA: 2, bS: false }, null, { bS: true }]])).toEqual([
            { controller: 0, button: 33, pressed: true },
            { controller: 0, button: 2, pressed: false },
        ]);
        expect(readButtonEvents(['x'])).toEqual([]);
        expect(readButtonEvents([])).toEqual([]);
    });

    it("maps the Deck's names to Steam's button ids", () => {
        expect(BACK_BUTTON_IDS).toEqual({ L5: 32, R5: 33, L4: 44, R4: 45 });
    });

    it('reports edges of the chosen button only, across controllers', () => {
        const changes: boolean[] = [];
        const t = new PushToTalkTracker(BACK_BUTTON_IDS.R4, held => changes.push(held));
        t.feed([{ controller: 0, button: 33, pressed: true }]); // R5: not ours
        t.feed([{ controller: 0, button: 45, pressed: true }]);
        t.feed([{ controller: 0, button: 45, pressed: true }]); // repeat
        t.feed([{ controller: 1, button: 45, pressed: true }]); // a second pad, same button
        t.feed([{ controller: 0, button: 45, pressed: false }]); // one let go: still held
        expect(changes).toEqual([true]);
        t.feed([{ controller: 1, button: 45, pressed: false }]);
        expect(changes).toEqual([true, false]);
    });

    it('lets go on reset, so changing the button never leaves the microphone open', () => {
        const onChange = vi.fn();
        const t = new PushToTalkTracker(BACK_BUTTON_IDS.L4, onChange);
        t.feed([{ controller: 0, button: 44, pressed: true }]);
        t.reset();
        expect(onChange).toHaveBeenLastCalledWith(false);
        expect(t.held).toBe(false);
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

    it('accepts each message type, and nothing else', () => {
        expect(readPageMessage({ type: 'ready', apiVersion: 1 })).toEqual({ type: 'ready', apiVersion: 1, appVersion: '' });
        expect(readPageMessage({ type: 'ready', apiVersion: null })).toEqual({ type: 'ready', apiVersion: null, appVersion: '' });
        expect(readPageMessage({ type: 'state', state })).toMatchObject({ type: 'state' });
        expect(readPageMessage({ type: 'notify', notification: { id: 'n1', title: 'alice sent a message', body: 'New message', key: 'chan:s1', kind: 'message' } }))
            .toEqual({ type: 'notify', notification: { id: 'n1', title: 'alice sent a message', body: 'New message', key: 'chan:s1', kind: 'message' } });
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
