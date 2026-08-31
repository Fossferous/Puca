import { describe, it, expect } from 'vitest';
import { decideAfk, AFK_TIMEOUT_CHOICES_MIN, DEFAULT_AFK_TIMEOUT_MS } from '../utils/afkIdle';

// The Discord copy (see afkIdle.ts's header): idle for the window = moved,
// with NO exemption for muted / deafened / listen-only / watching — those
// aren't even parameters of the decision, which is the strongest pin this
// suite has. If someone re-adds such an exemption they must widen the
// signature, and this comment is here to make them read the header first.
const NOW = 1_000_000_000;
const T = 15 * 60 * 1000;

describe('decideAfk — Discord AFK rules', () => {
    it('moves a user whose OS input has been idle for the whole window (game open but not played)', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: 15 * 60, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'move' });
        // Well past the window — the report's exact scenario: parked overnight.
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: 8 * 3600, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'move' });
    });

    it('keeps an actively playing gamer, with the recheck at the REMAINDER of the window', () => {
        const d = decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: 60, lastAppInputMs: null, nowMs: NOW });
        expect(d).toEqual({ action: 'wait', recheckInMs: T - 60_000 });
    });

    it('broadcasting (share/camera) is presence — waits a full window', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: true, osIdleSecs: 8 * 3600, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'wait', recheckInMs: T });
    });

    it('the OS probe outranks in-app input when both exist', () => {
        // App input an hour ago but the OS saw input 10s ago (typing in the
        // game, not the app): present.
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: 10, lastAppInputMs: NOW - 3600_000, nowMs: NOW }).action)
            .toBe('wait');
    });

    it('web/mobile fall back to in-app input', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: null, lastAppInputMs: NOW - 1000, nowMs: NOW }))
            .toEqual({ action: 'wait', recheckInMs: T - 1000 });
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: null, lastAppInputMs: NOW - T, nowMs: NOW }))
            .toEqual({ action: 'move' });
    });

    it('no probe and no recorded input at all → moved', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: null, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'move' });
    });

    it('exact boundary counts as idle (>=, matching "after the timeout")', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: T / 1000, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'move' });
    });

    it('a recheck is never scheduled closer than 1s (probe jitter must not spin)', () => {
        const d = decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs: (T - 10) / 1000, lastAppInputMs: null, nowMs: NOW });
        expect(d).toEqual({ action: 'wait', recheckInMs: 1000 });
    });

    it('exposes exactly Discord\'s five timeout choices and the legacy default', () => {
        expect([...AFK_TIMEOUT_CHOICES_MIN]).toEqual([1, 5, 15, 30, 60]);
        expect(DEFAULT_AFK_TIMEOUT_MS).toBe(15 * 60 * 1000);
    });
});
