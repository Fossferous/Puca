// @vitest-environment jsdom
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

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { MediaManager } from '../api/rtc/media';
import { WebRTCManager } from '../api/rtc/manager';
import { publishSelfVoiceChoice, getSelfVoiceChoice } from '../components/voiceState';

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

    it('joined with no microphone at all: the first one plugged in starts SHUT (there was no gate, only a `true` default; mesh below)', async () => {
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

// ── WebRTCManager: a microphone plugged in after a listen-only join ───────
//
// A member who joined with no microphone has NO audio sender on a mesh peer
// connection: the join adds only a receive-only audio transceiver (so the pc
// negotiates at all). doReapplyNoiseMode used to look only for a sender to
// replaceTrack, found none, and did nothing: the member's button said Mute,
// everyone saw them unmuted, and nobody received a packet (measured live,
// e2e/mute-intent-live.mjs). The SFU republished and was fine.

class FakeSender {
    track: FakeTrack | null;
    replaced: Array<FakeTrack | null> = [];
    constructor(track: FakeTrack | null) { this.track = track; }
    async replaceTrack(t: FakeTrack | null) { this.replaced.push(t); this.track = t; }
}
class FakePc {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    signalingState = 'stable';
    senders: FakeSender[] = [];
    added: Array<{ track: FakeTrack; enabled: boolean }> = [];
    transceivers: Array<{ direction: string }> = [];
    createDataChannel() { return { close() { /* fake */ } } as unknown as RTCDataChannel; }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    addTransceiver(_kind: string, init: { direction: string }) { const t = { direction: init.direction }; this.transceivers.push(t); return t; }
    addTrack(track: FakeTrack) {
        // What the call puts on the wire: the track AS IT IS when added.
        this.added.push({ track, enabled: track.enabled });
        const s = new FakeSender(track);
        this.senders.push(s);
        return s;
    }
    close() { /* no-op */ }
}

describe('WebRTCManager: a microphone plugged in after a listen-only MESH join reaches every peer, shut', () => {
    let getUserMedia: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.stubGlobal('RTCPeerConnection', FakePc);
        getUserMedia = vi.fn();
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        localStorage.clear();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const peersOf = (mgr: WebRTCManager) => (mgr as unknown as { peers: Map<number, { connection: FakePc }> }).peers;

    it('no audio sender at all: the new microphone is ADDED to every peer (a renegotiation), and goes on shut', async () => {
        const mic = new FakeTrack();
        getUserMedia.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(new FakeStream([mic]));
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        await mgr.getLocalStream(true, false);
        expect(mgr.isListenOnly()).toBe(true);
        await mgr.callUser(2);
        await mgr.callUser(3);
        const pcs = [...peersOf(mgr).values()].map(p => p.connection);
        expect(pcs).toHaveLength(2);
        // The listen-only join: receive-only, no sender carrying audio.
        for (const pc of pcs) {
            expect(pc.transceivers.map(t => t.direction)).toEqual(['recvonly']);
            expect(pc.getSenders().filter(s => s.track)).toEqual([]);
        }

        await expect(mgr.reapplyNoiseMode()).resolves.toBe(true);

        for (const pc of pcs) {
            expect(pc.added.map(a => a.track)).toEqual([mic]);
            // Shut on the wire; VoicePanel opens it from the member's choice.
            expect(pc.added[0].enabled).toBe(false);
        }
        expect(mgr.isListenOnly()).toBe(false);
    });

    it('control: a microphone that DIED mid-call is replaced on its sender, never added a second time', async () => {
        const first = new FakeTrack();
        const back = new FakeTrack();
        getUserMedia.mockResolvedValueOnce(new FakeStream([first]))
            .mockRejectedValueOnce(notFound())
            .mockResolvedValueOnce(new FakeStream([back]));
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        await mgr.getLocalStream(true, false);
        await mgr.callUser(2);
        const pc = [...peersOf(mgr).values()][0].connection;
        expect(pc.added.map(a => a.track)).toEqual([first]);
        first.readyState = 'ended';
        await expect(mgr.reapplyNoiseMode()).resolves.toBe(false); // no microphone: listen-only
        await expect(mgr.reapplyNoiseMode()).resolves.toBe(true);
        expect(pc.added.map(a => a.track), 'no second audio sender').toEqual([first]);
        expect(pc.senders[0].replaced).toEqual([back]);
        expect(back.enabled).toBe(false);
    });
});

// ── voiceState: the choice a moderator's move carries ─────────────────────

describe("the member's own choice, published for a move they did not make", () => {
    it('getSelfVoiceChoice is what was last published, as a copy', () => {
        publishSelfVoiceChoice({ muted: true, deafened: true });
        const c = getSelfVoiceChoice();
        expect(c).toEqual({ muted: true, deafened: true });
        c.muted = false;
        expect(getSelfVoiceChoice().muted, 'a copy: the caller cannot change it').toBe(true);
        publishSelfVoiceChoice({ muted: false, deafened: false });
        expect(getSelfVoiceChoice()).toEqual({ muted: false, deafened: false });
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
const MGR = stripComments(read('api/rtc/manager.ts'));
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
const SET_MUTE = 'const setMute = useCallback(';
const JOIN = 'const joinVoice = useCallback(';
const LEAVE = 'const leaveVoice = useCallback(';
const DENY = 'const denySpeakLocally = useCallback(';
const GATE = 'const applyMicGate = useCallback(';

/** Does this body read the mute or deafen from the render's closure? (A ref
 *  read is `isMutedRef.current`; the bare identifiers are the closure's.) */
const readsClosure = (b: string) => /(?<![.\w])(?:isMuted|isDeafened|selfMuted|listenOnly)\b(?!Ref)/.test(b);

interface Pin {
    name: string;
    src: 'vp' | 'chat' | 'mgr';
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: 'ONE writer of the mute and deafen: setMute writes the refs, then the state; nothing else writes either',
        src: 'vp',
        holds: (c) => inOrder(body(c, SET_MUTE),
            'isMutedRef.current = next.muted;', 'selfMutedRef.current = next.selfMuted;', 'isDeafenedRef.current = next.deafened;',
            'setIsMuted(next.muted);', 'setSelfMuted(next.selfMuted);', 'setIsDeafened(next.deafened);')
            && (c.match(/setIsMuted\(|setIsDeafened\(|setSelfMuted\(|isMutedRef\.current =|isDeafenedRef\.current =|selfMutedRef\.current =/g) ?? []).length === 6
            // No effect re-syncs a ref from a commit that may be older than it.
            && !/useEffect\(\(\) => \{ isMutedRef\.current = isMuted; \}/.test(c)
            && !/isDeafenedRef\.current = isDeafened;/.test(c),
        mutants: [
            ['a handler writes the state alone again', inBody(TOGGLE_DEAFEN, 'setMute(next);', 'setMute(next); setIsDeafened(next.deafened);')],
            ['the deafen ref is synced by an effect again', replaceNth('    useEffect(() => () => setSelfDeafened(false), []);',
                '    useEffect(() => { isDeafenedRef.current = isDeafened; }, [isDeafened]);\n    useEffect(() => () => setSelfDeafened(false), []);')],
        ],
    },
    {
        name: 'Toggle Mute and Toggle Deafen work from the refs only (two hotkeys in one task see each other), through selfMute.ts',
        src: 'vp',
        holds: (c) => {
            const m = body(c, TOGGLE_MUTE);
            const d = body(c, TOGGLE_DEAFEN);
            return !!m && !!d && !readsClosure(m) && !readsClosure(d)
                && inOrder(m, 'const press = pressMute(muteNow(), constraintsNow());',
                    "if (press.kind === 'refused') {", "if (press.why === 'deafened') setMuteNotice(", 'return;',
                    'setMute(press.next);', "if (press.kind === 'toggled') {", 'applyMicGate();', 'broadcastStatus(press.next.muted, press.next.deafened);')
                && inOrder(d, 'const next = pressDeafen(muteNow());', 'setMute(next);', 'applyMicGate();',
                    '.muted = next.deafened;', 'broadcastStatus(next.muted, next.deafened);');
        },
        mutants: [
            ['the deafen guard reads the closure (THE BUG)', inBody(TOGGLE_MUTE, 'const press = pressMute(muteNow(), constraintsNow());',
                'if (isDeafened) return; const press = pressMute(muteNow(), constraintsNow());')],
            ['deafen reads its own state from the closure', inBody(TOGGLE_DEAFEN, 'const next = pressDeafen(muteNow());',
                'const next = pressDeafen({ ...muteNow(), deafened: isDeafened });')],
            ['the gate runs before the new state is written', inBody(TOGGLE_DEAFEN, 'setMute(next);\n        applyMicGate();', 'applyMicGate();\n        setMute(next);')],
            ['the status ping reads the closure', inBody(TOGGLE_MUTE, 'broadcastStatus(press.next.muted, press.next.deafened);', 'broadcastStatus(press.next.muted, isDeafened);')],
        ],
    },
    {
        name: 'the gate reads the refs through micOpen (deafened, muted, AFK, no SPEAK never transmit), and no SPEAK shuts it at once',
        src: 'vp',
        holds: (c) => {
            const g = body(c, GATE);
            return !!g && /webrtcManager\.setAudioEnabled\(micOpen\(muteNow\(\), constraintsNow\(\), voiceInputModeRef\.current, holdKeyDownRef\.current\)\)/.test(g)
                && !/mutedOverride/.test(g)
                && inOrder(body(c, DENY), 'speakDeniedRef.current = true;', 'applyMicGate();', 'await webrtcManager.releaseMic();');
        },
        mutants: [
            ['the gate takes a caller\'s mute again', inBody(GATE, 'micOpen(muteNow(), constraintsNow(),', 'micOpen({ ...muteNow(), muted: false }, constraintsNow(),')],
            ['losing SPEAK leaves the mic open until it is released', inBody(DENY, 'applyMicGate();', '')],
        ],
    },
    {
        name: "the microphone coming back restores the member's own choice (selfMute.ts micBack), never a constant, and arms the ring",
        src: 'vp',
        holds: (c) => {
            const b = body(c, RECOVERY);
            return inOrder(b,
                'if (!webrtcManager.isListenOnly()) {', 'if (listenOnlyRef.current) {',
                'const next = micBack(muteNow(), constraintsNow());',
                'listenOnlyRef.current = false;', 'setMute(next);',
                'broadcastStatus(next.muted, next.deafened);',
                'if (local) armLocalDetectors(local);',
                'applyMicGate();')
                && !/setIsMuted\(false\)|setMute\(UNMUTED\)/.test(b!);
        },
        mutants: [
            ['it unmutes unconditionally (the original bug)', inBody(RECOVERY, 'const next = micBack(muteNow(), constraintsNow());', 'const next = UNMUTED;')],
            ['the gate still thinks listen-only', inBody(RECOVERY, 'listenOnlyRef.current = false;', '')],
            ['a member who joined with no microphone never gets a ring', inBody(RECOVERY, 'if (local) armLocalDetectors(local);', '')],
        ],
    },
    {
        name: "no imposed mute (no microphone, no SPEAK, AFK) touches the member's own choice",
        src: 'vp',
        holds: (c) => inOrder(body(c, RECOVERY), '} else if (!listenOnlyRef.current) {', 'const next = imposeMute(muteNow());', 'setMute(next);', 'setMicNotice(MIC_LOST_NOTICE);')
            && inOrder(body(c, DENY), 'const next = imposeMute(muteNow());', 'setMute(next);')
            && inOrder(body(c, JOIN), 'if (isAfkChannel) {', 'setMute(imposeMute(muteNow()));'),
        mutants: [
            ['losing the microphone forgets the choice', inBody(RECOVERY, 'const next = imposeMute(muteNow());', 'const next = { muted: true, selfMuted: false, deafened: false };')],
            ['losing SPEAK forgets the choice', inBody(DENY, 'const next = imposeMute(muteNow());', 'const next = { muted: true, selfMuted: false, deafened: false };')],
        ],
    },
    {
        name: 'the Mute button: pressable while listen-only for lack of a microphone; its refusals (no SPEAK, AFK, deafened) never say "click"',
        src: 'vp',
        // micOffByChoice: joined without a microphone ON PURPOSE (docs/STREAM_ONLY.md)
        // - nothing can return, so nothing to press; a missing DEVICE stays pressable.
        holds: (c) => c.includes('disabled={speakDenied || micOffByChoice || isDeafened || isAfkChannel}')
            && inOrder(c, 'title={speakDenied ? "You don\'t have permission to speak in this channel"',
                ": isAfkChannel ? 'Microphone is disabled in AFK channels'",
                ': listenOnly ? (isDeafened ? MIC_GONE_DEAFENED_TITLE : selfMuted ? MIC_GONE_MUTED_TITLE : MIC_GONE_TITLE)'),
        mutants: [
            ['disabled while listen-only again', replaceNth('disabled={speakDenied || micOffByChoice || isDeafened || isAfkChannel}', 'disabled={listenOnly || isDeafened || isAfkChannel}')],
            ['a deafened member is told to click', replaceNth('(isDeafened ? MIC_GONE_DEAFENED_TITLE : selfMuted ?', '(selfMuted ?')],
        ],
    },
    {
        name: 'a moved member\'s FIRST join attempt takes the carried choice before anything can refuse it, applies it before the mic opens; leaving drops it',
        src: 'vp',
        holds: (c) => inOrder(body(c, JOIN),
            'if (joiningRef.current || isInVoiceRef.current) return;',
            'const carried = arrivalChoiceRef.current;', 'arrivalChoiceRef.current = null;',
            'if (canConnectRef.current === false) {',
            'const muted = carried.muted || carried.deafened;', 'setMute({ muted, selfMuted: muted, deafened: carried.deafened });',
            'webrtcManager.getLocalStream(true, false)',
            'isMuted: noMic || isMutedRef.current,', 'isDeafened: isDeafenedRef.current,',
            'applyMicGate();')
            && inOrder(body(c, LEAVE), 'setMute(UNMUTED);', 'arrivalChoiceRef.current = null;'),
        mutants: [
            ['a refused join leaves the carry for a later one', inBody(JOIN, 'const carried = arrivalChoiceRef.current;\n        arrivalChoiceRef.current = null;\n', '')],
            ['a deafened member arrives unmuted', inBody(JOIN, 'const muted = carried.muted || carried.deafened;', 'const muted = carried.muted;')],
            ['the choice outlives the call', inBody(LEAVE, 'arrivalChoiceRef.current = null;', '')],
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
        name: "a moderator's move and its carry are ONE decision: the choice rides with the channel the move applies",
        src: 'chat',
        holds: (c) => inOrder(body(c, 'const handleVoiceMoved = '),
            'const target = list.find(c => c.id === payload.channel_id);',
            'if (!target) {', 'stranded(',
            'const movedWith = getSelfVoiceChoice();',
            '(prev === null || prev.id === payload.from_channel_id) ? { ...target, movedWith } : prev')
            && c.includes('arrivalChoice={currentVoiceChannel.movedWith ?? null}'),
        mutants: [
            ['nothing is carried (the moved member arrives live)', replaceNth('{ ...target, movedWith } : prev', 'target : prev')],
            ['the panel is never told', replaceNth('arrivalChoice={currentVoiceChannel.movedWith ?? null}', 'arrivalChoice={null}')],
        ],
    },
    {
        name: 'mesh: a microphone with no sender to replace (a join with none) is ADDED to the peer, under the fail-closed rule',
        src: 'mgr',
        holds: (c) => inOrder(body(c, 'private async doReapplyNoiseMode('),
            'if (micSender) {', 'await this.replaceSenderTrack(micSender, newTrack)',
            '} else if (localStream && !(this.requireMediaE2ee && !isMediaE2eeSupported())) {',
            'this.wireSender(userId, peer.connection.addTrack(newTrack, localStream));'),
        mutants: [
            ['nothing is added (the old behaviour)', inBody('private async doReapplyNoiseMode(', 'this.wireSender(userId, peer.connection.addTrack(newTrack, localStream));', '')],
            ['added without the encrypt transform', inBody('private async doReapplyNoiseMode(', 'this.wireSender(userId, peer.connection.addTrack(newTrack, localStream));', 'peer.connection.addTrack(newTrack, localStream);')],
        ],
    },
];

describe('the pin helpers (positive controls)', () => {
    it('body() finds each declaration once and stops at its own closing brace', () => {
        for (const decl of [RECOVERY, TOGGLE_MUTE, TOGGLE_DEAFEN, SET_MUTE, JOIN, LEAVE, DENY, GATE]) {
            expect(body(VP, decl), decl).not.toBeNull();
        }
        expect(body(VP, TOGGLE_MUTE), 'must stop before the next declaration').not.toContain('pressDeafen');
        expect(body(CHAT, 'const handleVoiceMoved = ')).not.toBeNull();
        expect(body(MGR, 'private async doReapplyNoiseMode(')).not.toBeNull();
    });
    it('readsClosure tells a closure read from a ref read', () => {
        expect(readsClosure('if (isDeafened) return;')).toBe(true);
        expect(readsClosure('const x = !isMuted;')).toBe(true);
        expect(readsClosure('if (isDeafenedRef.current) return; isMutedRef.current = true;')).toBe(false);
        expect(readsClosure('setIsMuted(next.muted)')).toBe(false);
    });
    it('stripComments removes prose, so a commented-out call cannot satisfy a pin', () => {
        const fake = 'x();\n// const next = micBack(muteNow(), constraintsNow());\ny(); /* getSelfVoiceChoice(); */';
        expect(stripComments(fake)).not.toContain('micBack');
        expect(stripComments(fake)).not.toContain('getSelfVoiceChoice');
        expect(stripComments(fake)).toContain('y();');
    });
});

describe.each(PINS)('$name', ({ src, holds, mutants }) => {
    const code = src === 'vp' ? VP : src === 'mgr' ? MGR : CHAT;
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
    it('all three titles', () => {
        expect(GUIDE).toContain(constant('MIC_GONE_TITLE'));
        expect(GUIDE).toContain(constant('MIC_GONE_MUTED_TITLE'));
        expect(GUIDE).toContain(constant('MIC_GONE_DEAFENED_TITLE'));
    });
});
