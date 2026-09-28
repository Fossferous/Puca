/**
 * SPEAK / CONNECT wiring in VoicePanel.tsx and Chat.tsx that only the live rig
 * (frontend/e2e/speak-perms-live.mjs) otherwise exercises.
 *
 * The decision logic has unit tests of its own (speakGate.test.ts,
 * speakDeniedMedia.test.ts, meshReleaseMic.test.ts, sfuSpeakGrant.test.ts).
 * What those cannot see is whether the panel still CALLS it: a join that
 * attaches a remote stream without asking the gate, or a device watchdog that
 * re-opens the mic of a member without SPEAK, passes every one of them. These
 * pin the call sites in the source text.
 *
 * Every pin is checked against the real source AND against mutated copies of
 * it (the wiring removed, reordered or weakened, applied to a string here -
 * never to the file), so a pin that could not fail would fail its own
 * mutation case. Comments are stripped first: prose that mentions a call does
 * not count as the call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const VP_RAW = read('components/VoicePanel.tsx');
const VP = stripComments(VP_RAW);
const CHAT = stripComments(read('components/Chat.tsx'));
const GUIDE = readFileSync(join(here, '..', '..', '..', 'docs', 'USER_GUIDE.md'), 'utf8');

/**
 * The text of one declaration: from `decl` to the first line at the SAME
 * indentation that starts with `}` — the declared function's own closing
 * brace (`};` or `}, [deps]);`). null when `decl` is missing or ambiguous.
 */
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

const count = (s: string, needle: string) => s.split(needle).length - 1;

/** Replace the n-th (1-based) occurrence of `from`. */
const replaceNth = (from: string, to: string, n = 1) => (code: string) => {
    let at = -1;
    for (let k = 0; k < n; k++) {
        at = code.indexOf(from, at + 1);
        if (at === -1) return code;
    }
    return code.slice(0, at) + to + code.slice(at + from.length);
};
const replaceRe = (re: RegExp, to: string) => (code: string) => code.replace(re, to);

/** `canSpeak={hasPerm((channels.find(c => c.id === currentVoiceChannel.id) ?? currentVoiceChannel).my_permissions, PERM.<bit>)}` */
const permProp = (prop: string, bit: string) => new RegExp(
    `${prop}=\\{hasPerm\\(\\(channels\\.find\\(c => c\\.id === currentVoiceChannel\\.id\\) \\?\\? currentVoiceChannel\\)\\.my_permissions,\\s*PERM\\.${bit}\\)\\}`,
);

/** The `<VoicePanel ... />` element in Chat.tsx, up to its own `/>`. */
function voicePanelElement(code: string): string | null {
    const start = code.indexOf('<VoicePanel');
    if (start === -1) return null;
    const lineStart = code.lastIndexOf('\n', start) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))![0];
    const end = new RegExp(`\\r?\\n${indent}/>`).exec(code.slice(start));
    return end ? code.slice(start, start + end.index) : null;
}

interface Pin {
    name: string;
    src: 'vp' | 'chat';
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: 'handleRemoteStream asks the SPEAK gate, and returns, BEFORE attachVoice',
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const handleRemoteStream = ');
            return !!b && /if \(!speakGateRef\.current\.admit\(userId, stream\)\) \{[\s\S]*?\breturn;\s*\}\s*attachVoice\(userId, stream\);/.test(b);
        },
        mutants: [
            ['the gate is not asked', replaceNth('if (!speakGateRef.current.admit(userId, stream)) {', 'if (false) {')],
            ['a held stream falls through to attachVoice', replaceRe(/(Holding audio from[^\n]*\n\s*)return;/, '$1')],
        ],
    },
    {
        name: 'both transports deliver voice through handleRemoteStream, never straight to attachVoice',
        src: 'vp',
        holds: (c) => c.includes('webrtcManager.setOnRemoteStream(handleRemoteStream)')
            && c.includes('sfuManager.setOnRemoteStream(handleRemoteStream)')
            && !/setOnRemoteStream\(\s*attachVoice\s*\)/.test(c),
        mutants: [
            ['the SFU bypasses the gate', replaceNth('sfuManager.setOnRemoteStream(handleRemoteStream)', 'sfuManager.setOnRemoteStream(attachVoice)')],
        ],
    },
    {
        name: "applySpeakState: 'retract' calls retractVoice, 'deliver' re-attaches, our own deny closes our mic",
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const applySpeakState = useCallback(');
            return !!b
                && /if \(action === 'retract'\) \{[\s\S]*?\bretractVoice\(userId\);[\s\S]*?\} else if \(action === 'deliver'\)/.test(b)
                && b.includes('deliverVoiceRef.current?.(userId, stream)')
                && /if \(userId === currentUserId\) \{\s*if \(!allowed\) void denySpeakLocally\(\);/.test(b);
        },
        mutants: [
            ['retract no longer detaches', replaceNth('retractVoice(userId);', 'void userId;')],
            ['our own deny is ignored', replaceNth('if (!allowed) void denySpeakLocally();', '')],
        ],
    },
    {
        name: 'retractVoice detaches the element; it never gates with muted/volume (deafen and per-user volume own those)',
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const retractVoice = useCallback(');
            return inOrder(b, 'el.pause()', 'el.srcObject = null', 'el.remove()') && !/\.(muted|volume)\s*=/.test(b!);
        },
        mutants: [
            ['muted instead of removed', replaceNth('el.remove();', 'el.muted = true;')],
        ],
    },
    {
        name: 'denySpeakLocally clears "you can speak now" even when already denied, marks the manager denied, takes the mic off the SFU, then releases it',
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const denySpeakLocally = useCallback(');
            return inOrder(b,
                // Before the idempotence return: a deny after a mid-call grant must
                // drop the rejoin notice although the mic is already closed.
                'setSpeakGrantedPending(false)',
                'if (speakDeniedRef.current && !webrtcManager.getLocalStreamSync()?.getAudioTracks().length) return;',
                'webrtcManager.setSpeakDenied(true)', 'if (sfuMode) await sfuManager.unpublishMic()', 'await webrtcManager.releaseMic()');
        },
        mutants: [
            ['the mic is never released', replaceNth('await webrtcManager.releaseMic();', '')],
            ['the notice is cleared only after the early return', replaceRe(
                /setSpeakGrantedPending\(false\);(\s*)(if \(speakDeniedRef\.current && !webrtcManager[^\n]*return;)/, '$2$1setSpeakGrantedPending(false);')],
        ],
    },
    {
        name: 'joinVoice refuses without CONNECT and settles SPEAK before JoinRoom and before any microphone is asked for',
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const joinVoice = useCallback(');
            return inOrder(b,
                'if (canConnectRef.current === false) {', 'setError(CONNECT_DENIED_NOTICE);', 'return;',
                'const deniedByHint = canSpeakRef.current === false;',
                'webrtcManager.setSpeakDenied(deniedByHint);',
                'wsClient.joinRoom(roomId);',
                'webrtcManager.getLocalStream(true, false)')
                && /if \(speakDeniedRef\.current && localStream\.getAudioTracks\(\)\.length > 0\) \{\s*await webrtcManager\.releaseMic\(\);/.test(b!);
        },
        mutants: [
            ['the manager is never told', replaceNth('webrtcManager.setSpeakDenied(deniedByHint);', '')],
            ['the CONNECT refusal is gone', replaceNth('if (canConnectRef.current === false) {', 'if (false) {')],
            ['a deny that lands during the prompt keeps the mic', replaceRe(
                /(if \(speakDeniedRef\.current && localStream\.getAudioTracks\(\)\.length > 0\) \{)\s*await webrtcManager\.releaseMic\(\);/, '$1')],
        ],
    },
    {
        name: 'the SFU join closes the mic when the grant has no microphone source',
        src: 'vp',
        holds: (c) => /const \{ micAllowed \} = await sfuManager\.connect\(channelId, micTrack\);\s*if \(!micAllowed && micTrack\) await denySpeakLocallyRef\.current\(\);/
            .test(body(c, 'const joinVoice = useCallback(') ?? ''),
        mutants: [
            ['the verdict is ignored', replaceNth('if (!micAllowed && micTrack) await denySpeakLocallyRef.current();', '')],
        ],
    },
    {
        name: 'applyNoiseModeLive returns before re-acquiring when SPEAK is denied, and never republishes a mic',
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const applyNoiseModeLive = useCallback(');
            return inOrder(b, 'if (speakDeniedRef.current) return Promise.resolve();', 'webrtcManager.reapplyNoiseMode()',
                // A deny that lands while the re-acquire runs: no "mic died" notice.
                '.then(() => {', 'if (speakDeniedRef.current) return;', 'if (!webrtcManager.isListenOnly()) {')
                && b!.includes('sfuMode && sfuManager.connected && !speakDeniedRef.current');
        },
        mutants: [
            ['no early return', replaceNth('if (speakDeniedRef.current) return Promise.resolve();', '')],
            ['a deny during the re-acquire runs the listen-only re-sync', replaceNth('                if (speakDeniedRef.current) return;', '')],
        ],
    },
    {
        name: 'the device watchdog (onMicLost, evaluate) never restarts the mic of a member without SPEAK',
        src: 'vp',
        holds: (c) => inOrder(body(c, 'const onMicLost = '), 'if (webrtcManager.isSpeakDenied()) return;', 'restartMic()')
            // The OUTPUT half still runs for them (they are listening); only the input half stops.
            && inOrder(body(c, 'const evaluate = '), 'applyOutputDevice(', 'if (webrtcManager.isSpeakDenied()) return;',
                'webrtcManager.rawMicState()', 'restartMic()'),
        mutants: [
            ['onMicLost unguarded', replaceNth('if (webrtcManager.isSpeakDenied()) return;', '', 1)],
            ['evaluate unguarded', replaceNth('if (webrtcManager.isSpeakDenied()) return;', '', 2)],
        ],
    },
    {
        name: "handleUserLeft forgets a member's SPEAK state only once their media is torn down, after the leave clip",
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const handleUserLeft = ');
            return !!b && b.includes('const tornDown = retireDepartedPeer(payload.user_id);')
                && inOrder(b, 'announceLeave(payload.user_id)', 'if (tornDown) speakGateRef.current.forget(payload.user_id);')
                && count(c, 'speakGateRef.current.forget(') === 1;
        },
        mutants: [
            ['forgotten unconditionally', replaceNth('if (tornDown) speakGateRef.current.forget(', 'speakGateRef.current.forget(')],
            ['forgotten before the leave clip', replaceRe(/(announceLeave\(payload\.user_id\);)([\s\S]*?)(if \(tornDown\) speakGateRef\.current\.forget\(payload\.user_id\);)/, '$3$2$1')],
        ],
    },
    {
        name: "a denied member's own join/leave clip is not played to the room",
        src: 'vp',
        holds: (c) => /const suppressClip = [^;]*\bspeakGateRef\.current\.isDenied\(id\)/
            .test(body(c, 'const playAnnouncement = useCallback(') ?? ''),
        mutants: [
            ['clip not suppressed', replaceNth(' || speakGateRef.current.isDenied(id)', '')],
        ],
    },
    {
        name: "VoiceSpeakState frames reach applySpeakState for THIS room only, registered and unregistered",
        src: 'vp',
        holds: (c) => c.includes("wsClient.on('VoiceSpeakState', handleVoiceSpeakState)")
            && c.includes("wsClient.off('VoiceSpeakState', handleVoiceSpeakState)")
            && /if \(!p \|\| p\.room_id !== roomId\) return;\s*applySpeakStateRef\.current\(p\.user_id, p\.can_speak\);/
                .test(body(c, 'const handleVoiceSpeakState = ') ?? ''),
        mutants: [
            ['any room', replaceNth(' || p.room_id !== roomId', '')],
            ['never unregistered', replaceNth("wsClient.off('VoiceSpeakState', handleVoiceSpeakState);", '')],
        ],
    },
    {
        name: 'VoicePanel treats absent canSpeak / canConnect as allowed (an older server sends neither)',
        src: 'vp',
        holds: (c) => /canSpeak = true, canConnect = true \}: VoicePanelProps\)/.test(c),
        mutants: [
            ['absent = denied', replaceNth('canSpeak = true,', 'canSpeak = false,')],
        ],
    },
    {
        name: 'Chat passes canSpeak / canConnect from the FRESH channel-list row, via hasPerm',
        src: 'chat',
        holds: (c) => {
            const el = voicePanelElement(c);
            return !!el && permProp('canSpeak', 'SPEAK').test(el) && permProp('canConnect', 'CONNECT').test(el);
        },
        mutants: [
            ['wrong bit', replaceRe(/(canSpeak=\{hasPerm\([^\n]*)PERM\.SPEAK/, '$1PERM.CONNECT')],
            ['canConnect dropped', replaceRe(/\n[ \t]*canConnect=\{[^\n]*\}\r?(?=\n)/, '')],
            ['the stale row captured at click', replaceNth('(channels.find(c => c.id === currentVoiceChannel.id) ?? currentVoiceChannel).my_permissions, PERM.SPEAK', 'currentVoiceChannel.my_permissions, PERM.SPEAK')],
        ],
    },
];

describe('the pin helpers (positive controls)', () => {
    it('body() returns exactly one declaration, stopping at its own closing brace', () => {
        const b = body(VP, 'const handleUserLeft = ');
        expect(b).not.toBeNull();
        expect(b).toContain('if (payload.room_id !== roomId) return;');
        expect(b, 'must stop before the next declaration').not.toContain('handleCameraStartedAlways');
        expect(body(VP, 'const noSuchDeclaration = ')).toBeNull();
    });

    it('stripComments removes prose, so a commented-out call cannot satisfy a pin', () => {
        const fake = 'x();\n// if (webrtcManager.isSpeakDenied()) return;\ny(); /* retractVoice(userId); */';
        expect(stripComments(fake)).not.toContain('isSpeakDenied');
        expect(stripComments(fake)).not.toContain('retractVoice');
        expect(stripComments(fake)).toContain('x();');
    });

    it('finds the <VoicePanel> element in Chat.tsx and it ends before the next element', () => {
        const el = voicePanelElement(CHAT);
        expect(el).not.toBeNull();
        expect(el).toContain('roomId=');
        expect(el).toContain('sfuMode=');
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

describe('docs/USER_GUIDE.md quotes the voice panel\'s real SPEAK copy', () => {
    const constant = (name: string) => {
        const m = new RegExp(`const ${name} = (['"])(.*?)\\1;`).exec(VP_RAW);
        expect(m, `${name} not found in VoicePanel.tsx`).not.toBeNull();
        return m![2];
    };

    it('the panel label', () => {
        const m = /speakDenied \? "([^"]+)"/.exec(VP);
        expect(m).not.toBeNull();
        expect(m![1]).toBe("Voice Connected · can't speak");
        expect(GUIDE).toContain(m![1]);
    });

    it('the mic button tooltip', () => {
        const m = /title=\{speakDenied \? "([^"]+)"/.exec(VP);
        expect(m).not.toBeNull();
        expect(GUIDE).toContain(m![1]);
    });

    it('the rejoin notice and the no-Connect refusal', () => {
        expect(GUIDE).toContain(constant('SPEAK_GRANTED_NOTICE'));
        expect(GUIDE).toContain(constant('CONNECT_DENIED_NOTICE'));
    });
});
