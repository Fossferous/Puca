/**
 * Boundary behaviour of the pure gap-diff helpers. The integration seams are
 * covered in reconnectCatchup.test.ts; this file pins the arithmetic that
 * decides "new arrival" vs "same message seen twice" — the slack exists
 * because WS frames carry whole seconds while Postgres keeps microseconds,
 * and getting the comparison wrong either re-announces every message after
 * every gap or silently eats real ones.
 */
import { describe, it, expect } from 'vitest';
import {
    DM_SLACK_MS, computeChannelCatchup, computeDmCandidates, computeServerCatchup, dmBaseline,
} from '../api/reconnectCatchupCore';

const T0 = Date.parse('2026-08-11T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const c = (id: string, at: string | null) => ({ id, last_message_at: at });

describe('computeServerCatchup', () => {
    const never = () => false;

    it('growth counts, equal and shrunk do not', () => {
        const snap = new Map([['a', 2], ['b', 2], ['c', 2]]);
        const fresh = [
            { server_id: 'a', unread_count: 3 },
            { server_id: 'b', unread_count: 2 },
            { server_id: 'c', unread_count: 1 },
        ];
        expect(computeServerCatchup(snap, fresh, never)).toEqual(['a']);
    });

    it('a server absent from the baseline grows from zero', () => {
        expect(computeServerCatchup(new Map(), [{ server_id: 'new', unread_count: 1 }], never))
            .toEqual(['new']);
    });

    it('quiet filters exactly the quiet server', () => {
        const fresh = [
            { server_id: 'loud', unread_count: 1 },
            { server_id: 'muted', unread_count: 1 },
        ];
        expect(computeServerCatchup(new Map(), fresh, id => id === 'muted')).toEqual(['loud']);
    });
});

describe('computeChannelCatchup', () => {
    const never = () => false;

    it('one grown unmuted channel is enough; muted growth alone is not', () => {
        const snap = new Map([[10, 1], [11, 1]]);
        const fresh = [{
            server_id: 's', unread_count: 9,
            channels: [{ channel_id: 10, unread_count: 5 }, { channel_id: 11, unread_count: 1 }],
        }];
        expect(computeChannelCatchup(snap, fresh, never, id => id === 10),
            'the only grown channel is muted').toEqual([]);
        expect(computeChannelCatchup(snap, fresh, never, never),
            'POSITIVE CONTROL: unmuted, the same growth fires').toEqual(['s']);
    });

    it('a quiet server is filtered before its channels are considered', () => {
        const fresh = [{
            server_id: 's', unread_count: 3,
            channels: [{ channel_id: 10, unread_count: 3 }],
        }];
        expect(computeChannelCatchup(new Map(), fresh, () => true, never)).toEqual([]);
    });

    it('a channel absent from the baseline grows from zero', () => {
        const fresh = [{
            server_id: 's', unread_count: 1,
            channels: [{ channel_id: 77, unread_count: 1 }],
        }];
        expect(computeChannelCatchup(new Map(), fresh, never, never)).toEqual(['s']);
    });

    it('a row without channels contributes nothing (mixed-backend safety)', () => {
        expect(computeChannelCatchup(new Map(), [{ server_id: 's', unread_count: 5 }], never, never))
            .toEqual([]);
    });
});

describe('computeDmCandidates', () => {
    it('exactly-at-slack is the SAME message; one ms past it is new', () => {
        const snap = new Map([['same', T0], ['new', T0]]);
        const convs = [
            c('same', iso(T0 + DM_SLACK_MS)),
            c('new', iso(T0 + DM_SLACK_MS + 1)),
        ];
        expect(computeDmCandidates(snap, convs).map(x => x.id)).toEqual(['new']);
    });

    it('absent from the baseline = new conversation = candidate', () => {
        expect(computeDmCandidates(new Map(), [c('x', iso(T0))]).map(x => x.id)).toEqual(['x']);
    });

    it('null and unparseable timestamps are never candidates', () => {
        expect(computeDmCandidates(new Map(), [c('n', null), c('bad', 'not a date')])).toEqual([]);
    });

    it('candidates come most recent first (the lookup cap keeps the newest)', () => {
        const convs = [c('old', iso(T0 + 10_000)), c('newest', iso(T0 + 30_000)), c('mid', iso(T0 + 20_000))];
        expect(computeDmCandidates(new Map(), convs).map(x => x.id)).toEqual(['newest', 'mid', 'old']);
    });
});

describe('dmBaseline', () => {
    it('maps parseable timestamps and skips the rest', () => {
        const m = dmBaseline([c('a', iso(T0)), c('b', null), c('d', 'garbage')]);
        expect(m.get('a')).toBe(T0);
        expect(m.has('b')).toBe(false);
        expect(m.has('d')).toBe(false);
    });
});
