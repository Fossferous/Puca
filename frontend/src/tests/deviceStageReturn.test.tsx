/**
 * The way back to a minimised remote-control session (components/DeviceStageReturn.tsx).
 * The owner's report (2026-11-22): the minimised stage was a blue pill reading
 * "Return to remote device (ds7babefb5bd2042d38d9c)" fixed over the bottom-right
 * corner, which on a phone with the keyboard up is the message box. It is now a
 * real button in a strip the layout makes room for: named for the computer,
 * never by the session's id, and its height published for the reservations
 * that keep the composer and every panel above it. Where it lands on screen is
 * e2e/return-pill-live.mjs's (the real app in a real browser); this pins the
 * words, the element and the measured height.
 *
 * The rig is deviceStageBackMenu.test.tsx's (a 390x844 coarse-pointer phone, a
 * played session layer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    storage: new Map<string, string>(),
    /** Held Back layers, oldest first (api/mobileApp.ts interceptBack). */
    layers: [] as Array<() => void>,
    /** Every input the stage sent, by session. */
    sent: [] as Array<{ id: string; ev: unknown }>,
}));

vi.mock('../api/devices/session', () => ({
    sendViewSize: () => {},
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: () => () => {},
    setCaretTracking: () => {},
    sendInput: (id: string, ev: unknown) => { h.sent.push({ id, ev }); },
    requestMonitor: () => {},
    requestKeyframe: () => true,
    setCursorOwned: () => {},
    endSession: () => {},
    sendClipboard: async () => null,
    sendStreamQuality: () => {},
    setPrivacyMode: () => {},
    sendPowerAction: () => true,
    deviceDiagnosticsWindow: async () => [],
    activeSessions: () => [],
    requestFileAccess: () => {},
    deviceStatsSample: async () => null,
    latencyProbeUsable: () => false,
    sendLatencyProbe: () => false,
    noteFramePresented: () => {},
    subscribeLatency: () => () => {},
}));
vi.mock('../api/devices/tunnel', () => ({
    tunnelStatus: async () => ({ inbound_streams: 0, outbound_streams: 0, forwards: [] }),
}));
vi.mock('../api/devices/chords', () => ({ sendChord: () => true }));
vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isMobile: () => true, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => {},
}));
vi.mock('../api/mobileApp', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/mobileApp')>();
    return {
        ...real,
        showMobileKeyboard: async () => true,
        interceptBack: (onBack: () => void) => {
            h.layers.push(onBack);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                const i = h.layers.indexOf(onBack);
                if (i >= 0) h.layers.splice(i, 1);
            };
        },
    };
});

const { DeviceStage } = await import('../components/DeviceStage');
const { setChatRoot } = await import('../components/chatRoot');

const BOX = { left: 0, top: 0, width: 390, height: 844 };
beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.height });
    HTMLElement.prototype.getBoundingClientRect = () => ({
        ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON() { return this; },
    }) as DOMRect;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {} unobserve() {} disconnect() {}
    };
    window.matchMedia = (() => ({
        matches: true, media: '', onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    h.storage.set('device-stage-mouse-mode', 'touch');
    (localStorage.getItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string) => h.storage.get(k) ?? null);
    (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.layers = [];
    h.sent = [];
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let chat: HTMLDivElement | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    act(() => setChatRoot(null));
    chat?.remove();
    chat = null;
});

/** Chat's root on the page, handed over as Chat's ref does (chatRoot.ts). */
function chatOnPage(): HTMLDivElement {
    chat = document.createElement('div');
    chat.className = 'chat-container';
    document.body.appendChild(chat);
    act(() => setChatRoot(chat));
    return chat;
}

function session(over: Snapshot = {}): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }], activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: true, handoverFrom: null,
        ...over,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

async function mountWith(s: Snapshot) {
    h.snapshot = [s];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
}

async function publish(s: Snapshot[]) {
    h.snapshot = s;
    await act(async () => { for (const l of h.listeners) l(s); });
    await flush();
}

const toolbarButton = (title: string) => {
    const b = host!.querySelector<HTMLButtonElement>(`.device-stage-mobile-toolbar button[title="${title}"]`);
    expect(b, `the toolbar's ${title}`).toBeTruthy();
    return b!;
};
const tap = async (b: HTMLElement) => { await act(async () => { b.click(); }); await flush(); };

const strip = () => host!.querySelector<HTMLElement>('.device-stage-minimized-strip');
const wayBack = () => host!.querySelector<HTMLElement>('.device-stage-minimized');
const heightVar = () => document.documentElement.style.getPropertyValue('--device-return-h');

describe('minimised to the chat, the stage is a button named for the PC', () => {
    it("is a real button reading 'Return to <the PC>', with no session id anywhere, and a press brings the stage back", async () => {
        await mountWith(session({ id: 'ds7babefb5bd2042d38d9c', peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        const b = wayBack();
        expect(b, 'the way back is drawn').toBeTruthy();
        expect(b!.tagName, 'a button: Tab reaches it, Enter and Space press it').toBe('BUTTON');
        expect(b!.getAttribute('type')).toBe('button');
        expect(b!.textContent!.trim()).toBe('Return to Office PC');
        expect(host!.textContent, 'the session id is on no part of it').not.toContain('ds7babefb5bd2042d38d9c');
        expect(strip()!.contains(b!), 'inside the strip the layout makes room for').toBe(true);
        expect(host!.querySelector('.device-stage'), 'the stage is away').toBeNull();
        await tap(b!);
        expect(host!.querySelector('.device-stage'), 'the stage is back').toBeTruthy();
        expect(wayBack(), 'and the way back is gone').toBeNull();
    });

    it("with no name for the PC it says 'the remote computer', and follows a name that arrives later", async () => {
        await mountWith(session({ id: 'ds-1', peerName: null }));
        await tap(toolbarButton('Chat'));
        expect(wayBack()!.textContent!.trim()).toBe('Return to the remote computer');
        expect(host!.textContent).not.toContain('ds-1');
        await publish([session({ id: 'ds-1', peerName: '  Den laptop ' })]);
        expect(wayBack()!.textContent!.trim(), 'the name as the session layer has it, trimmed').toBe('Return to Den laptop');
        await publish([session({ id: 'ds-1', peerName: '   ' })]);
        expect(wayBack()!.textContent!.trim(), 'a blank name is no name').toBe('Return to the remote computer');
    });

    it('a key pressed on it is left to the button (the stage forwards nothing while minimised)', async () => {
        await mountWith(session({ peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        for (const key of ['Enter', ' ']) {
            const ev = new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true });
            await act(async () => { wayBack()!.dispatchEvent(ev); });
            expect(ev.defaultPrevented, `${key === ' ' ? 'Space' : 'Enter'} is not taken from the button`).toBe(false);
        }
    });

    it('publishes its height for the reservations while it is up, and takes it away when the stage comes back or the session ends', async () => {
        document.documentElement.style.removeProperty('--device-return-h');
        await mountWith(session({ peerName: 'Office PC' }));
        expect(heightVar(), 'nothing reserved while the stage is up').toBe('');
        await tap(toolbarButton('Chat'));
        expect(heightVar(), 'its measured height, in px').toBe(`${BOX.height}px`);
        await tap(wayBack()!);
        expect(heightVar(), 'the stage is back: nothing reserved').toBe('');
        await tap(toolbarButton('Chat'));
        expect(heightVar()).toBe(`${BOX.height}px`);
        await publish([]);
        expect(wayBack(), 'the session ended').toBeNull();
        expect(heightVar(), 'and the room it held is given back').toBe('');
    });
});

/**
 * On a phone `.chat-container` is a stacking context that holds every dialog
 * Chat opens (mobile.css fixes it to the screen), and the strip, mounted
 * beside Chat at z 250, was drawn over all of them: the member profile
 * sheet's foot, Edit Channel's, a band of Settings and Create Channel's
 * backdrop were the strip under a tap (the review of 2026-11-22). It is drawn
 * inside Chat's root now; where that puts it on screen is
 * e2e/return-pill-live.mjs's `dialogs`.
 */
describe("drawn inside Chat's root, among Chat's own layers", () => {
    it('with Chat on the page the strip is inside .chat-container, measured, and its press brings the stage back', async () => {
        document.documentElement.style.removeProperty('--device-return-h');
        const c = chatOnPage();
        await mountWith(session({ peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        const inChat = c.querySelector<HTMLElement>('.device-stage-minimized-strip');
        expect(inChat, "the strip is drawn inside Chat's root").toBeTruthy();
        expect(strip(), 'and not where it is mounted').toBeNull();
        expect(inChat!.textContent!.trim()).toBe('Return to Office PC');
        expect(heightVar(), 'its height is published from there').toBe(`${BOX.height}px`);
        await tap(c.querySelector<HTMLElement>('.device-stage-minimized')!);
        expect(host!.querySelector('.device-stage'), 'the stage is back').toBeTruthy();
        expect(c.querySelector('.device-stage-minimized-strip'), 'and the strip gone from Chat').toBeNull();
        expect(heightVar(), 'nothing reserved').toBe('');
    });

    it('Chat going away draws it where it is mounted, and Chat coming back draws it inside again, measured each time', async () => {
        document.documentElement.style.removeProperty('--device-return-h');
        await mountWith(session({ peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        expect(strip(), 'no Chat: drawn where it is mounted').toBeTruthy();
        const c = chatOnPage();
        await flush();
        expect(c.querySelector('.device-stage-minimized-strip'), 'Chat mounted: drawn inside it').toBeTruthy();
        expect(strip()).toBeNull();
        expect(heightVar()).toBe(`${BOX.height}px`);
        act(() => setChatRoot(null));
        await flush();
        expect(strip(), 'Chat gone: back where it is mounted, still there').toBeTruthy();
        expect(c.querySelector('.device-stage-minimized-strip')).toBeNull();
        expect(heightVar(), 'and still measured').toBe(`${BOX.height}px`);
    });
});

/**
 * Put away was only ever undone by the strip's own press: a session that
 * ended while away left the stage put away, so the next Connect showed only
 * a "Return to" bar, and a second PC connected while the first was away came
 * up as that bar too (the review of 2026-11-22).
 */
describe('a session that newly takes the stage is shown, not put away', () => {
    it('after a session ends while put away, the next one opens as the stage', async () => {
        await mountWith(session({ id: 'ds-a', peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        expect(wayBack(), 'put away').toBeTruthy();
        await publish([]);
        expect(wayBack(), 'the session ended: nothing left on screen').toBeNull();
        await publish([session({ id: 'ds-b', peerName: 'Den laptop' })]);
        expect(host!.querySelector('.device-stage'), 'the new session is on the stage').toBeTruthy();
        expect(wayBack(), 'and not behind a "Return to" bar').toBeNull();
    });

    it('a second PC connected while the first is put away takes the stage', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        await tap(toolbarButton('Chat'));
        expect(wayBack()!.textContent!.trim()).toBe('Return to Office PC');
        await publish([a, session({ id: 'ds-b', peerName: 'Den laptop' })]);
        expect(host!.querySelector('.device-stage'), "the new PC's session is on the stage").toBeTruthy();
        expect(wayBack(), 'not put away').toBeNull();
    });

    it('CONTROL: the same session coming through again (reconnecting, its next snapshot) stays put away', async () => {
        await mountWith(session({ id: 'ds-a', peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        await publish([session({ id: 'ds-a', peerName: 'Office PC', reconnecting: true })]);
        expect(wayBack(), 'reconnecting: still put away').toBeTruthy();
        await publish([session({ id: 'ds-a', peerName: 'Office PC' })]);
        expect(wayBack(), 'back: still put away').toBeTruthy();
        expect(host!.querySelector('.device-stage'), 'the stage stays away').toBeNull();
    });
});

/**
 * Put away belongs to the SESSION that was put away, not to the stage (the
 * review of 2026-11-22, round 2). It was one boolean, cleared whenever a
 * different session id took the stage: PC A put away, PC B connected (shown),
 * B put away too, then B ended, and A, falling back onto the stage, was put
 * back on screen over the chat with nobody asking, control armed, so the next
 * tap aimed at the chat went to PC A. And the follows that carry a session on
 * by themselves (somebody signing in at a put-away PC's sign-in screen, a
 * Lock, the locked-poll: wakeSession.followToDesktop / followToSignIn) open a
 * new session with a new id, which popped up the same way.
 */
describe('put away is the session\'s own: an older one coming back stays away', () => {
    const keyInChat = async () => {
        const before = h.sent.length;
        const ev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
        await act(async () => { window.dispatchEvent(ev); });
        return h.sent.slice(before);
    };

    it('A put away, B connected and put away, B ends: A is still put away and nothing goes to it', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        await tap(toolbarButton('Chat'));
        const b = session({ id: 'ds-b', peerName: 'Den laptop' });
        await publish([a, b]);
        expect(host!.querySelector('.device-stage'), "B's session is on the stage (the premise)").toBeTruthy();
        await tap(toolbarButton('Chat'));
        expect(wayBack()!.textContent!.trim()).toBe('Return to Den laptop');
        await publish([a]);
        expect(host!.querySelector('.device-stage'), "A's stage is not put back over the chat").toBeNull();
        expect(wayBack()?.textContent?.trim(), 'the way back now names A').toBe('Return to Office PC');
        expect(await keyInChat(), 'a key typed in the chat goes to no PC').toEqual([]);
        await tap(wayBack()!);
        expect(host!.querySelector('.device-stage'), 'its own press brings A back').toBeTruthy();
    });

    it('A put away, B on screen and ended there: A is still put away', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        await tap(toolbarButton('Chat'));
        await publish([a, session({ id: 'ds-b', peerName: 'Den laptop' })]);
        expect(host!.querySelector('.device-stage'), "B's session is on the stage (the premise)").toBeTruthy();
        await publish([a]);
        expect(host!.querySelector('.device-stage'), 'A was put away and stays away').toBeNull();
        expect(wayBack()?.textContent?.trim()).toBe('Return to Office PC');
        expect(await keyInChat()).toEqual([]);
    });

    it('CONTROL: A never put away comes back on screen when B ends', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        await publish([a, session({ id: 'ds-b', peerName: 'Den laptop' })]);
        await tap(toolbarButton('Chat'));
        expect(wayBack()!.textContent!.trim(), 'B put away (the premise)').toBe('Return to Den laptop');
        await publish([a]);
        expect(host!.querySelector('.device-stage'), 'A was on the stage before B, and is again').toBeTruthy();
        expect(wayBack()).toBeNull();
    });

    it('a session handed over from a put-away one (a sign-in, a Lock) is put away too, named for its PC', async () => {
        await mountWith(session({ id: 'ds-a', peerName: 'Office PC (sign-in screen)' }));
        await tap(toolbarButton('Chat'));
        // The sign-in screen's session ends with the handover, and the follow
        // opens the desktop's a moment (or up to two minutes) later.
        await publish([]);
        expect(wayBack(), 'nothing on screen between the two').toBeNull();
        await publish([session({ id: 'ds-a2', peerName: 'Office PC', handoverFrom: 'ds-a' })]);
        expect(host!.querySelector('.device-stage'), 'the follow does not pop up over the chat').toBeNull();
        expect(wayBack()?.textContent?.trim()).toBe('Return to Office PC');
        expect(await keyInChat(), 'and nothing goes to it').toEqual([]);
        await tap(wayBack()!);
        expect(host!.querySelector('.device-stage'), 'its press brings the followed session back').toBeTruthy();
        // And a follow of THAT one, once it is on screen again, is on screen.
        await publish([session({ id: 'ds-a3', peerName: 'Office PC (sign-in screen)', handoverFrom: 'ds-a2' })]);
        expect(host!.querySelector('.device-stage'), 'a follow of a session on screen is on screen').toBeTruthy();
        expect(wayBack()).toBeNull();
    });

    it('CONTROL: a follow of a session that was on screen opens on screen', async () => {
        await mountWith(session({ id: 'ds-a', peerName: 'Office PC' }));
        await publish([]);
        await publish([session({ id: 'ds-a2', peerName: 'Office PC (sign-in screen)', handoverFrom: 'ds-a' })]);
        expect(host!.querySelector('.device-stage')).toBeTruthy();
        expect(wayBack()).toBeNull();
    });
});
