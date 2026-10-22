/**
 * The stream-only bundle's wiring in VoicePanel.tsx and Chat.tsx
 * (docs/STREAM_ONLY.md), pinned in the source text the way
 * speakPermsWiring.test.ts pins SPEAK's. The media layer's behaviour has its
 * own tests (streamOnlyMedia.test.ts); what those cannot see is whether the
 * panel still CALLS it:
 *
 *  - the idle move to the AFK channel is never armed for a member with no
 *    microphone by choice (it reads voice activity they cannot have);
 *  - the silent-microphone sentinel ("Local mic has produced only digital
 *    silence") is armed only when a microphone was opened, and a member who
 *    joined without one is listen-only before that decision is read;
 *  - a stream-only account always joins that way, decided before the mic
 *    would be asked for;
 *  - the server's `receives` reaches the mesh manager, for peers and for us;
 *  - the roster says "no microphone" rather than "muted".
 *
 * Every pin is checked against the real source AND against mutated copies
 * (applied to a string here, never to the file), so a pin that could not fail
 * fails its own mutation case. Comments are stripped first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const SRC = {
    vp: stripComments(read('components/VoicePanel.tsx')),
    chat: stripComments(read('components/Chat.tsx')),
    stage: stripComments(read('components/VoiceStage.tsx')),
};

/** One declaration's text, to the closing brace at its own indentation. */
function body(code: string, decl: string): string | null {
    const start = code.indexOf(decl);
    if (start === -1 || code.indexOf(decl, start + 1) !== -1) return null;
    const lineStart = code.lastIndexOf('\n', start) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))![0];
    const rest = code.slice(start + decl.length);
    const end = new RegExp(`\\r?\\n${indent}\\}`).exec(rest);
    return end ? rest.slice(0, end.index) : null;
}

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

const replace = (from: string, to: string) => (code: string) => code.replace(from, to);
const swap = (a: string, b: string) => (code: string) => {
    const ia = code.indexOf(a);
    const ib = code.indexOf(b);
    if (ia === -1 || ib === -1) return code;
    const [first, second] = ia < ib ? [a, b] : [b, a];
    const i1 = code.indexOf(first);
    const i2 = code.indexOf(second);
    return code.slice(0, i1) + second + code.slice(i1 + first.length, i2) + first + code.slice(i2 + second.length);
};

interface Pin {
    name: string;
    src: keyof typeof SRC;
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: 'the idle move (AFK) is never armed for a member with no microphone by choice',
        src: 'vp',
        holds: (c) => /if \(!onInactiveRef\.current \|\| isAfkChannelRef\.current \|\| micOffByChoiceRef\.current\) return;\s*inactivityTimer\.current = setTimeout\(/
            .test(body(c, 'const armInactivity = useCallback(') ?? ''),
        mutants: [
            ['the exemption is dropped', replace(' || micOffByChoiceRef.current) return;', ') return;')],
        ],
    },
    {
        name: 'joinVoice decides "no microphone" (stream-only or the setting) BEFORE the mic would be asked for',
        src: 'vp',
        holds: (c) => inOrder(body(c, 'const joinVoice = useCallback('),
            'const offByChoice = streamOnlyRef.current || loadSettings().joinWithoutMic === true;',
            'micOffByChoiceRef.current = offByChoice;',
            'webrtcManager.setMicOffByChoice(offByChoice);',
            'wsClient.joinRoom(roomId',
            'await webrtcManager.getLocalStream(true, false);'),
        mutants: [
            ['a stream-only account is no longer exempt', replace('streamOnlyRef.current || loadSettings().joinWithoutMic', 'loadSettings().joinWithoutMic')],
            ['decided after the mic was opened', swap('webrtcManager.setMicOffByChoice(offByChoice);', 'const localStream = await webrtcManager.getLocalStream(true, false);')],
        ],
    },
    {
        name: 'the silent-mic sentinel is armed only when a microphone was opened (listen-only reads the choice)',
        src: 'vp',
        holds: (c) => inOrder(body(c, 'const joinVoice = useCallback('),
            'const noMic = webrtcManager.isListenOnly();',
            'if (!noMic) armLocalDetectors(localStream);'),
        mutants: [
            ['armed unconditionally', replace('if (!noMic) armLocalDetectors(localStream);', 'armLocalDetectors(localStream);')],
        ],
    },
    {
        name: 'leaving forgets the choice (the next join re-reads the setting)',
        src: 'vp',
        holds: (c) => c.includes('micOffByChoiceRef.current = false;') && c.includes('setMicOffByChoice(false);'),
        mutants: [
            ['never reset', replace('micOffByChoiceRef.current = false;', '')],
        ],
    },
    {
        name: 'no "No microphone detected" help for a member who chose to have none',
        src: 'vp',
        holds: (c) => /\{listenOnly && !speakDenied && !micOffByChoice && \(\s*<div className="voice-error-mini">\s*\{NO_MIC_NOTICE\}/.test(c),
        mutants: [
            ['shown anyway', replace('listenOnly && !speakDenied && !micOffByChoice && (', 'listenOnly && !speakDenied && (')],
        ],
    },
    {
        name: 'VoiceSpeakState.receives reaches the mesh: setPeerReceives for others, setSelfReceives for us',
        src: 'vp',
        holds: (c) => {
            const b = body(c, 'const applySpeakState = useCallback(');
            return !!b
                && /if \(userId === currentUserId\) \{[\s\S]*?webrtcManager\.setSelfReceives\(receives\);\s*return;\s*\}/.test(b)
                && /\}\s*webrtcManager\.setPeerReceives\(userId, receives\);/.test(b);
        },
        mutants: [
            ['peers keep being sent media', replace('webrtcManager.setPeerReceives(userId, receives);', '')],
            ['our own flag is ignored', replace('webrtcManager.setSelfReceives(receives);', '')],
        ],
    },
    {
        name: 'a member who leaves is forgotten by the receive flags too',
        src: 'vp',
        holds: (c) => (body(c, 'const handleUserLeft = ') ?? '').includes('if (tornDown) webrtcManager.forgetPeerReceives(payload.user_id);'),
        mutants: [
            ['never forgotten', replace('if (tornDown) webrtcManager.forgetPeerReceives(payload.user_id);', '')],
        ],
    },
    {
        name: 'the status ping says "no microphone" from the listen-only state',
        src: 'vp',
        holds: (c) => /buildVoiceStatus\(\{[^}]*noMic: listenOnlyRef\.current \}\)/.test(body(c, 'const broadcastStatus = useCallback(') ?? ''),
        mutants: [
            ['never sent', replace(', noMic: listenOnlyRef.current }', ', noMic: false }')],
        ],
    },
    {
        name: 'Chat passes streamOnly from the channel row through isRestricted (an admin is never stream-only)',
        src: 'chat',
        holds: (c) => /streamOnly=\{isRestricted\(\(channels\.find\(c => c\.id === currentVoiceChannel\.id\) \?\? currentVoiceChannel\)\.my_permissions, PERM\.STREAM_ONLY\)\}/.test(c),
        mutants: [
            ['through hasPerm, which an admin passes', replace('streamOnly={isRestricted(', 'streamOnly={hasPerm(')],
        ],
    },
    {
        name: 'a stream-only account is not given a voice channel as its text view (the server refuses that room)',
        src: 'chat',
        holds: (c) => /const fallback = isRestricted\(channels\[0\]\.my_permissions, PERM\.STREAM_ONLY\) \? undefined : channels\[0\];\s*const textChannel = channels\.find\(c => c\.channel_type === 0\) \|\| fallback;\s*if \(textChannel\) setCurrentChannel\(textChannel\);/.test(c),
        mutants: [
            ['the first channel, whatever it is', replace('|| fallback;', '|| channels[0];')],
        ],
    },
    {
        name: 'the sidebar roster shows "no microphone" instead of "muted"',
        src: 'chat',
        holds: (c) => /\{user\.noMic\s*\?\s*<span className="voice-status-icon no-mic" title="No microphone"[^>]*><NoMicIcon \/><\/span>\s*:\s*user\.isMuted &&/.test(c),
        mutants: [
            ['muted wins', replace('{user.noMic', '{false')],
        ],
    },
    {
        name: 'the voice stage chip shows "no microphone" instead of "muted"',
        src: 'stage',
        holds: (c) => /\{user\.noMic\s*\?\s*<span title="No microphone"[^>]*><NoMicIcon /.test(c),
        mutants: [
            ['muted wins', replace('{user.noMic', '{false')],
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
