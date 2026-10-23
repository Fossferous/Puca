// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
    HOLD_LEASE_MS, createEmbedApi, downloadOrigin, getEmbedState, holdFromEmbedHost, installEmbedApi, notifyEmbedChanged,
    registerEmbedCall, registerEmbedSession, resetEmbedApiForTest,
    type EmbedCallControls, type EmbedSession,
} from '../api/embedApi';
import { resetEmbedHostForTest } from '../api/embedHost';
import { registerHold, resetHotkeysForTest } from '../api/hotkeys';
import { clearSpeaking, globalVoiceUsers, setUserSpeaking, upsertVoiceUser } from '../components/voiceState';
import type { KeyBinding } from '../components/settingsStore';

/**
 * window.pucaEmbed (docs/EMBEDDING.md): what a host is sent and what its
 * commands reach. The commands must land on the app's OWN controls, and a
 * host's push-to-talk must never be able to leave a microphone open: these
 * pin both, plus the "no host, nothing installed" side.
 */

type Win = Window & { __PUCA_EMBED_HOST__?: unknown; pucaEmbed?: unknown };

let pushed: unknown[];

function declareHost() {
    pushed = [];
    (window as Win).__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'Test host', onStateChange: (s: unknown) => pushed.push(s) };
    resetEmbedHostForTest();
}

function fakeSession(over: Partial<EmbedSession> = {}): EmbedSession {
    return {
        user: () => ({ id: 7, username: 'deck-user' }),
        servers: () => [{ id: 's1', name: 'Family' }],
        currentServerId: () => 's1',
        voiceChannel: () => ({ id: 42, serverId: 's1', name: 'Lounge' }),
        listVoiceChannels: vi.fn(async () => []),
        joinVoice: vi.fn(async () => ({ ok: true as const })),
        ...over,
    };
}

function fakeCall(over: Partial<ReturnType<EmbedCallControls['state']>> = {}): EmbedCallControls & { leave: Mock<() => void> } {
    const st = { connected: true, connecting: false, muted: false, deafened: false, noMicrophone: false, inputMode: 'pushToTalk' as const, holdDown: false, ...over };
    return {
        roomId: 'voice_42',
        state: () => st,
        setMuted: vi.fn(() => true),
        setDeafened: vi.fn(() => true),
        leave: vi.fn<() => void>(),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    resetHotkeysForTest();
    resetEmbedApiForTest();
    delete (window as Win).__PUCA_EMBED_HOST__;
    resetEmbedHostForTest();
    globalVoiceUsers.clear();
    clearSpeaking();
});

afterEach(() => {
    resetEmbedApiForTest();
    resetHotkeysForTest();
    vi.useRealTimers();
    delete (window as Win).__PUCA_EMBED_HOST__;
    resetEmbedHostForTest();
});

describe('without a host', () => {
    it('installs nothing and registers nothing', () => {
        expect(installEmbedApi()).toBe(false);
        expect((window as Win).pucaEmbed).toBeUndefined();
        registerEmbedSession(fakeSession());
        expect(getEmbedState().signedIn).toBe(false);
        expect(getEmbedState().servers).toEqual([]);
    });
});

describe('the state a host is sent', () => {
    it('says signed out until the app has a session', () => {
        declareHost();
        const s = getEmbedState();
        expect(s).toMatchObject({ apiVersion: 1, signedIn: false, user: null, servers: [], call: null });
    });

    it('carries the account, the servers and the call with its members', () => {
        declareHost();
        registerEmbedSession(fakeSession());
        registerEmbedCall(fakeCall({ muted: true }));
        upsertVoiceUser('voice_42', { id: 7, username: 'deck-user' });
        upsertVoiceUser('voice_42', { id: 8, username: 'friend' }, { isDeafened: true });
        setUserSpeaking(8, true);
        const s = getEmbedState();
        expect(s.signedIn).toBe(true);
        expect(s.user).toEqual({ id: 7, username: 'deck-user' });
        expect(s.servers).toEqual([{ id: 's1', name: 'Family' }]);
        expect(s.call).toMatchObject({ serverId: 's1', channelId: 42, channelName: 'Lounge', connected: true, muted: true, inputMode: 'pushToTalk' });
        expect(s.call?.members).toEqual([
            { id: 7, username: 'deck-user', speaking: false, muted: false, deafened: false, noMicrophone: false, self: true },
            { id: 8, username: 'friend', speaking: true, muted: false, deafened: true, noMicrophone: false, self: false },
        ]);
    });

    it('reads a call whose panel has not registered yet as still connecting', () => {
        declareHost();
        registerEmbedSession(fakeSession());
        expect(getEmbedState().call).toMatchObject({ channelId: 42, connected: false, connecting: true });
    });

    it('is pushed once per burst, and only when it changed', () => {
        declareHost();
        registerEmbedSession(fakeSession());
        upsertVoiceUser('voice_42', { id: 8, username: 'friend' });
        vi.runAllTimers();
        const before = pushed.length;
        expect(before).toBeGreaterThan(0);
        notifyEmbedChanged();
        notifyEmbedChanged();
        notifyEmbedChanged();
        vi.runAllTimers();
        // Nothing changed: nothing sent.
        expect(pushed.length).toBe(before);
        setUserSpeaking(8, true);
        setUserSpeaking(8, false);
        setUserSpeaking(8, true);
        notifyEmbedChanged();
        vi.runAllTimers();
        expect(pushed.length).toBe(before + 1);
    });

    it('survives a host whose callback throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        (window as Win).__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'Broken', onStateChange: () => { throw new Error('boom'); } };
        resetEmbedHostForTest();
        registerEmbedSession(fakeSession());
        expect(() => vi.runAllTimers()).not.toThrow();
        warn.mockRestore();
    });
});

describe('push-to-talk from the host', () => {
    const SPACE: KeyBinding = { keyCode: 32, ctrl: false, alt: false, shift: false, label: 'Space' };
    let onDown: Mock<() => void>;
    let onUp: Mock<() => void>;

    beforeEach(() => {
        declareHost();
        onDown = vi.fn<() => void>();
        onUp = vi.fn<() => void>();
        registerEmbedSession(fakeSession());
        registerEmbedCall(fakeCall({ inputMode: 'pushToTalk' }));
        registerHold('voice.ptt', () => null, { onDown, onUp });
    });

    it('holds the registered push-to-talk action, once per press', () => {
        expect(holdFromEmbedHost(true)).toBe(true);
        expect(holdFromEmbedHost(true)).toBe(true);
        expect(onDown).toHaveBeenCalledTimes(1);
        expect(holdFromEmbedHost(false)).toBe(true);
        expect(onUp).toHaveBeenCalledTimes(1);
    });

    it('lets go by itself when the host stops renewing: no stuck open microphone', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        holdFromEmbedHost(true);
        vi.advanceTimersByTime(HOLD_LEASE_MS - 500);
        holdFromEmbedHost(true); // renewed
        vi.advanceTimersByTime(HOLD_LEASE_MS - 1);
        expect(onUp).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onUp).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('is not released by the window losing focus (its lease is), unlike a key', () => {
        holdFromEmbedHost(true);
        window.dispatchEvent(new Event('blur'));
        expect(onUp).not.toHaveBeenCalled();
        holdFromEmbedHost(false);
        expect(onUp).toHaveBeenCalledTimes(1);

        // Control: the same action held by its KEY is released by a blur.
        registerHold('voice.ptt', () => SPACE, { onDown, onUp });
        const e = new KeyboardEvent('keydown', { bubbles: true });
        Object.defineProperty(e, 'keyCode', { value: 32 });
        window.dispatchEvent(e);
        expect(onDown).toHaveBeenCalledTimes(2);
        window.dispatchEvent(new Event('blur'));
        expect(onUp).toHaveBeenCalledTimes(2);
    });

    it('holds nothing in voice-activity mode, or outside a call', () => {
        resetEmbedApiForTest();
        declareHost();
        registerEmbedCall(fakeCall({ inputMode: 'open' }));
        expect(holdFromEmbedHost(true)).toBe(false);
        resetHotkeysForTest();
        registerEmbedCall(fakeCall({ inputMode: 'pushToTalk' }));
        expect(holdFromEmbedHost(true)).toBe(false); // no voice.ptt registered: no call
        expect(onDown).not.toHaveBeenCalled();
    });

    it('is let go when the host leaves the call', () => {
        const api = createEmbedApi();
        api.holdPushToTalk(true);
        expect(api.leaveVoice()).toBe(true);
        expect(onUp).toHaveBeenCalledTimes(1);
    });
});

describe('commands', () => {
    beforeEach(() => declareHost());

    it('refuse a join while signed out, and a malformed one without asking the app', async () => {
        const api = createEmbedApi();
        await expect(api.joinVoice('s1', 42)).resolves.toEqual({ ok: false, error: 'not signed in' });
        const session = fakeSession();
        registerEmbedSession(session);
        await expect(api.joinVoice('', 42)).resolves.toMatchObject({ ok: false });
        await expect(api.joinVoice('s1', -1)).resolves.toMatchObject({ ok: false });
        await expect(api.joinVoice('s1', 1.5)).resolves.toMatchObject({ ok: false });
        await expect(api.joinVoice({} as unknown as string, 42)).resolves.toMatchObject({ ok: false });
        expect(session.joinVoice).not.toHaveBeenCalled();
        await expect(api.joinVoice('s1', 42)).resolves.toEqual({ ok: true });
        expect(session.joinVoice).toHaveBeenCalledWith('s1', 42);
    });

    it('reach the call only with a real boolean', () => {
        const api = createEmbedApi();
        expect(api.setMuted(true)).toBe(false); // no call yet
        const call = fakeCall();
        registerEmbedCall(call);
        expect(api.setMuted('yes' as unknown as boolean)).toBe(false);
        expect(call.setMuted).not.toHaveBeenCalled();
        expect(api.setMuted(true)).toBe(true);
        expect(call.setMuted).toHaveBeenCalledWith(true);
        expect(api.setDeafened(false)).toBe(true);
        expect(call.setDeafened).toHaveBeenCalledWith(false);
    });

    it('set the input mode through the stored setting the panel already follows', () => {
        const api = createEmbedApi();
        const seen: string[] = [];
        const onChange = (e: Event) => seen.push((e as CustomEvent<{ voiceInputMode: string }>).detail.voiceInputMode);
        window.addEventListener('settingsChanged', onChange);
        expect(api.setInputMode('pushToTalk')).toBe(true);
        expect(api.setInputMode('shout' as unknown as 'open')).toBe(false);
        window.removeEventListener('settingsChanged', onChange);
        expect(seen).toEqual(['pushToTalk']);
        expect(vi.mocked(localStorage.setItem)).toHaveBeenCalledWith('sovereign_settings', expect.stringContaining('"voiceInputMode":"pushToTalk"'));
    });

    it('stop answering for a session or call that unregistered', () => {
        const api = createEmbedApi();
        const unSession = registerEmbedSession(fakeSession());
        const unCall = registerEmbedCall(fakeCall());
        expect(api.getState().signedIn).toBe(true);
        unCall();
        expect(api.setMuted(true)).toBe(false);
        unSession();
        expect(api.getState().signedIn).toBe(false);
    });
});

describe('installing', () => {
    it('puts a frozen window.pucaEmbed in place when a host declared itself', () => {
        declareHost();
        expect(installEmbedApi()).toBe(true);
        const api = (window as Win).pucaEmbed as { apiVersion: number; getState: () => unknown };
        expect(api.apiVersion).toBe(1);
        expect(Object.isFrozen(api)).toBe(true);
        expect(() => { (window as Win).pucaEmbed = {}; }).toThrow();
    });
});

describe('downloadSite: where a host looks for its own updates', () => {
    beforeEach(() => declareHost());
    afterEach(() => { vi.unstubAllGlobals(); });

    const answer = (status: number, body: unknown) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status }));

    it("answers the origin of the server's download_url, read fresh from its /app-version", async () => {
        const fetchMock = answer(200, { version: '0.9.846', download_url: 'https://downloads.example.org/some/page?x=1' });
        vi.stubGlobal('fetch', fetchMock);
        await expect(createEmbedApi().downloadSite()).resolves.toBe('https://downloads.example.org');
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/\/app-version$/);
        expect(init.cache).toBe('no-store');
    });

    it('answers null when the server publishes none, or something that is not https', async () => {
        for (const [status, body] of [[404, {}], [200, {}], [200, { download_url: 'http://plain.example.org/' }], [200, { download_url: 'http://127.0.0.1.example.org/' }], [200, { download_url: 42 }], [200, null]] as const) {
            vi.stubGlobal('fetch', answer(status, body));
            await expect(createEmbedApi().downloadSite()).resolves.toBeNull();
        }
    });

    it('answers null when the server cannot be reached', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        await expect(createEmbedApi().downloadSite()).resolves.toBeNull();
    });

    it('takes plain http only on the loopback, where a local test server lives', () => {
        expect(downloadOrigin('http://127.0.0.1:8899/Puca-Setup.exe')).toBe('http://127.0.0.1:8899');
        expect(downloadOrigin('http://localhost:8899/')).toBe('http://localhost:8899');
        expect(downloadOrigin('https://downloads.example.org:8443/x')).toBe('https://downloads.example.org:8443');
        for (const bad of ['http://downloads.example.org/', 'http://127.0.0.1.example.org/', 'http://10.0.0.2/', 'ftp://127.0.0.1/', 'not a url', 'javascript:alert(1)']) {
            expect(downloadOrigin(bad), bad).toBeNull();
        }
    });
});
