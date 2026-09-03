import { describe, it, expect } from 'vitest';
import { failureFor, RETRY_DELAYS_MS, RETRY_BUDGET_MS } from '../appConnection.utils';

describe('failureFor', () => {
    it('a server that did not answer is unreachable, whatever the update state', () => {
        expect(failureFor('unreachable', false)).toBe('unreachable');
        expect(failureFor('unreachable', true)).toBe('unreachable');
    });

    it('server healthy + this build out of date = say so, because retrying cannot fix it', () => {
        // The case that stranded a real user: since 0.9.1 the server refuses the
        // query-string token every client before 0.9.0 sends, while REST keeps
        // working — so the probe reports "ok" and the old build showed a dialog
        // blaming the user's firewall. 669 refusals in three days, still
        // arriving once a minute.
        expect(failureFor('ok', true)).toBe('stale-client');
    });

    it('POSITIVE CONTROL: server healthy and up to date is still a plain socket fault', () => {
        // Without this, the assertion above passes just as well for a function
        // that returns 'stale-client' for every healthy probe — which would tell
        // everyone to reinstall after any transient blip.
        expect(failureFor('ok', false)).toBe('socket');
    });

    it("a rejected token never reaches this screen, but must not read as 'up to date'", () => {
        // probeSession returns 'rejected' when the server refused the token; App
        // re-authenticates instead of rendering. If that ever changes, falling
        // through to 'socket' would be the wrong answer, so it is pinned here.
        expect(failureFor('rejected', false)).toBe('unreachable');
        expect(failureFor('rejected', true)).toBe('unreachable');
    });
});

describe('retry budget', () => {
    it('covers a backend restart, which the old 3-second budget did not', () => {
        // The old schedule was 3 attempts x 1s. A backend restart takes longer,
        // so every deploy threw the error dialog at everyone connected for a
        // condition that fixes itself. Anything under ~10s reintroduces that.
        expect(RETRY_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    });

    it('still gives up promptly enough that a dead socket is not an endless spinner', () => {
        expect(RETRY_BUDGET_MS).toBeLessThanOrEqual(30_000);
    });

    it('backs off rather than hammering a server that is coming back up', () => {
        for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
            expect(RETRY_DELAYS_MS[i]).toBeGreaterThan(RETRY_DELAYS_MS[i - 1]);
        }
    });
});
