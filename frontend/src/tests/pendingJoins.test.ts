/**
 * PendingJoins — the join-announce gate.
 *
 * Every case here is a real event ordering VoicePanel sees. Each was checked
 * to go RED by reverting the corresponding line of the helper (CLAUDE.md:
 * distrust green tests).
 */
import { describe, it, expect } from 'vitest';
import { PendingJoins, type JoinEvidence } from '../utils/pendingJoins';

const LIMITS = { graceMs: 1500, timeoutMs: 10_000 };
const NONE: JoinEvidence = { encrypted: false, present: false };
const PRESENT: JoinEvidence = { encrypted: false, present: true };
const ENCRYPTED: JoinEvidence = { encrypted: true, present: true };

function rig() {
    let t = 1_000_000;
    const joins = new PendingJoins(() => t);
    return {
        joins,
        advance: (ms: number) => { t += ms; },
        take: (ev: JoinEvidence | ((id: number) => JoinEvidence)) =>
            joins.takeReady(typeof ev === 'function' ? ev : () => ev, LIMITS),
    };
}

describe('PendingJoins', () => {
    it('announces on the encryption verdict, exactly once', () => {
        const { joins, take } = rig();
        expect(joins.add(7, 'bob')).toBe(true);

        expect(take(ENCRYPTED)).toEqual([{ id: 7, name: 'bob', reason: 'encrypted' }]);
        // Removed on the way out — a second tick must not double-chime.
        expect(take(ENCRYPTED)).toEqual([]);
        expect(joins.size).toBe(0);
    });

    it('a listen-only joiner who never publishes announces after the presence grace', () => {
        // sfuManager reads 'negotiating' forever for a participant with no
        // publications; without the grace arm they would only ever chime at
        // the 10 s timeout.
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');

        expect(take(PRESENT)).toEqual([]);
        advance(1499);
        expect(take(PRESENT)).toEqual([]);
        advance(1);
        expect(take(PRESENT)).toEqual([{ id: 7, name: 'bob', reason: 'present' }]);
    });

    it('presence must be CONTINUOUS — losing it resets the grace', () => {
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');

        take(PRESENT);            // present from t0
        advance(1000);
        take(NONE);               // gone at t0+1000
        advance(1000);
        take(PRESENT);            // back at t0+2000 — the run restarts here
        advance(1499);
        expect(take(PRESENT)).toEqual([]);          // t0+3499: 1499 into the SECOND run
        advance(1);
        expect(take(PRESENT)).toHaveLength(1);      // t0+3500
    });

    it('every join eventually chimes: the hard timeout fires with no evidence at all', () => {
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');

        advance(9_999);
        expect(take(NONE)).toEqual([]);
        advance(1);
        expect(take(NONE)).toEqual([{ id: 7, name: 'bob', reason: 'timeout' }]);
    });

    it('a replayed StreamStarted does not restart the timeout clock', () => {
        const { joins, take, advance } = rig();
        expect(joins.add(7, 'bob')).toBe(true);
        advance(7_000);
        expect(joins.add(7, 'bob')).toBe(false);    // replay: already pending
        advance(3_000);                              // t0 + 10 000, not t0 + 17 000
        expect(take(NONE)).toEqual([{ id: 7, name: 'bob', reason: 'timeout' }]);
    });

    it('a peer who leaves inside the window never chimes', () => {
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');
        expect(joins.drop(7)).toBe(true);
        expect(joins.drop(7)).toBe(false);          // already gone

        advance(60_000);
        expect(take(ENCRYPTED)).toEqual([]);
        expect(take(NONE)).toEqual([]);
    });

    it('clear() returns the ids it dropped so their chips can be cleared, and nothing announces afterwards', () => {
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');
        joins.add(8, 'cat');

        expect(joins.clear().sort()).toEqual([7, 8]);
        expect(joins.size).toBe(0);
        advance(60_000);
        expect(take(ENCRYPTED)).toEqual([]);
    });

    it('tracks peers independently, and does NOT return an entry with no evidence and no timeout', () => {
        // The last clause is the positive control: a takeReady that returned
        // everything would pass every "eventually announces" case above.
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');
        joins.add(8, 'cat');

        advance(500);
        const ready = take(id => (id === 7 ? ENCRYPTED : NONE));
        expect(ready).toEqual([{ id: 7, name: 'bob', reason: 'encrypted' }]);
        expect(joins.ids()).toEqual([8]);
    });

    it('has() reports a held id so a replay is not re-classified, and stops once it resolves or drops', () => {
        const { joins, take } = rig();
        expect(joins.has(7)).toBe(false);
        joins.add(7, 'bob');
        expect(joins.has(7)).toBe(true);
        take(ENCRYPTED);
        expect(joins.has(7)).toBe(false);
        joins.add(8, 'cat');
        joins.drop(8);
        expect(joins.has(8)).toBe(false);
    });

    it('prefers the strongest reason when several hold at once', () => {
        const { joins, take, advance } = rig();
        joins.add(7, 'bob');
        take(PRESENT);
        advance(20_000);   // past both the grace and the timeout
        expect(take(ENCRYPTED)[0].reason).toBe('encrypted');

        joins.add(8, 'cat');
        take(PRESENT);
        advance(20_000);
        expect(take(PRESENT)[0].reason).toBe('present');
    });
});
