import { describe, it, expect } from 'vitest';
import { combineHostIdle, decideAfk, AFK_TIMEOUT_CHOICES_MIN, DEFAULT_AFK_TIMEOUT_MS } from '../utils/afkIdle';

// The Discord copy (see afkIdle.ts's header): idle for the window = moved,
// with NO exemption for muted / deafened / listen-only — those aren't even
// parameters of the decision, which is the strongest pin this suite has. If
// someone re-adds such an exemption they must widen the signature, and this
// comment is here to make them read the header first. `watching` WAS widened
// in, deliberately (2026-09-02), and is pinned below to the no-probe path.
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

    it('watching a stream keeps a viewer who has NO OS probe (a phone in the docked mini-player)', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: false, watching: true, osIdleSecs: null, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'wait', recheckInMs: T });
    });

    it('watching does NOT outrank the OS probe — a silent desktop viewer is still moved at Discord\'s line', () => {
        expect(decideAfk({ timeoutMs: T, broadcasting: false, watching: true, osIdleSecs: 15 * 60, lastAppInputMs: null, nowMs: NOW }))
            .toEqual({ action: 'move' });
    });

    it('exposes exactly Discord\'s five timeout choices and the legacy default', () => {
        expect([...AFK_TIMEOUT_CHOICES_MIN]).toEqual([1, 5, 15, 30, 60]);
        expect(DEFAULT_AFK_TIMEOUT_MS).toBe(15 * 60 * 1000);
    });
});

// An embedding host (docs/EMBEDDING.md, idleSeconds) stands where the desktop
// app's OS probe stands. Púca for Steam Deck reads the Deck's own controls: in
// a hidden Steam page there is no in-app input while someone plays, and the
// in-app path alone moved a listening player to AFK mid-game.
describe('combineHostIdle — an embedding host says how long the person has been away', () => {
    const afk = (osIdleSecs: number | null, lastAppInputMs: number | null = null) =>
        decideAfk({ timeoutMs: T, broadcasting: false, osIdleSecs, lastAppInputMs, nowMs: NOW }).action;

    it('keeps a player who has been touching the controls, with no input in the page at all', () => {
        expect(combineHostIdle(5, null, NOW)).toBe(5);
        expect(afk(combineHostIdle(5, null, NOW))).toBe('wait');
    });

    it('moves someone who has touched neither the controls nor the page for the window', () => {
        expect(afk(combineHostIdle(15 * 60, NOW - 16 * 60_000, NOW))).toBe('move');
    });

    it('lets input inside the page count too: typing in the full view is presence', () => {
        expect(combineHostIdle(20 * 60, NOW - 30_000, NOW)).toBe(30);
        expect(afk(combineHostIdle(20 * 60, NOW - 30_000, NOW))).toBe('wait');
    });

    it('treats a host that "cannot tell" as no probe: the in-app path decides, as before', () => {
        expect(combineHostIdle(null, NOW - 30_000, NOW)).toBeNull();
        expect(afk(combineHostIdle(null, NOW - 30_000, NOW), NOW - 30_000)).toBe('wait');
        expect(afk(combineHostIdle(null, null, NOW), null)).toBe('move');
    });

    it('never answers a negative idle for input stamped a little in the future', () => {
        expect(combineHostIdle(100, NOW + 5000, NOW)).toBe(0);
    });
});
