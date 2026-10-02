/**
 * Stream picture-in-picture, driven through the REAL Chat: which stream the
 * in-app float shows while streams are popped out to the OS window, and who
 * plays each watched stream's audio wherever the user is in the app.
 *
 * Triage 2026-10-02 (key "pip"), each reproduced or confirmed in code:
 *  - on the single-video engines (element PiP 'standard', Safari 'webkit')
 *    the float kept showing the SAME stream the OS window showed — the hide
 *    rule existed for the Doc-PiP grid only;
 *  - on the grid, popping ANY stream hid the float even when the stream it
 *    showed was not popped, so that stream was on screen nowhere;
 *  - in chat view only the first watched stream had audio (the float's one
 *    element), and in the voice view with the float up NO stream had any;
 *  - the [doc-pip] startup line that is meant to answer "does the desktop
 *    shell have Document PiP?" only ever reached the WebView console, which
 *    a release build does not keep.
 *
 * Audio here is ROUTING, never sound: which element is unmuted and bound to
 * which stream's audio track. Nothing in jsdom can play anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
    tauri: false, servers: [] as unknown[], channels: [] as unknown[],
    watching: [] as number[],
    data: new Map<number, { username: string; stream: MediaStream | null }>(),
    popouts: [] as number[],
    docPip: [] as number[][],
    invokes: [] as Array<[string, unknown]>,
    /** Audio tracks the stage's Web Audio graph took a source from. */
    graphed: [] as string[],
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: async (cmd: string, args?: unknown) => { h.invokes.push([cmd, args]); return null; },
}));
vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    decryptChannelContent: async (_channel: number, content: string) => content,
    decryptChannelMessages: async () => [],
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));
// Streams being watched, without a call behind them.
vi.mock('../components/voiceState', async importOriginal => ({
    ...(await importOriginal<typeof import('../components/voiceState')>()),
    getSelectedStreams: () => [...h.watching],
    getStreamData: (id: number) => h.data.get(id),
    getAllStreamers: () => [...h.data.entries()].map(([userId, d]) => ({ userId, ...d })),
    selectStream: () => {},
    deselectStream: (id: number) => { h.watching = h.watching.filter(x => x !== id); },
}));
// The OS-window hosts are probes: what matters here is which stream Chat
// popped, not the PiP machinery (streamPopout/streamDocPip tests cover that).
vi.mock('../components/StreamPopout', () => ({
    StreamPopout: ({ userId }: { userId: number }) => { h.popouts.push(userId); return <i data-testid="popout" data-user={userId} />; },
}));
vi.mock('../components/StreamDocPipWindow', () => ({
    StreamDocPipWindow: ({ userIds }: { userIds: number[] }) => { h.docPip.push(userIds); return <i data-testid="docpip" data-users={userIds.join(',')} />; },
}));
// Joining voice is not under test; the voice VIEW is.
vi.mock('../components/VoicePanel', () => ({ VoicePanel: () => null }));
vi.mock('../components/VoiceStage', () => ({ VoiceStage: () => <div data-testid="voice-stage" /> }));
vi.mock('../components/NotesDesktopView', () => ({ NotesDesktopView: () => null }));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = /\/servers$/.test(u) ? h.servers : /\/servers\/[^/]+\/channels$/.test(u) ? h.channels
        : /\/servers\/[^/]+\/unread$/.test(u) ? { channels: [] }
        : /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
}));

// The stage's Web Audio graph, enough of it to build and tear down. The
// setup file's base mock has no gain node and a close() with no promise.
class StageContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume = async () => {};
    close = async () => { this.state = 'closed'; };
    createMediaStreamSource(s: MediaStream) {
        void s; // the setup file's MediaStream drops constructor tracks
        h.graphed.push('source');
        return { connect() {}, disconnect() {} };
    }
    createGain() {
        return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} };
    }
}
vi.stubGlobal('AudioContext', StageContext);

const { Chat } = await import('../components/Chat');

const GENERAL = { id: 10, server_id: 's1', name: 'general', channel_type: 0, position: 0, parent_id: null };
const LOUNGE = { id: 11, server_id: 's1', name: 'lounge', channel_type: 1, position: 1, parent_id: null };

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    await settle();
}
async function settle() {
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}
const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 0)); });
    await settle();
};
const channelRow = (name: string) => [...host!.querySelectorAll<HTMLElement>('.channel')].find(el => el.textContent?.includes(name)) ?? null;
const float = () => host!.querySelector<HTMLElement>('.stream-pip');
const floatPopButton = () => [...(float()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find(b => /Pop out|Bring back/.test(b.title));

/** A watched share carrying system audio — one audio track per stream. */
function share(id: number) {
    const s = new MediaStream();
    s.addTrack({ kind: 'video', id: `v-${id}` } as MediaStreamTrack);
    s.addTrack({ kind: 'audio', id: `a-${id}` } as MediaStreamTrack);
    h.data.set(id, { username: `user-${id}`, stream: s });
    return s;
}
const audioTrackOf = (id: number) => h.data.get(id)!.stream!.getAudioTracks()[0];

/** Every media element in the page that would SOUND this stream's audio:
 *  unmuted and bound to a MediaStream carrying its audio track. */
function audiblePathsFor(id: number): HTMLMediaElement[] {
    const track = audioTrackOf(id);
    return [...document.querySelectorAll<HTMLMediaElement>('audio, video')].filter(el => {
        const src = el.srcObject as MediaStream | null;
        return !el.muted && !!src && typeof src.getAudioTracks === 'function' && src.getAudioTracks().includes(track);
    });
}

/** In a text channel, with the float up over it. */
async function intoChatWithFloat() {
    h.servers = [{ id: 's1', name: 'Alpha', owner_id: 99, icon_file_id: null }];
    h.channels = [GENERAL, LOUNGE];
    await mountChat();
    // Watching opened the stage; the text channel keeps the stream as the float.
    await click(channelRow('general'));
    expect(float()).not.toBeNull();
}

type PipWin = Window & { documentPictureInPicture?: unknown };
function installElementPip() {
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
        value: () => Promise.resolve({}), configurable: true, writable: true,
    });
}
function installDocPip() {
    installElementPip();
    (window as PipWin).documentPictureInPicture = { requestWindow: async () => window };
}

beforeEach(() => {
    h.tauri = false;
    h.servers = [];
    h.channels = [];
    h.watching = [];
    h.data.clear();
    h.popouts = [];
    h.docPip = [];
    h.invokes = [];
    h.graphed = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    delete (window as PipWin).documentPictureInPicture;
    delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled;
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestPictureInPicture;
    vi.restoreAllMocks();
});

describe('the in-app float never shows a stream that is in the OS window', () => {
    it('element PiP (the single-video engine): popping the float’s stream hides the float; bringing it back shows it', async () => {
        installElementPip();
        share(5);
        h.watching = [5];
        await intoChatWithFloat();
        expect(float()!.style.visibility).not.toBe('hidden');

        await click(floatPopButton());
        expect(host!.querySelector('[data-testid="popout"]')?.getAttribute('data-user')).toBe('5');
        // The OS window shows stream 5; a second copy in the app is the bug.
        expect(float()!.style.visibility).toBe('hidden');
    });

    it('the Doc-PiP grid: popping ONE of two watched streams keeps the float up, showing the other', async () => {
        installDocPip();
        share(5);
        share(6);
        h.watching = [5, 6];
        await intoChatWithFloat();
        expect(float()!.querySelector('.pip-streamer')!.textContent).toBe('user-5');

        await click(floatPopButton());
        expect(host!.querySelector('[data-testid="docpip"]')?.getAttribute('data-users')).toBe('5');
        // Stream 6 is watched and NOT popped: it must stay on screen.
        expect(float()!.style.visibility).not.toBe('hidden');
        expect(float()!.querySelector('.pip-streamer')!.textContent).toBe('user-6');
        expect((float()!.querySelector('video')!.srcObject as MediaStream)).toBe(h.data.get(6)!.stream);

        // Its Pop out now pops 6; with both in the grid the float hides.
        await click(floatPopButton());
        expect(host!.querySelector('[data-testid="docpip"]')?.getAttribute('data-users')).toBe('5,6');
        expect(float()!.style.visibility).toBe('hidden');
    });
});

describe('every watched stream is heard exactly once, wherever you are', () => {
    it('in a text channel with the float up: BOTH streams, one path each', async () => {
        share(5);
        share(6);
        h.watching = [5, 6];
        await intoChatWithFloat();
        expect(audiblePathsFor(5)).toHaveLength(1);
        expect(audiblePathsFor(6)).toHaveLength(1);
    });

    it('the float’s own <video> is never one of them: it is picture only', async () => {
        share(5);
        h.watching = [5];
        await intoChatWithFloat();
        expect(float()!.querySelector('video')!.muted).toBe(true);
    });

    it('on the stage the stage owns the audio: still one path per stream, never two', async () => {
        share(5);
        share(6);
        h.watching = [5, 6];
        h.servers = [{ id: 's1', name: 'Alpha', owner_id: 99, icon_file_id: null }];
        h.channels = [GENERAL, LOUNGE];
        await mountChat();
        expect(host!.querySelector('.stream-stage')).not.toBeNull();
        expect(h.graphed).toHaveLength(2); // positive control: the stage IS playing them
        expect(audiblePathsFor(5).length).toBeLessThanOrEqual(1);
        expect(audiblePathsFor(6).length).toBeLessThanOrEqual(1);
        // Whatever the stage plays through, the always-mounted host is not it.
        for (const el of document.querySelectorAll<HTMLAudioElement>('audio[data-stream-audio]')) {
            expect(el.muted).toBe(true);
        }
    });

    it('in the voice view with the float up (no stage, no float mounted): still every stream', async () => {
        share(5);
        share(6);
        h.watching = [5, 6];
        await intoChatWithFloat();
        await click(channelRow('lounge')); // join
        await click(channelRow('lounge')); // already connected: the voice view
        expect(host!.querySelector('[data-testid="voice-stage"]')).not.toBeNull();
        expect(float()).toBeNull();
        expect(audiblePathsFor(5)).toHaveLength(1);
        expect(audiblePathsFor(6)).toHaveLength(1);
    });
});

describe('the desktop log answers the open Doc-PiP question', () => {
    const diagLines = () => h.invokes
        .filter(([cmd]) => cmd === 'log_stream_diag')
        .map(([, args]) => (args as { line: string }).line);

    it('desktop: whether this runtime has Document PiP reaches puca.log at startup', async () => {
        h.tauri = true;
        await mountChat();
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(diagLines().some(l => /\[doc-pip\] documentPictureInPicture is absent/.test(l))).toBe(true);
    });

    it('web: nothing is sent to a shell that is not there', async () => {
        await mountChat();
        expect(diagLines()).toEqual([]);
    });
});
