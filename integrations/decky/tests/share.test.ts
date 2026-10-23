/**
 * Sharing the Deck's screen, without a Deck: when the page may have the
 * screen, when the picture pauses, and how the page reads what it is handed.
 * The live half (gamescope's feed, the encoder, Steam's browser decoding it)
 * is checked on a Deck; see docs/STEAM_DECK.md.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPageMessage, readState } from '../src/protocol';
import {
    ARM_MS, ASK_MS, pauseReason, readScreenSignals, SHARE_POLL_MS, ShareArming, STEAM_APPID, type ScreenSignals,
} from '../src/share';
import { codecOf, fromBase64 } from '../src/shim/h264';

const GAME = 1245620;
const clear: ScreenSignals = { viewOpen: false, sideMenu: 0, keyboard: false, notification: false, focusedAppId: GAME };

describe('when the shared picture pauses', () => {
    it('shows the game only while nothing else is on screen', () => {
        expect(pauseReason(clear)).toBeNull();
        expect(pauseReason({ ...clear, viewOpen: true })).toBe('puca');
        expect(pauseReason({ ...clear, sideMenu: 1 })).toBe('menu');
        expect(pauseReason({ ...clear, sideMenu: 2 })).toBe('menu');
        expect(pauseReason({ ...clear, keyboard: true })).toBe('keyboard');
        expect(pauseReason({ ...clear, notification: true })).toBe('notification');
        expect(pauseReason({ ...clear, focusedAppId: STEAM_APPID })).toBe('steam');
    });

    it('pauses when it cannot tell: a moved signal must not show what it hides', () => {
        expect(pauseReason({ ...clear, sideMenu: null })).toBe('menu');
        expect(pauseReason({ ...clear, keyboard: null })).toBe('keyboard');
        expect(pauseReason({ ...clear, notification: null })).toBe('notification');
        expect(pauseReason({ ...clear, focusedAppId: null })).toBe('steam');
    });

    it("reads Steam's own state the way SteamOS keeps it", () => {
        // Steam's observable values: a Value getter on the prototype.
        class Observable<T> {
            constructor(private v: T) {}
            get Value(): T { return this.v; }
        }
        const steam = (over: { menu?: number; keyboard?: boolean; focused?: number; toast?: object | null } = {}) => ({
            MenuStore: { m_eOpenSideMenu: over.menu ?? 0 },
            VirtualKeyboardManager: { m_bIsVirtualKeyboardShowing: new Observable(over.keyboard ?? false) },
            m_CompositionStateStore: { m_currentlyFocusedAppid: new Observable(over.focused ?? GAME) },
        });
        const toasts = (toast: object | null = null) => ({ m_valueCurrentToast: new Observable(toast) });
        expect(readScreenSignals(steam(), toasts(), false)).toEqual(clear);
        expect(pauseReason(readScreenSignals(steam(), toasts(), false))).toBeNull();
        expect(pauseReason(readScreenSignals(steam({ menu: 2 }), toasts(), false))).toBe('menu');
        expect(pauseReason(readScreenSignals(steam({ keyboard: true }), toasts(), false))).toBe('keyboard');
        expect(pauseReason(readScreenSignals(steam(), toasts({ title: 'Message' }), false))).toBe('notification');
        expect(pauseReason(readScreenSignals(steam({ focused: STEAM_APPID }), toasts(), false))).toBe('steam');
        expect(pauseReason(readScreenSignals(steam(), toasts(), true))).toBe('puca');
        // Nothing to read at all: everything unknown, so paused.
        expect(readScreenSignals(undefined, undefined, false))
            .toEqual({ viewOpen: false, sideMenu: null, keyboard: null, notification: null, focusedAppId: null });
        expect(pauseReason(readScreenSignals({}, {}, false))).not.toBeNull();
    });

    it("looks often enough for the backend's rule: two looks at most MAX_GAP_S apart vouch for a picture", () => {
        const py = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'py_modules', 'puca_share.py'), 'utf8');
        const gapS = Number(/^MAX_GAP_S = ([0-9.]+)/m.exec(py)?.[1]);
        expect(gapS * 1000).toBeGreaterThanOrEqual(2 * SHARE_POLL_MS); // one late look is borne
        expect(gapS * 1000).toBeLessThanOrEqual(3 * SHARE_POLL_MS); // a long gap vouches for nothing
    });
});

describe('whose press a share request is', () => {
    it("starts the page's request after the panel's Share screen, once", () => {
        const a = new ShareArming();
        a.arm(1000);
        expect(a.request('s1', 1000 + ARM_MS - 1)).toEqual({ start: 's1' });
        expect(a.request('s2', 1000 + ARM_MS - 1)).toEqual({ ask: 's2', refuse: null });
    });

    it('asks the person about a request nobody pressed for', () => {
        const a = new ShareArming();
        expect(a.request('s1', 0)).toEqual({ ask: 's1', refuse: null });
        a.arm(0);
        a.disarm();
        expect(a.request('s2', 10)).toEqual({ ask: 's2', refuse: 's1' });
        expect(a.pending(10)).toBe('s2');
        expect(a.take(20)).toBe('s2');
        expect(a.pending(20)).toBeNull();
    });

    it('an arming runs out, and so does a question', () => {
        const a = new ShareArming();
        a.arm(0);
        expect(a.request('s1', ARM_MS)).toEqual({ ask: 's1', refuse: null });
        expect(a.expire(ASK_MS - 1 + ARM_MS)).toBeNull();
        expect(a.take(ARM_MS + ASK_MS)).toBeNull();
        const b = new ShareArming();
        b.request('s2', 0);
        expect(b.expire(ASK_MS)).toBe('s2');
        expect(b.expire(ASK_MS + 1)).toBeNull();
    });

    it('the page can withdraw only its own request', () => {
        const a = new ShareArming();
        a.request('s1', 0);
        expect(a.withdraw('s2')).toBe(false);
        expect(a.withdraw('s1')).toBe(true);
        expect(a.pending(1)).toBeNull();
    });
});

describe('the picture the page is handed', () => {
    // What the Deck's encoder sends (measured): AUD, SPS (High, constraint 0x0c, level 3.2), PPS, SEI, IDR.
    const key = Uint8Array.from([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x64, 0x0c, 0x20, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88]);

    it('names its codec from the sequence parameter set', () => {
        expect(codecOf(key)).toBe('avc1.640c20');
        expect(codecOf(Uint8Array.from([0, 0, 1, 0x27, 0x42, 0xe0, 0x1f, 0x00]))).toBe('avc1.42e01f');
        expect(codecOf(Uint8Array.from([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x41, 0x9a]))).toBeNull();
        expect(codecOf(Uint8Array.from([0, 0, 1, 0x67, 0x64]))).toBeNull();
    });

    it('reads the base64 the backend sends', () => {
        expect([...fromBase64('AAABCfA=')]).toEqual([0, 0, 1, 9, 0xf0]);
        expect(fromBase64('').length).toBe(0);
    });
});

describe('what the page says about sharing', () => {
    it('reads its requests for the screen', () => {
        expect(readPageMessage({ type: 'share-request', id: 'slz1' })).toEqual({ type: 'share-request', id: 'slz1' });
        expect(readPageMessage({ type: 'share-release', id: 'slz1' })).toEqual({ type: 'share-release', id: 'slz1' });
        expect(readPageMessage({ type: 'share-request', id: '../x' })).toBeNull();
        expect(readPageMessage({ type: 'share-request' })).toBeNull();
    });

    it('reads whether the call is shared, false from a page that does not say', () => {
        const state = (call: Record<string, unknown>) => readState({ apiVersion: 1, call: { channelId: 3, ...call } })?.call?.sharing;
        expect(state({ sharing: true })).toBe(true);
        expect(state({ sharing: 'yes' })).toBe(false);
        expect(state({})).toBe(false);
    });
});

// ---- The wiring, in the source text (like frontend/src/tests/hostShareWiring.test.ts) ----

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SRC = { shim: stripComments(read('src/shim/pageShim.ts')), controller: stripComments(read('src/controller.ts')) };
const replace = (from: string, to: string) => (code: string) => code.replace(from, to);

interface Pin {
    name: string;
    src: keyof typeof SRC;
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: 'the page is offered the screen only where this browser can make the track',
        src: 'shim',
        holds: c => c.includes("const canShare = typeof Generator === 'function' && typeof VideoDecoder === 'function'")
            && c.includes('...(canShare ? { getDisplayMedia } : {}),'),
        mutants: [
            ['always offered', replace('...(canShare ? { getDisplayMedia } : {}),', 'getDisplayMedia,')],
            ['no check for a decoder', replace("typeof Generator === 'function' && typeof VideoDecoder === 'function'", "typeof Generator === 'function'")],
        ],
    },
    {
        name: 'a frame decoded after a pause began is never shown',
        src: 'shim',
        holds: c => c.includes('output: frame => { if (s.paused || s.released) frame.close(); else write(id, s, frame); },')
            && /if \(s\.paused \|\| typeof data !== 'string' \|\| \(!key && s\.needKey\)\) return false;/.test(c),
        mutants: [
            ['decoded frames always shown', replace('if (s.paused || s.released) frame.close(); else write(id, s, frame);', 'write(id, s, frame);')],
            ['chunks decoded while paused', replace("if (s.paused || typeof data !== 'string'", "if (typeof data !== 'string'")],
        ],
    },
    {
        name: "Púca letting go of the track stops the capture, and a stopped share's chunks are refused",
        src: 'shim',
        holds: c => c.includes('track.stop = () => { stop(); releaseShare(id); };')
            && c.includes('if (!s || s.released || !s.writer) return null;')
            && /if \(tell\) send\(\{ type: 'share-release', id \}\);/.test(c),
        mutants: [
            ['stop never reported', replace('track.stop = () => { stop(); releaseShare(id); };', '')],
            ['unknown shares take chunks', replace('if (!s || s.released || !s.writer) return null;', 'if (!s || s.released || !s.writer) return false;')],
        ],
    },
    {
        name: 'a paused share shows the card, again every second, and every share starts paused',
        src: 'shim',
        holds: c => /s\.needKey = true;\n\s*write\(id, s, card\(\)\);\n\s*s\.cardTimer = setInterval\(\(\) => write\(id, s, card\(\)\), 1000\);/.test(c)
            && /s\.writer = track\.writable\.getWriter\(\);\n\s*setPaused\(id, s, true\);/.test(c),
        mutants: [
            ['no card', replace('        write(id, s, card());\n        s.cardTimer', '        s.cardTimer')],
            ['no new keyframe after a pause', replace('        s.needKey = true;\n        write(id, s, card());', '        write(id, s, card());')],
            ['starts showing', code => code.replace(/(s\.writer = track\.writable\.getWriter\(\);)\s*setPaused\(id, s, true\);/, '$1')],
        ],
    },
    {
        name: "the person's no and a share that could not start are told apart",
        src: 'shim',
        holds: c => c.includes("else reject(new DOMException(error ?? 'not allowed', refused ? 'NotAllowedError' : 'NotReadableError'));")
            && c.includes("s.answered(ok === true, typeof error === 'string' ? error.slice(0, 200) : null, refused !== false);"),
        mutants: [
            ['everything a refusal', replace("refused ? 'NotAllowedError' : 'NotReadableError'", "'NotAllowedError'")],
            ['a missing flag taken as a failure', replace('null, refused !== false);', 'null, refused === true);')],
        ],
    },
    {
        name: "only the panel's own press starts a share",
        src: 'controller',
        holds: c => /const d = this\.arming\.request\(id, Date\.now\(\)\);\n\s*if \('start' in d\) \{\n\s*void this\.beginShare\(d\.start\);/.test(c)
            && /this\.arming\.arm\(Date\.now\(\)\);\n\s*const r = await this\.pageCall<[^>]+>\('startShare'\);\n\s*this\.arming\.disarm\(\);/.test(c),
        mutants: [
            ['every request starts', replace("if ('start' in d) {", 'if (true) {')],
            ['armed for good', replace("const r = await this.pageCall<{ ok: boolean; error?: string }>('startShare');\n        this.arming.disarm();", "const r = await this.pageCall<{ ok: boolean; error?: string }>('startShare');")],
        ],
    },
    {
        name: 'every look goes to the backend, with when it was taken, not only a change',
        src: 'controller',
        holds: c => /const at = Date\.now\(\);\n\s*const reason = this\.screenPause\(\);/.test(c)
            && /\n\s*void call<\[boolean, number\], void>\('share_seen', reason === null, at\)\.catch/.test(c)
            && /this\.sharePoll = setInterval\(\(\) => this\.checkSharePause\(\), SHARE_POLL_MS\);\n\s*this\.checkSharePause\(\);/.test(c),
        mutants: [
            ['only on a change', replace("        void call<[boolean, number], void>('share_seen', reason === null, at)",
                "        if (reason !== this.snap.sharePaused) void call<[boolean, number], void>('share_seen', reason === null, at)")],
            ['the time of sending, not of looking', replace('        const at = Date.now();\n        const reason = this.screenPause();',
                '        const reason = this.screenPause();\n        const at = Date.now() + 50;')],
            ['no first look', replace('this.sharePoll = setInterval(() => this.checkSharePause(), SHARE_POLL_MS);\n        this.checkSharePause();',
                'this.sharePoll = setInterval(() => this.checkSharePause(), SHARE_POLL_MS);')],
        ],
    },
    {
        name: 'opening Púca pauses a share before the view is drawn',
        src: 'controller',
        holds: c => /if \(!this\.snap\.viewOpen\) \{\n[^}]*this\.update\(\{ viewOpen: true \}\);\n\s*this\.checkSharePause\(\);[\s\S]*?\}\n\s*this\.view\.show\(rect\);/.test(c),
        mutants: [
            ['not checked', replace("this.update({ viewOpen: true });\n            this.checkSharePause();", "this.update({ viewOpen: true });")],
        ],
    },
];

describe.each(PINS)('$name', ({ src, holds, mutants }) => {
    const code = SRC[src];
    it('holds in the source', () => {
        expect(holds(code)).toBe(true);
    });
    it.each(mutants)('goes red when %s', (_label, mutate) => {
        const mutated = mutate(code);
        expect(mutated, 'the mutation must actually change the source').not.toBe(code);
        expect(holds(mutated)).toBe(false);
    });
});
