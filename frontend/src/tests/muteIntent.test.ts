/**
 * A member who muted themselves is never made live by the app.
 *
 * When a member's microphone dies mid-call the call goes listen-only, which
 * mutes them; when a microphone comes back the call re-opens it. That
 * recovery used to UNMUTE unconditionally (VoicePanel applyNoiseModeLive:
 * `setIsMuted(false)`), so a member who had muted themselves - or deafened,
 * which mutes - before the microphone died came back LIVE without touching
 * anything, and one who wanted to stay muted could not even say so: the Mute
 * button and the Toggle Mute key did nothing while listen-only. A moderator's
 * "Move to" had the same shape: the destination mounts a new voice panel, and
 * a new panel joined with a fresh, open microphone.
 *
 * The panel now keeps the member's OWN choice (`selfMuted`) apart from the
 * mute in force (`isMuted`, which also covers the mutes the call imposes:
 * listen-only, no SPEAK, an AFK channel), and lifting an imposed mute restores
 * that choice. Reproduced live first (e2e/mute-intent-live.mjs, red on the
 * build before this change: the muted, muted-while-listen-only, deafened and
 * moved members all came back audible to the other side).
 *
 * Three layers here:
 *   - MediaManager.reacquireAudioTrack: a capture that ends listen-only comes
 *     up SHUT, whatever the dead track's gate said (behaviour, real code);
 *   - voiceState's carried choice: one-shot, for the room it was carried to
 *     (behaviour, real code);
 *   - VoicePanel / Chat wiring, which only the live rig otherwise exercises
 *     (VoicePanel is not mountable under vitest): pinned in the source text,
 *     each pin checked against mutated copies of the source so a pin that
 *     could not fail fails its own mutation case. Comments are stripped
 *     first: prose that mentions a call does not count as the call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MediaManager } from '../api/rtc/media';
import { publishSelfVoiceChoice, carrySelfVoiceChoiceTo, takeCarriedVoiceChoice } from '../components/voiceState';

// ── MediaManager: out of listen-only, the new capture starts shut ─────────

class FakeTrack extends EventTarget {
    kind = 'audio';
    enabled = true;
    muted = false;
    readyState: 'live' | 'ended' = 'live';
    label = 'Default - Microphone (Fake)';
    getSettings() { return { deviceId: 'default', groupId: 'grp-fake' }; }
    stop() { this.readyState = 'ended'; }
}
class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return [] as FakeTrack[]; }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* not needed */ }
    removeEventListener() { /* not needed */ }
}
const notFound = () => new DOMException('Requested device not found', 'NotFoundError');

describe('MediaManager.reacquireAudioTrack out of listen-only', () => {
    let getUserMedia: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        getUserMedia = vi.fn();
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        // (The listen-only join's empty `new MediaStream()` is setup.ts's mock.)
        localStorage.clear();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the microphone died with the gate OPEN (an unmuted member): the one that comes back starts SHUT', async () => {
        const dead = new FakeTrack();
        const back = new FakeTrack();
        getUserMedia.mockResolvedValueOnce(new FakeStream([dead]))
            .mockRejectedValueOnce(notFound())
            .mockResolvedValueOnce(new FakeStream([back]));
        const media = new MediaManager();
        const stream = await media.getLocalStream(true, false);
        dead.readyState = 'ended'; // the OS took it; its gate stays open
        await expect(media.reacquireAudioTrack()).resolves.toBeNull();
        expect(media.isListenOnly()).toBe(true);
        // Meanwhile the member pressed Mute: VoicePanel records it as their
        // choice, and nothing reaches a track (there is none to gate).
        const res = await media.reacquireAudioTrack();
        expect(res?.newTrack).toBe(back as unknown as MediaStreamTrack);
        expect(media.isListenOnly()).toBe(false);
        // What replaceTrack puts on every mesh sender, and the SFU publishes,
        // before VoicePanel opens it from the member's own choice.
        expect(back.enabled).toBe(false);
        expect(stream.getAudioTracks()).toEqual([back]);
    });

    it('joined with no microphone at all: the first one plugged in starts SHUT (there was no gate, only a `true` default)', async () => {
        const first = new FakeTrack();
        getUserMedia.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(new FakeStream([first]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        expect(media.isListenOnly()).toBe(true);
        const res = await media.reacquireAudioTrack();
        expect(res?.newTrack).toBe(first as unknown as MediaStreamTrack);
        expect(first.enabled).toBe(false);
    });

    it('control: outside listen-only the new capture still carries the gate - open stays open, shut stays shut', async () => {
        const old = new FakeTrack();
        const a = new FakeTrack();
        const b = new FakeTrack();
        b.enabled = true;
        getUserMedia.mockResolvedValueOnce(new FakeStream([old]))
            .mockResolvedValueOnce(new FakeStream([a]))
            .mockResolvedValueOnce(new FakeStream([b]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        a.enabled = false; // proves the stamp, not the default, opened it
        await media.reacquireAudioTrack(); // a noise-mode change on an open mic
        expect(a.enabled).toBe(true);
        a.enabled = false; // the member mutes
        await media.reacquireAudioTrack();
        expect(b.enabled).toBe(false);
    });
});

// ── voiceState: the choice a moderator's move carries ─────────────────────

describe("the member's own choice, carried by a move they did not make", () => {
    beforeEach(() => { takeCarriedVoiceChoice('voice_0'); });

    it('the next join of the destination takes it, once', () => {
        publishSelfVoiceChoice({ muted: true, deafened: false });
        carrySelfVoiceChoiceTo('voice_7');
        expect(takeCarriedVoiceChoice('voice_7')).toEqual({ muted: true, deafened: false });
        expect(takeCarriedVoiceChoice('voice_7')).toBeNull();
    });

    it('it is what the member had chosen when the move came, not what the panel was reset to after', () => {
        publishSelfVoiceChoice({ muted: true, deafened: true });
        // (leaving the old call publishes nothing: VoicePanel publishes only
        // while in voice, so a forced removal that beat the directive cannot
        // overwrite it)
        carrySelfVoiceChoiceTo('voice_7');
        publishSelfVoiceChoice({ muted: false, deafened: false }); // a later call
        expect(takeCarriedVoiceChoice('voice_7')).toEqual({ muted: true, deafened: true });
    });

    it('a join of any OTHER room drops it: it never reaches a join the member made', () => {
        publishSelfVoiceChoice({ muted: true, deafened: false });
        carrySelfVoiceChoiceTo('voice_7');
        expect(takeCarriedVoiceChoice('voice_8')).toBeNull();
        expect(takeCarriedVoiceChoice('voice_7')).toBeNull();
    });

    it('nothing carried: nothing taken', () => {
        expect(takeCarriedVoiceChoice('voice_7')).toBeNull();
    });
});

// ── VoicePanel / Chat wiring ──────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
// One line ending, whatever the checkout: the multi-line mutants below are
// spelled with LF, and a Windows checkout of VoicePanel.tsx is CRLF.
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const VP_RAW = read('components/VoicePanel.tsx');
const VP = stripComments(VP_RAW);
const CHAT = stripComments(read('components/Chat.tsx'));
const GUIDE = readFileSync(join(here, '..', '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8');

/** The text of one declaration, up to its own closing brace at the same
 *  indentation. null when `decl` is missing or ambiguous. */
function body(code: string, decl: string): string | null {
    const start = code.indexOf(decl);
    if (start === -1 || code.indexOf(decl, start + 1) !== -1) return null;
    const lineStart = code.lastIndexOf('\n', start) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))![0];
    const rest = code.slice(start + decl.length);
    const end = new RegExp(`\\r?\\n${indent}\\}`).exec(rest);
    return end ? rest.slice(0, end.index) : null;
}
/** Every needle present, each after the one before it. */
function inOrder(s: string | null, ...needles: string[]): boolean {
    if (s === null) return false;
    let at = -1;
    for (const n of needles) {
        const i = s.indexOf(n, at + 1);
        if (i === -1) return false;
        at = i;
    }
    return true;
}
const replaceNth = (from: string, to: string, n = 1) => (code: string) => {
    let at = -1;
    for (let k = 0; k < n; k++) {
        at = code.indexOf(from, at + 1);
        if (at === -1) return code;
    }
    return code.slice(0, at) + to + code.slice(at + from.length);
};

/** Replace the first `from` INSIDE one declaration's body only. */
const inBody = (decl: string, from: string, to: string) => (code: string) => {
    const start = code.indexOf(decl);
    const b = start === -1 ? null : body(code, decl);
    if (b === null) return code;
    const at = code.indexOf(from, start);
    if (at === -1 || at > start + decl.length + b.length) return code;
    return code.slice(0, at) + to + code.slice(at + from.length);
};

const RECOVERY = 'const applyNoiseModeLive = useCallback(';
const TOGGLE_MUTE = 'const toggleMute = useCallback(';
const TOGGLE_DEAFEN = 'const toggleDeafen = useCallback(';

interface Pin {
    name: string;
    src: 'vp' | 'chat';
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: "the microphone coming back restores the member's own choice (muted, or deafened), never a constant",
        src: 'vp',
        holds: (c) => {
            const b = body(c, RECOVERY);
            return inOrder(b,
                'if (!webrtcManager.isListenOnly()) {', 'if (listenOnlyRef.current) {',
                'const muted = selfMutedRef.current || isDeafenedRef.current || isAfkChannelRef.current;',
                // Written now: the gate below reads them in this tick.
                'listenOnlyRef.current = false;', 'isMutedRef.current = muted;', 'setIsMuted(muted);',
                'broadcastStatus(muted, isDeafenedRef.current);',
                'applyMicGate();')
                && !/setIsMuted\(false\)/.test(b!);
        },
        mutants: [
            ['it unmutes unconditionally (the bug)', replaceNth('const muted = selfMutedRef.current || isDeafenedRef.current || isAfkChannelRef.current;', 'const muted = false;')],
            ['a deafened member comes back unmuted', replaceNth('const muted = selfMutedRef.current || isDeafenedRef.current || isAfkChannelRef.current;', 'const muted = selfMutedRef.current || isAfkChannelRef.current;')],
            ['an AFK channel comes back unmuted', replaceNth('const muted = selfMutedRef.current || isDeafenedRef.current || isAfkChannelRef.current;', 'const muted = selfMutedRef.current || isDeafenedRef.current;')],
            ['the gate reads a stale mute', inBody(RECOVERY, 'isMutedRef.current = muted;', '')],
            ['the gate still thinks listen-only', inBody(RECOVERY, 'listenOnlyRef.current = false;', '')],
        ],
    },
    {
        name: "no imposed mute (no microphone, no SPEAK) touches the member's own choice",
        src: 'vp',
        holds: (c) => {
            const r = body(c, RECOVERY);
            const d = body(c, 'const denySpeakLocally = useCallback(');
            return !!r && !!d && !/selfMutedRef\.current =|setSelfMuted\(/.test(r) && !/selfMutedRef\.current =|setSelfMuted\(/.test(d)
                // The listen-only entry imposes the mute in force only.
                && inOrder(r, '} else if (!listenOnlyRef.current) {', 'isMutedRef.current = true;', 'setIsMuted(true);', 'setMicNotice(MIC_LOST_NOTICE);');
        },
        mutants: [
            ['losing the microphone forgets the choice', replaceNth('setMicNotice(MIC_LOST_NOTICE);', 'setMicNotice(MIC_LOST_NOTICE); selfMutedRef.current = false;')],
            ['losing SPEAK forgets the choice', replaceNth('        isMutedRef.current = true;\n        setIsMuted(true);\n        broadcastStatus(true, isDeafenedRef.current);',
                '        isMutedRef.current = true;\n        setIsMuted(true);\n        setSelfMuted(false);\n        broadcastStatus(true, isDeafenedRef.current);')],
        ],
    },
    {
        name: 'Mute while there is no microphone sets how the member comes back, and nothing else; refused only without SPEAK',
        src: 'vp',
        holds: (c) => {
            const b = body(c, TOGGLE_MUTE);
            if (!b) return false;
            const guard = /if \(isAfkChannel \|\| speakDeniedRef\.current\) return;/.test(b) && !/\|\| listenOnly\) return;/.test(b);
            const lo = /if \(listenOnlyRef\.current\) \{([\s\S]*?)\n {8}\}/.exec(b);
            return guard && !!lo
                && lo[1].includes('const next = !selfMutedRef.current;') && lo[1].includes('selfMutedRef.current = next;')
                && lo[1].includes('return;')
                && !/applyMicGate|broadcastStatus|setIsMuted/.test(lo[1])
                // A normal press is the member's choice too, and reads the
                // mute in force from the ref (the closure lags a render).
                && inOrder(b, 'const newMuted = !isMutedRef.current;', 'applyMicGate(newMuted);', 'selfMutedRef.current = newMuted;', 'broadcastStatus(newMuted, isDeafened);');
        },
        mutants: [
            ['listen-only is refused again (the silent no-op)', replaceNth('if (isAfkChannel || speakDeniedRef.current) return;', 'if (isAfkChannel || listenOnly) return;')],
            ['the press opens a gate there is nothing behind', replaceNth('selfMutedRef.current = next;', 'selfMutedRef.current = next; applyMicGate(next);')],
            ['a normal press is not recorded as the choice', replaceNth('selfMutedRef.current = newMuted;', '')],
            ['a press right after the mic came back toggles a stale forced mute', replaceNth('const newMuted = !isMutedRef.current;', 'const newMuted = !isMuted;')],
        ],
    },
    {
        name: "deafening records a mute of the member's own, even under an imposed one",
        src: 'vp',
        holds: (c) => inOrder(body(c, TOGGLE_DEAFEN),
            'if (newDeafened && !selfMutedRef.current) {', 'selfMutedRef.current = true;', 'setSelfMuted(true);',
            'if (newDeafened && !isMutedRef.current) {', 'applyMicGate(true);', 'broadcastStatus(newDeafened || isMutedRef.current, newDeafened);'),
        mutants: [
            ['an imposed mute hides it (deafened while listen-only came back live)', replaceNth('if (newDeafened && !selfMutedRef.current) {', 'if (newDeafened && !isMuted) {')],
            ['the gate is decided by a closure a render behind', replaceNth('if (newDeafened && !isMutedRef.current) {', 'if (newDeafened && !isMuted) {')],
        ],
    },
    {
        name: 'the Mute button can be pressed while listen-only for lack of a microphone, not without SPEAK or while deafened',
        src: 'vp',
        holds: (c) => c.includes('disabled={speakDenied || isDeafened || isAfkChannel}')
            && c.includes('listenOnly ? (selfMuted ? MIC_GONE_MUTED_TITLE : MIC_GONE_TITLE)'),
        mutants: [
            ['disabled while listen-only again', replaceNth('disabled={speakDenied || isDeafened || isAfkChannel}', 'disabled={listenOnly || isDeafened || isAfkChannel}')],
            ['it does not say which way the member comes back', replaceNth('listenOnly ? (selfMuted ? MIC_GONE_MUTED_TITLE : MIC_GONE_TITLE)', 'listenOnly ? MIC_GONE_TITLE')],
        ],
    },
    {
        name: 'a join the member makes starts unmuted, as it always has: leaving resets the choice',
        src: 'vp',
        holds: (c) => inOrder(body(c, 'const leaveVoice = useCallback('),
            'isMutedRef.current = false;', 'setIsMuted(false);', 'selfMutedRef.current = false;', 'setSelfMuted(false);',
            'isDeafenedRef.current = false;', 'setIsDeafened(false);'),
        mutants: [
            ['the choice outlives the call', replaceNth('selfMutedRef.current = false;\n        setSelfMuted(false);', '')],
        ],
    },
    {
        name: "a moved member's join takes the carried choice BEFORE the microphone opens, and the join's gate shuts it",
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const joinVoice = useCallback(');
            return inOrder(b,
                'const carried = takeCarriedVoiceChoice(roomId);',
                'const muted = carried.muted || carried.deafened;',
                'selfMutedRef.current = muted;', 'isMutedRef.current = muted;', 'isDeafenedRef.current = carried.deafened;',
                'webrtcManager.getLocalStream(true, false)',
                'isMuted: noMic || isMutedRef.current,', 'isDeafened: isDeafenedRef.current,',
                'applyMicGate();');
        },
        mutants: [
            ['the choice is never taken', replaceNth('const carried = takeCarriedVoiceChoice(roomId);', 'const carried = null as { muted: boolean; deafened: boolean } | null;')],
            ['a deafened member arrives unmuted', replaceNth('const muted = carried.muted || carried.deafened;', 'const muted = carried.muted;')],
            ['the gate reads a stale mute', inBody('const joinVoice = useCallback(', 'isMutedRef.current = muted;', '')],
        ],
    },
    {
        name: 'the panel publishes the choice only while in voice (a forced removal must not overwrite it with the reset)',
        src: 'vp',
        holds: (c) => /if \(isInVoice\) publishSelfVoiceChoice\(\{ muted: selfMuted, deafened: isDeafened \}\);\s*\}, \[isInVoice, selfMuted, isDeafened\]\);/.test(c),
        mutants: [
            ['published unconditionally', replaceNth('if (isInVoice) publishSelfVoiceChoice(', 'publishSelfVoiceChoice(')],
        ],
    },
    {
        name: "a moderator's move carries the member's choice into the destination's join",
        src: 'chat',
        holds: (c) => inOrder(body(c, 'const handleVoiceMoved = '),
            'const target = list.find(c => c.id === payload.channel_id);',
            'if (!target) {', 'stranded(',
            'if (cur === null || cur.id === payload.from_channel_id) {',
            'carrySelfVoiceChoiceTo(`voice_${target.id}`);',
            'setCurrentVoiceChannel(prev =>'),
        mutants: [
            ['nothing is carried (the moved member arrives live)', replaceNth('carrySelfVoiceChoiceTo(`voice_${target.id}`);', '')],
            ['carried to the room it came from', replaceNth('carrySelfVoiceChoiceTo(`voice_${target.id}`);', 'carrySelfVoiceChoiceTo(`voice_${payload.from_channel_id}`);')],
        ],
    },
];

describe('the pin helpers (positive controls)', () => {
    it('body() finds each declaration once and stops at its own closing brace', () => {
        for (const decl of [RECOVERY, TOGGLE_MUTE, TOGGLE_DEAFEN, 'const leaveVoice = useCallback(', 'const joinVoice = useCallback(', 'const denySpeakLocally = useCallback(']) {
            expect(body(VP, decl), decl).not.toBeNull();
        }
        expect(body(VP, TOGGLE_MUTE), 'must stop before the next declaration').not.toContain('broadcastStatus(newDeafened');
        expect(body(CHAT, 'const handleVoiceMoved = ')).not.toBeNull();
    });
    it('stripComments removes prose, so a commented-out call cannot satisfy a pin', () => {
        const fake = 'x();\n// const muted = selfMutedRef.current || isDeafenedRef.current;\ny(); /* carrySelfVoiceChoiceTo(r); */';
        expect(stripComments(fake)).not.toContain('selfMutedRef');
        expect(stripComments(fake)).not.toContain('carrySelfVoiceChoiceTo');
        expect(stripComments(fake)).toContain('y();');
    });
});

describe.each(PINS)('$name', ({ src, holds, mutants }) => {
    const code = src === 'vp' ? VP : CHAT;
    it('holds in the source', () => {
        expect(holds(code)).toBe(true);
    });
    it.each(mutants)('goes red when %s', (_label, mutate) => {
        const mutated = mutate(code);
        expect(mutated, 'the mutation must actually change the source').not.toBe(code);
        expect(holds(mutated)).toBe(false);
    });
});

describe("docs/USER_GUIDE.md quotes the Mute button's real listen-only copy", () => {
    const constant = (name: string) => {
        const m = new RegExp(`const ${name} = (['"])(.*?)\\1;`).exec(VP_RAW);
        expect(m, `${name} not found in VoicePanel.tsx`).not.toBeNull();
        return m![2];
    };
    it('both titles', () => {
        expect(GUIDE).toContain(constant('MIC_GONE_TITLE'));
        expect(GUIDE).toContain(constant('MIC_GONE_MUTED_TITLE'));
    });
});
