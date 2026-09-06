/**
 * Departed-peer teardown — the client half of r2-3-L3-01.
 *
 * The bug: the mesh client closed a peer's RTCPeerConnection ONLY on
 * StreamStopped, and handleUserLeft touched nothing but the roster. A clean
 * LeaveRoom produces UserLeft alone (the stock client sends StopStream first;
 * a raw client need not), and once a member has left the room no eviction
 * can reach them — so a client that sent LeaveRoom and kept its pcs open went
 * on receiving everyone's microphone, on no roster, beyond every kick.
 *
 * VoicePanel is not mountable under vitest, so the decision is a pure export
 * (shouldTearDownDepartedPeer) shared by BOTH handlers, and the wiring test
 * below pins that handleUserLeft actually routes through it to closePeer.
 * Each refusal here was checked to go RED by reverting its line in the
 * predicate (CLAUDE.md: distrust green tests).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldTearDownDepartedPeer, type DepartedPeerContext } from '../utils/departedPeer';

const ROOM = 'voice_42';
const ME = 5;
const THEM = 7;

const mesh: DepartedPeerContext = {
    roomId: ROOM,
    currentUserId: ME,
    inVoice: true,
    sfuMode: false,
    sfuSessionAlive: false,
};

describe('shouldTearDownDepartedPeer', () => {
    // POSITIVE CONTROL. Every refusal below is a "must not tear down"
    // assertion; without this one a predicate that always said no would pass
    // the whole file.
    it('a UserLeft/StreamStopped for ANOTHER user in OUR room while in a mesh call tears the peer down', () => {
        expect(shouldTearDownDepartedPeer({ roomId: ROOM, userId: THEM }, mesh)).toBe(true);
    });

    it('the attack shape: the leaver held a live peer and no StreamStopped arrives — UserLeft alone is enough', () => {
        // Same inputs as the control on purpose: the predicate cannot tell
        // (and must not care) WHICH event carried the departure.
        const fromUserLeft = shouldTearDownDepartedPeer({ roomId: ROOM, userId: THEM }, mesh);
        const fromStreamStopped = shouldTearDownDepartedPeer({ roomId: ROOM, userId: THEM }, mesh);
        expect(fromUserLeft).toBe(true);
        expect(fromUserLeft).toBe(fromStreamStopped);
    });

    it('ignores a departure from a different room', () => {
        expect(shouldTearDownDepartedPeer({ roomId: 'voice_43', userId: THEM }, mesh)).toBe(false);
    });

    it('never tears down OURSELVES — RoomLeft / leaveVoice own self-teardown', () => {
        expect(shouldTearDownDepartedPeer({ roomId: ROOM, userId: ME }, mesh)).toBe(false);
    });

    it('does nothing while we are not in voice (no peer can exist before isInVoiceRef flips)', () => {
        expect(shouldTearDownDepartedPeer({ roomId: ROOM, userId: THEM }, { ...mesh, inVoice: false })).toBe(false);
    });

    it('SFU: keeps a peer whose LiveKit session is demonstrably still alive (a WS blip on THEIR side)', () => {
        // The SFU audio element is only created on TrackSubscribed, which never
        // re-fires for a surviving session; removing it silenced them for good.
        expect(shouldTearDownDepartedPeer(
            { roomId: ROOM, userId: THEM },
            { ...mesh, sfuMode: true, sfuSessionAlive: true },
        )).toBe(false);
    });

    it('SFU positive control: a peer whose LiveKit session is gone IS torn down', () => {
        expect(shouldTearDownDepartedPeer(
            { roomId: ROOM, userId: THEM },
            { ...mesh, sfuMode: true, sfuSessionAlive: false },
        )).toBe(true);
    });

    it('mesh ignores the SFU-liveness flag entirely (SFU peers are not mesh peers, and vice versa)', () => {
        // A stale `true` from hasParticipant must not spare a mesh peer.
        expect(shouldTearDownDepartedPeer(
            { roomId: ROOM, userId: THEM },
            { ...mesh, sfuMode: false, sfuSessionAlive: true },
        )).toBe(true);
    });
});

describe('VoicePanel wiring', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const vp = readFileSync(join(here, '..', 'components', 'VoicePanel.tsx'), 'utf8');

    // Isolate one handler's body by its declaration and the next `const` at
    // the same indentation, so the assertion is about THAT handler and not
    // about the file containing the words somewhere.
    const body = (decl: string) => {
        const start = vp.indexOf(decl);
        expect(start, `${decl} not found`).toBeGreaterThan(-1);
        const rest = vp.slice(start + decl.length);
        const end = rest.search(/\r?\n {8}const /);
        return end === -1 ? rest : rest.slice(0, end);
    };

    it('handleUserLeft routes the departed user through retireDepartedPeer', () => {
        expect(body('const handleUserLeft = ')).toContain('retireDepartedPeer(payload.user_id)');
    });

    it('the always-on StreamStopped handler uses the SAME helper (one predicate, two events)', () => {
        expect(body('const handleStreamStopped = ')).toContain('retireDepartedPeer(payload.streamer_id)');
    });

    it('retireDepartedPeer asks shouldTearDownDepartedPeer, then closes the mesh peer and its audio element', () => {
        const b = body('const retireDepartedPeer = ');
        const gate = b.indexOf('shouldTearDownDepartedPeer(');
        const close = b.indexOf('webrtcManager.closePeer(userId)');
        expect(gate).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(gate);
        expect(b).toContain('`audio-${userId}`');
        // The gate is fed the SFU-liveness the finding's regression case needs.
        expect(b).toContain('sfuManager.hasParticipant(userId)');
    });
});
