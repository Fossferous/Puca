import { describe, it, expect } from 'vitest';
import { mediaE2eeExplanation } from '../api/rtc/e2eeStatus';

describe('mediaE2eeExplanation', () => {
    it('returns null when encrypted (nothing to explain)', () => {
        expect(mediaE2eeExplanation('encrypted', 'Bob')).toBeNull();
    });

    it('names the peer for a peer-unsupported downgrade', () => {
        const s = mediaE2eeExplanation('peer-unsupported', 'Bob')!;
        expect(s).toContain('Bob');
        expect(s.toLowerCase()).toContain('transport encryption only');
    });

    it('explains a local device limitation without blaming a peer', () => {
        const s = mediaE2eeExplanation('local-unsupported', '')!;
        expect(s.toLowerCase()).toContain('this device');
        // Names concrete unsupported engines so the user understands the cause.
        expect(s).toMatch(/Safari|iOS|Firefox/);
        // Reassures that transit encryption still applies.
        expect(s).toContain('DTLS-SRTP');
    });

    it('flags a verification failure as a possible tamper/out-of-date case', () => {
        const s = mediaE2eeExplanation('verification-failed', 'Carol')!;
        expect(s).toContain('Carol');
        expect(s.toLowerCase()).toContain('couldn’t verify');
        expect(s.toLowerCase()).toMatch(/network|out-of-date|out of date/);
    });

    it('under enforcement, says media is BLOCKED with a source-neutral reason', () => {
        const s = mediaE2eeExplanation('peer-unsupported', 'Bob', true)!;
        expect(s).toContain('Bob');
        expect(s.toLowerCase()).toContain('blocked');
        // Source-neutral wording works for both the user setting and a server policy.
        expect(s.toLowerCase()).toContain('required for this call');
        expect(s.toLowerCase()).not.toContain('you require');
    });

    it('shows a transient message while negotiating', () => {
        const s = mediaE2eeExplanation('negotiating', 'Dave')!;
        expect(s).toContain('Dave');
        expect(s.toLowerCase()).toContain('setting up');
    });

    it('says a plaintext SFU publisher is blocked, regardless of enforcement flag', () => {
        // The SFU receive path refuses unencrypted publications unconditionally,
        // so the wording must promise "blocked" with or without `enforced`.
        for (const enforced of [false, true]) {
            const s = mediaE2eeExplanation('peer-unencrypted', 'Eve', enforced)!;
            expect(s).toContain('Eve');
            expect(s.toLowerCase()).toContain('blocked');
        }
    });

    it('covers every reason variant (no silent undefined)', () => {
        const reasons = ['encrypted', 'negotiating', 'local-unsupported', 'peer-unsupported', 'peer-unencrypted', 'verification-failed'] as const;
        for (const r of reasons) {
            const out = mediaE2eeExplanation(r, 'X');
            expect(out === null || typeof out === 'string').toBe(true);
        }
    });
});
