/**
 * A member's mute/deafen after a JOIN - VoicePanel.tsx wiring that only the
 * live rigs otherwise exercise.
 *
 * The bug this pins (review of the DeepFilter pause, 2026-10-04, reproduced
 * live on a mesh call): a status ping is one-shot, and every client keeps a
 * member's roster row - flags included - across every replay. A joining
 * client never re-stated its own status, and the server tells the room
 * nothing on a take-over, so after "Move here", a reload or a rejoin, the
 * room still held the OLD session's flags. A member who had deafened on their
 * PC and moved to their phone showed deafened for everyone, and the other
 * side's DeepFilter stayed paused for "all deafened" while the phone heard
 * every word - until somebody toggled something.
 *
 * The behaviour of the pieces has tests of its own: dfPause.test.ts (a new
 * media session makes an old deafen unknown), voiceRoster.test.ts (the status
 * stamp), dfPauseSignals.test.ts (the session keys). What those cannot see is
 * whether the panel still CALLS them. Same method as speakPermsWiring.test.ts:
 * every pin is checked against the real source AND against mutated copies of
 * it, so a pin that could not fail would fail its own mutation case. Comments
 * are stripped first: prose that mentions a call does not count as the call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const VP = stripComments(readFileSync(join(here, '..', 'components', 'VoicePanel.tsx'), 'utf8'));

/** The text of one declaration: from `decl` to the first line at the SAME
 *  indentation that starts with `}`. null when `decl` is missing or ambiguous. */
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

const replaceRe = (re: RegExp, to: string) => (code: string) => code.replace(re, to);

interface Pin {
    name: string;
    holds: (code: string) => boolean;
    mutants: Array<[label: string, mutate: (code: string) => string]>;
}

const PINS: Pin[] = [
    {
        name: 'joinVoice re-states our status right after its StartStream, inside the join (not its failure path)',
        holds: (c) => inOrder(body(c, 'const joinVoice = useCallback('), 'wsClient.startStream(roomId);', 'restateStatusSoon();', '} catch (err)'),
        mutants: [
            ['the join never re-states', replaceRe(/(wsClient\.startStream\(roomId\);\s*)restateStatusSoon\(\);/, '$1')],
            ['it re-states before the StartStream', replaceRe(/(wsClient\.startStream\(roomId\);)(\s*)restateStatusSoon\(\);(\s*playJoinSound)/, 'restateStatusSoon();$2$1$3')],
            ['only a failed join re-states', replaceRe(/(wsClient\.startStream\(roomId\);\s*)restateStatusSoon\(\);([\s\S]*?\} catch \(err\) \{)/, '$1$2 restateStatusSoon();')],
        ],
    },
    {
        name: 'restateStatusSoon sends our CURRENT mute/deafen from a cancellable timer, only while still in voice',
        holds: (c) => {
            const b = body(c, 'const restateStatusSoon = useCallback(');
            return inOrder(b, 'setTimeout(', 'if (!isInVoiceRef.current) return;', 'broadcastStatusRef.current(isMutedRef.current, isDeafenedRef.current);', 'rebroadcastTimersRef.current.add(');
        },
        mutants: [
            ['no in-voice guard', replaceRe(/(const restateStatusSoon = useCallback\([\s\S]*?)if \(!isInVoiceRef\.current\) return;/, '$1')],
            ['a fixed status instead of ours', replaceRe(/(const restateStatusSoon = useCallback\([\s\S]*?)broadcastStatusRef\.current\(isMutedRef\.current, isDeafenedRef\.current\);/, '$1broadcastStatusRef.current(false, false);')],
            ['the timer is not tracked (a room change cannot cancel it)', replaceRe(/(const restateStatusSoon = useCallback\([\s\S]*?)rebroadcastTimersRef\.current\.add\(statusTimer\);/, '$1')],
        ],
    },
    {
        name: 'our own reconnect still re-states (the path this was factored out of)',
        holds: (c) => inOrder(body(c, 'const onReconnected = () => {'), 'wsClient.startStream(roomId);', 'restateStatusSoon();'),
        mutants: [
            ['the reconnect never re-states', replaceRe(/(const onReconnected = \(\) => \{[\s\S]*?)restateStatusSoon\(\);/, '$1')],
        ],
    },
    {
        name: "a member's status ping is applied through applyVoiceStatus (stamped), never written field by field",
        holds: (c) => {
            const b = body(c, 'const handleChatMessage = (msg: ServerMessage) => {');
            return !!b && b.includes('applyVoiceStatus(roomId, payload.sender.id, status)') && !/\.isDeafened\s*=\s*status\./.test(b);
        },
        mutants: [
            ['the old unstamped writes', replaceRe(/if \(applyVoiceStatus\(roomId, payload\.sender\.id, status\)\) refreshVoiceUsersList\(\);/,
                'const u = globalVoiceUsers.get(roomId)?.get(payload.sender.id); if (u) { u.isMuted = status.muted; u.isDeafened = status.deafened; refreshVoiceUsersList(); }')],
        ],
    },
    {
        name: 'dfPause is told the session of every media connection, mesh AND SFU',
        holds: (c) => /sessions: \(\) => \[\.\.\.webrtcManager\.peerSessions\(\), \.\.\.sfuManager\.participantSessions\(\)\]/.test(body(c, 'return attachDfPause({') ?? ''),
        mutants: [
            ['no sessions at all', replaceRe(/\n\s*sessions: \(\) => \[[^\n]*\],?/, '')],
            ['the SFU half missing', replaceRe(/, \.\.\.sfuManager\.participantSessions\(\)\]/, ']')],
        ],
    },
];

describe('VoicePanel: a join re-states our status, and dfPause can tell sessions apart', () => {
    for (const pin of PINS) {
        it(pin.name, () => {
            expect(pin.holds(VP)).toBe(true);
        });
        for (const [label, mutate] of pin.mutants) {
            it(`${pin.name} - fails when ${label}`, () => {
                const mutated = mutate(VP);
                expect(mutated).not.toBe(VP); // the mutation applied
                expect(pin.holds(mutated)).toBe(false);
            });
        }
    }
});
