// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    activateHostNotification, embedHost, getUserMediaForMic, hostIdleSeconds, hostMicrophone, hostReportsIdle,
    hostSaysForeground, hostShowsNotifications, notifyHost, resetEmbedHostForTest, type EmbedNotification,
} from '../api/embedHost';
import { notifyNewMessage, sendTestNotification } from '../api/desktopNotify';
import { loadSettings } from '../components/settingsStore';

/**
 * Embedding hosts (docs/EMBEDDING.md) opt in by declaring themselves before the
 * app runs. These pin the two halves of that promise: with no declaration the
 * app does exactly what the browser would (the seams are invisible), and with
 * one the microphone and notifications go to the host - including the case
 * that made the host path necessary, a hidden Steam browser view that reports
 * focus all the time.
 */

type Win = Window & { __PUCA_EMBED_HOST__?: unknown };

class FakeTrack {
    stopped = false;
    kind: 'audio' | 'video';
    constructor(kind: 'audio' | 'video') { this.kind = kind; }
    stop() { this.stopped = true; }
}
class FakeStream {
    tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
}

const browserGum = vi.fn();

function declare(host: unknown) {
    (window as Win).__PUCA_EMBED_HOST__ = host;
    resetEmbedHostForTest();
}

let savedGum: unknown;
beforeEach(() => {
    browserGum.mockReset();
    // The test setup provides navigator.mediaDevices (not redefinable here):
    // swap its getUserMedia, put it back after.
    const md = navigator.mediaDevices as unknown as Record<string, unknown>;
    savedGum = md.getUserMedia;
    md.getUserMedia = browserGum;
    delete (window as Win).__PUCA_EMBED_HOST__;
    resetEmbedHostForTest();
});

afterEach(() => {
    (navigator.mediaDevices as unknown as Record<string, unknown>).getUserMedia = savedGum;
    vi.mocked(localStorage.getItem).mockReset();
    vi.restoreAllMocks();
    delete (window as Win).__PUCA_EMBED_HOST__;
    resetEmbedHostForTest();
});

describe('without a host, nothing changes', () => {
    it('reports no host, no host microphone and no host notifications', () => {
        expect(embedHost()).toBeNull();
        expect(hostMicrophone()).toBeNull();
        expect(hostShowsNotifications()).toBe(false);
        expect(hostSaysForeground()).toBeNull();
        expect(notifyHost({ title: 't', body: 'b', key: 'k', kind: 'message' })).toBe(false);
    });

    it('opens the microphone with the browser, with the constraints exactly as given', async () => {
        const stream = new FakeStream([new FakeTrack('audio')]);
        browserGum.mockResolvedValue(stream);
        const constraints = { audio: { echoCancellation: true, deviceId: { exact: 'mic-1' } }, video: false };
        await expect(getUserMediaForMic(constraints)).resolves.toBe(stream);
        expect(browserGum).toHaveBeenCalledTimes(1);
        expect(browserGum).toHaveBeenCalledWith(constraints);
    });
});

describe('the declaration', () => {
    it('is refused for another API version: the app runs as a plain web client', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        declare({ apiVersion: 2, name: 'Future host', getUserMedia: vi.fn() });
        expect(embedHost()).toBeNull();
        expect(hostMicrophone()).toBeNull();
        warn.mockRestore();
    });

    it('is read once: a page script cannot swap a host function afterwards', async () => {
        const hostGum = vi.fn().mockResolvedValue(new FakeStream([new FakeTrack('audio')]));
        declare({ apiVersion: 1, name: 'Test host', getUserMedia: hostGum });
        expect(hostMicrophone()).toBe('Test host');
        const evil = vi.fn();
        (window as Win).__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'Evil', getUserMedia: evil };
        await getUserMediaForMic({ audio: true });
        expect(hostGum).toHaveBeenCalledTimes(1);
        expect(evil).not.toHaveBeenCalled();
        expect(hostMicrophone()).toBe('Test host');
    });

    it('cannot be made after first use either: no declaration then means none for good', () => {
        expect(embedHost()).toBeNull();
        (window as Win).__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'Late', notify: vi.fn() };
        expect(embedHost()).toBeNull();
        expect(hostShowsNotifications()).toBe(false);
    });

    it('calls host functions on the object that declared them', async () => {
        const decl = {
            apiVersion: 1,
            name: 'This-bound host',
            calls: 0,
            getUserMedia(this: { calls: number }) {
                this.calls++;
                return Promise.resolve(new FakeStream([new FakeTrack('audio')]));
            },
        };
        declare(decl);
        await getUserMediaForMic({ audio: true });
        expect(decl.calls).toBe(1);
    });
});

describe('a host that supplies the microphone', () => {
    it('is asked for the AUDIO, the browser for nothing', async () => {
        const stream = new FakeStream([new FakeTrack('audio')]);
        const hostGum = vi.fn().mockResolvedValue(stream);
        declare({ apiVersion: 1, name: 'Deck', getUserMedia: hostGum });
        const audio = { echoCancellation: true, noiseSuppression: false, deviceId: { exact: 'x' } };
        await expect(getUserMediaForMic({ audio, video: false })).resolves.toBe(stream);
        expect(hostGum).toHaveBeenCalledWith({ audio, video: false });
        expect(browserGum).not.toHaveBeenCalled();
    });

    it('still opens a camera asked for in the same call from the browser, in the same stream', async () => {
        const mic = new FakeTrack('audio');
        const cam = new FakeTrack('video');
        declare({ apiVersion: 1, name: 'Deck', getUserMedia: vi.fn().mockResolvedValue(new FakeStream([mic])) });
        browserGum.mockResolvedValue(new FakeStream([cam]));
        const got = await getUserMediaForMic({ audio: true, video: { width: 1280 } }) as unknown as FakeStream;
        expect(browserGum).toHaveBeenCalledWith({ audio: false, video: { width: 1280 } });
        expect(got.getTracks()).toEqual([mic, cam]);
    });

    it('releases the host microphone when the camera then fails', async () => {
        const mic = new FakeTrack('audio');
        declare({ apiVersion: 1, name: 'Deck', getUserMedia: vi.fn().mockResolvedValue(new FakeStream([mic])) });
        browserGum.mockRejectedValue(new DOMException('no camera', 'NotFoundError'));
        await expect(getUserMediaForMic({ audio: true, video: true })).rejects.toMatchObject({ name: 'NotFoundError' });
        expect(mic.stopped).toBe(true);
    });

    it('turns an answer with no audio track into NotReadableError (no usable microphone)', async () => {
        const video = new FakeTrack('video');
        declare({ apiVersion: 1, name: 'Deck', getUserMedia: vi.fn().mockResolvedValue(new FakeStream([video])) });
        await expect(getUserMediaForMic({ audio: true })).rejects.toMatchObject({ name: 'NotReadableError' });
        expect(video.stopped).toBe(true);
    });

    it('passes the host refusal through by NAME, which media.ts decides on', async () => {
        declare({ apiVersion: 1, name: 'Deck', getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) });
        await expect(getUserMediaForMic({ audio: true })).rejects.toMatchObject({ name: 'NotAllowedError' });
    });

    it('leaves a video-only capture to the browser', async () => {
        const hostGum = vi.fn();
        declare({ apiVersion: 1, name: 'Deck', getUserMedia: hostGum });
        browserGum.mockResolvedValue(new FakeStream([new FakeTrack('video')]));
        await getUserMediaForMic({ audio: false, video: true });
        expect(hostGum).not.toHaveBeenCalled();
        expect(browserGum).toHaveBeenCalledWith({ audio: false, video: true });
    });
});

describe('a host that shows notifications', () => {
    let shown: EmbedNotification[];
    let foreground: boolean;

    beforeEach(() => {
        shown = [];
        foreground = false;
        declare({ apiVersion: 1, name: 'Deck', notify: (n: EmbedNotification) => shown.push(n), isForeground: () => foreground });
    });

    it('gets a message notification, content-free, with an id to hand back', () => {
        const onActivate = vi.fn();
        const decision = notifyNewMessage({ title: 'alice sent a message', isOwn: false, isMuted: false, notifyKey: 'chan:s1', onActivate });
        expect(decision).toEqual({ fire: true });
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatchObject({ title: 'alice sent a message', body: 'New message', key: 'chan:s1', kind: 'message' });
        expect(activateHostNotification(shown[0].id)).toBe(true);
        expect(onActivate).toHaveBeenCalledTimes(1);
        // Once only.
        expect(activateHostNotification(shown[0].id)).toBe(false);
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('is not sent one while the host says the app is on screen', () => {
        // The reason this exists: a hidden Steam browser view reports
        // document.hasFocus() true, which alone would hold back everything.
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        foreground = false;
        expect(notifyNewMessage({ title: 'x', isOwn: false, isMuted: false }).fire).toBe(true);
        foreground = true;
        expect(notifyNewMessage({ title: 'y', isOwn: false, isMuted: false })).toEqual({ fire: false, reason: 'focused' });
        expect(shown.map(n => n.title)).toEqual(['x']);
    });

    it('keeps every other rule: muted, own message, the setting', () => {
        expect(notifyNewMessage({ title: 'm', isOwn: false, isMuted: true })).toEqual({ fire: false, reason: 'muted' });
        expect(notifyNewMessage({ title: 'o', isOwn: true, isMuted: false })).toEqual({ fire: false, reason: 'own-message' });
        // The setup's localStorage is a mock: hand loadSettings the stored value.
        vi.mocked(localStorage.getItem).mockImplementation((k: string) =>
            (k === 'sovereign_settings' ? JSON.stringify({ desktopNotifications: false }) : null));
        expect(loadSettings().desktopNotifications).toBe(false);
        expect(notifyNewMessage({ title: 's', isOwn: false, isMuted: false })).toEqual({ fire: false, reason: 'setting-off' });
        expect(shown).toHaveLength(0);
    });

    it('does not need the browser notification permission there is no prompt for', () => {
        // jsdom has no Notification at all: 'unsupported' would refuse.
        expect(typeof (globalThis as { Notification?: unknown }).Notification).toBe('undefined');
        expect(notifyNewMessage({ title: 'p', isOwn: false, isMuted: false }).fire).toBe(true);
    });

    it('sends the Settings test notification to the host', async () => {
        await expect(sendTestNotification()).resolves.toEqual({ ok: true });
        expect(shown).toEqual([expect.objectContaining({ kind: 'test', title: 'Púca' })]);
    });

    it('keeps no more than twenty taps to answer', () => {
        const fns = Array.from({ length: 25 }, () => vi.fn());
        fns.forEach((fn, i) => notifyHost({ title: `t${i}`, body: 'b', key: 'k', kind: 'message' }, fn));
        expect(activateHostNotification(shown[0].id)).toBe(false);
        expect(activateHostNotification(shown[24].id)).toBe(true);
        expect(fns[24]).toHaveBeenCalled();
    });

    it('survives a host that throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const notify = vi.fn(() => { throw new Error('boom'); });
        declare({ apiVersion: 1, name: 'Broken', notify, isForeground: () => { throw new Error('boom'); } });
        // An unanswerable host falls back to the page's own focus.
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        expect(hostSaysForeground()).toBeNull();
        expect(() => notifyNewMessage({ title: 'z', isOwn: false, isMuted: false })).not.toThrow();
        expect(notify).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});

describe('a host that says how long the person has been away (the AFK move)', () => {
    it('is not asked for at all without a host, or a host that does not say', async () => {
        expect(hostReportsIdle()).toBe(false);
        expect(await hostIdleSeconds()).toBeNull();
        declare({ apiVersion: 1, name: 'Deck' });
        expect(hostReportsIdle()).toBe(false);
        expect(await hostIdleSeconds()).toBeNull();
    });

    it('passes the seconds through, sync or async, from the object that declared them', async () => {
        const host = { apiVersion: 1, name: 'Deck', last: 42, idleSeconds(this: { last: number }) { return this.last; } };
        declare(host);
        expect(hostReportsIdle()).toBe(true);
        expect(await hostIdleSeconds()).toBe(42);
        declare({ apiVersion: 1, name: 'Deck', idleSeconds: async () => 0 });
        expect(await hostIdleSeconds()).toBe(0);
    });

    it('takes "cannot tell right now" as no answer, which leaves the in-app path', async () => {
        declare({ apiVersion: 1, name: 'Deck', idleSeconds: () => null });
        expect(await hostIdleSeconds()).toBeNull();
        declare({ apiVersion: 1, name: 'Deck', idleSeconds: () => undefined });
        expect(await hostIdleSeconds()).toBeNull();
    });

    it('refuses an answer that is not a number of seconds, and a host that throws: the check waits instead', async () => {
        for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '30', {}]) {
            declare({ apiVersion: 1, name: 'Deck', idleSeconds: () => bad });
            await expect(hostIdleSeconds()).rejects.toThrow(TypeError);
        }
        declare({ apiVersion: 1, name: 'Deck', idleSeconds: () => { throw new Error('boom'); } });
        await expect(hostIdleSeconds()).rejects.toThrow('boom');
    });
});
