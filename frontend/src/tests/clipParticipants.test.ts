/**
 * The client's declared-participants list for a clip (api/clips/clipParticipants.ts).
 *
 * The defect this pins (2026-09-02): the list used to be a Set that only grew
 * from the moment of arming, so someone who left the call twenty minutes
 * before the clip was still a required approver — offline, they blocked the
 * clip until it expired. Every "must NOT be declared" case here has a sibling
 * positive control proving the same rig CAN declare that person when they
 * were actually in the window.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIP_PAD_MS, clipWindowFor, DeclaredParticipants, LEAVE_SLACK_MS, MAX_SPANS_PER_USER, RETENTION_MS } from '../api/clips/clipParticipants';

const SELF = 1;
const MIN = 60_000;

/** A 2-minute clip sealed at `sealedAt` — the PRODUCTION window arithmetic, not a re-implementation. */
function window(sealedAt: number, durationMs = 120_000) {
    return clipWindowFor(sealedAt, durationMs);
}

describe('clipWindowFor', () => {
    it('pads the start by the server PAD and leaves the end at the seal', () => {
        expect(clipWindowFor(1_000_000, 30_000)).toEqual({ start: 1_000_000 - 30_000 - CLIP_PAD_MS, end: 1_000_000 });
    });

    // The 2026-09-02 bug lived in the WIRING (an argument-free getter over a
    // grow-only Set), not in any pure function — so the pure tests below could
    // all stay green while the composer went back to declaring everyone. This
    // pins the composer's single call site to the production window.
    it('is what the composer passes to getDeclaredParticipants (call-site binding)', () => {
        const src = readFileSync(join(__dirname, '..', 'components', 'ClipComposerModal.tsx'), 'utf8');
        const calls = src.match(/getDeclaredParticipants\(/g) ?? [];
        expect(calls).toHaveLength(1);
        const bound = /const w = clipWindowFor\(sealedAt, sealed\.durationMs\); return getDeclaredParticipants\(w\.start, w\.end\)/;
        expect(src).toMatch(bound);
        // positive control for the regex itself: the regression shape does not match
        expect('getDeclaredParticipants(0, Date.now())').not.toMatch(bound);
    });
});

describe('DeclaredParticipants — the window bound', () => {
    it('declares everyone present throughout, minus the proposer', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2, 3], t0);
        const w = window(t0 + 10 * MIN);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([2, 3]);
    });

    it('does NOT declare someone who left long before the clip (the reported bug)', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2, 3], t0);
        d.observe([SELF, 2], t0 + 1 * MIN);            // 3 leaves at +1 min
        const w = window(t0 + 20 * MIN);               // clip covers +18..+20 min
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([2]);
    });

    it('positive control: the same departure INSIDE the window is declared', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2, 3], t0);
        d.observe([SELF, 2], t0 + 19 * MIN);           // 3 leaves at +19 min
        const w = window(t0 + 20 * MIN);               // clip covers +18..+20 min
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([2, 3]);
    });

    it('a departure within LEAVE_SLACK_MS before the window still counts (voice can outlive the roster row)', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 3], t0);
        const w = window(t0 + 20 * MIN);
        d.observe([SELF], w.start - LEAVE_SLACK_MS + 1);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([3]);
        // and one millisecond further back is out
        const d2 = new DeclaredParticipants();
        d2.reset([SELF, 3], t0);
        d2.observe([SELF], w.start - LEAVE_SLACK_MS - 1);
        expect(d2.declaredFor(w.start, w.end, { self: SELF })).toEqual([]);
    });

    it('does NOT declare someone who joined after the clip ended; positive control just before', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF], t0);
        const sealedAt = t0 + 10 * MIN;
        d.observe([SELF, 4], sealedAt + 1);            // 4 arrives after the seal
        const w = window(sealedAt);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([]);

        const d2 = new DeclaredParticipants();
        d2.reset([SELF], t0);
        d2.observe([SELF, 4], sealedAt - 1);           // 4 arrives a ms before the seal
        expect(d2.declaredFor(w.start, w.end, { self: SELF })).toEqual([4]);
    });

    it('left long ago and came back AFTER the seal: not in the clip; came back BEFORE it: declared', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 5], t0);
        d.observe([SELF], t0 + 1 * MIN);               // 5 leaves
        const sealedAt = t0 + 20 * MIN;
        d.observe([SELF, 5], sealedAt + 5_000);        // 5 rejoins after the seal
        const w = window(sealedAt);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([]);

        const d2 = new DeclaredParticipants();
        d2.reset([SELF, 5], t0);
        d2.observe([SELF], t0 + 1 * MIN);
        d2.observe([SELF, 5], sealedAt - 30_000);      // 5 rejoins during the clip
        expect(d2.declaredFor(w.start, w.end, { self: SELF })).toEqual([5]);
    });

    it('stillAudible (SFU keep-alive) overrides a stale roster departure', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 6], t0);
        d.observe([SELF], t0 + 1 * MIN);               // roster dropped 6 on a WS blip
        const w = window(t0 + 20 * MIN);
        expect(d.declaredFor(w.start, w.end, { self: SELF, stillAudible: id => id === 6 })).toEqual([6]);
        // positive control for the probe: when it says no, the stale span stays stale
        expect(d.declaredFor(w.start, w.end, { self: SELF, stillAudible: () => false })).toEqual([]);
    });

    it('stillAudible is keyed on the USER: a roster row that heals after the seal cannot cancel the rescue (review finding)', () => {
        // B's socket blips at +0; the roster drops B (span closed) but B's SFU
        // audio keeps flowing into the ring. The clip is sealed 5 min later
        // with B audible throughout; B's socket then reconnects AFTER the seal
        // and before the request, so observe() opens a second, post-window span.
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 8], t0);
        d.observe([SELF], t0);                          // roster row gone at t0
        const sealedAt = t0 + 5 * MIN;
        d.observe([SELF, 8], sealedAt + 10_000);        // row heals after the seal
        const w = window(sealedAt, 30_000);
        expect(d.declaredFor(w.start, w.end, { self: SELF, stillAudible: id => id === 8 })).toEqual([8]);
        // and without the probe the same spans are (correctly) out of the window
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([]);
    });

    it('an SFU-present peer fed through observe() keeps an OPEN span while the roster has dropped them', () => {
        // The callers union the roster with the SFU's live participants, so a
        // blipped peer never gets a closed span while they are still audible.
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 8], t0);
        d.observe([SELF, 8], t0 + 1 * MIN);             // roster dropped 8, SFU still has them
        d.observe([SELF, 8], t0 + 6 * MIN);
        expect(d.snapshot()[8]).toHaveLength(1);
        expect(d.snapshot()[8][0].leftAt).toBeNull();
        const w = window(t0 + 7 * MIN, 30_000);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([8]);
        // positive control: once BOTH signals drop them, the span closes and ages out
        d.observe([SELF], t0 + 8 * MIN);
        const w2 = window(t0 + 20 * MIN, 30_000);
        expect(d.declaredFor(w2.start, w2.end, { self: SELF })).toEqual([]);
    });

    it('stillAudible cannot conjure someone who only ever joined after the seal', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF], t0);
        const sealedAt = t0 + 10 * MIN;
        d.observe([SELF, 7], sealedAt + 1);
        const w = window(sealedAt);
        expect(d.declaredFor(w.start, w.end, { self: SELF, stillAudible: () => true })).toEqual([]);
    });
});

describe('DeclaredParticipants — arming semantics', () => {
    it('reset() on a fresh arm forgets earlier spans', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2], t0);
        d.reset([SELF, 3], t0 + 1000);
        const w = window(t0 + 5 * MIN);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([3]);
    });

    it('observe() on a re-assert MERGES: someone who left between two arm notifications stays declared', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2, 3], t0);
        d.observe([SELF, 2], t0 + 500);                // 3 left between armNative's two notifications
        const w = window(t0 + 5_000, 5_000);           // a 5 s clip sealed 5 s after arming
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([2, 3]);
    });

    it('observe() is idempotent for an unchanged roster (no duplicate spans)', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2], t0);
        for (let i = 1; i <= 5; i++) d.observe([SELF, 2], t0 + i * 1000);
        expect(d.snapshot()[2]).toHaveLength(1);
        expect(d.snapshot()[2][0].leftAt).toBeNull();
    });

    it('observe([]) (the room map is gone) closes everyone', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2, 3], t0);
        d.observe([], t0 + 1 * MIN);
        const w = window(t0 + 20 * MIN);
        expect(d.declaredFor(w.start, w.end, { self: SELF })).toEqual([]);
        expect(d.snapshot()[2][0].leftAt).toBe(t0 + 1 * MIN);
    });

    it('snapshot() is a copy', () => {
        const d = new DeclaredParticipants();
        d.reset([2], 5);
        const s = d.snapshot();
        s[2][0].leftAt = 99;
        expect(d.snapshot()[2][0].leftAt).toBeNull();
    });
});

describe('DeclaredParticipants — bounds', () => {
    it('forgets closed spans older than RETENTION_MS, never an open one', () => {
        const d = new DeclaredParticipants();
        const t0 = 1_000_000;
        d.reset([SELF, 2, 3], t0);
        d.observe([SELF, 3], t0 + 1000);               // 2 leaves
        d.observe([SELF, 3], t0 + 1000 + RETENTION_MS + 1);
        expect(d.snapshot()[2]).toBeUndefined();
        expect(d.snapshot()[3]).toHaveLength(1);
        expect(d.snapshot()[SELF]).toHaveLength(1);
    });

    it('a flapping user keeps at most MAX_SPANS_PER_USER spans, dropping the oldest closed', () => {
        const d = new DeclaredParticipants();
        let t = 1_000_000;
        d.reset([SELF], t);
        for (let i = 0; i < MAX_SPANS_PER_USER + 10; i++) {
            d.observe([SELF, 9], t += 1000);
            d.observe([SELF], t += 1000);
        }
        d.observe([SELF, 9], t += 1000);               // ends present
        const spans = d.snapshot()[9];
        expect(spans).toHaveLength(MAX_SPANS_PER_USER);
        expect(spans[spans.length - 1].leftAt).toBeNull();
        // the survivors are the NEWEST closed ones plus the open one
        expect(spans[0].joinedAt).toBeGreaterThan(1_000_000 + 10 * 2000);
    });
});
