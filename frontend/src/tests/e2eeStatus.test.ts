import { describe, it, expect } from 'vitest';
import { mediaE2eeExplanation, localMediaBlockNotice, localMediaNotice } from '../api/rtc/e2eeStatus';

/**
 * The PRE-JOIN notice. The badge tooltip only exists once a peer is present
 * and only on hover; this is the visible line that stops a Firefox/Safari
 * user from pressing Join into a call where nobody can hear them.
 */
describe('localMediaBlockNotice', () => {
    const base = { supported: false, required: true, serverRequired: false, sfuMode: false };

    it('is silent on a supported engine, whatever is required (positive control for the rig)', () => {
        expect(localMediaBlockNotice({ ...base, supported: true })).toBeNull();
        expect(localMediaBlockNotice({ ...base, supported: true, sfuMode: true })).toBeNull();
        expect(localMediaBlockNotice({ ...base, supported: true, serverRequired: true })).toBeNull();
    });

    it('is silent when nothing requires encryption on a mesh call (transport-only is then allowed)', () => {
        expect(localMediaBlockNotice({ ...base, required: false })).toBeNull();
    });

    it('warns BEFORE join on an unsupported engine under the default enforcement, and says how to change it', () => {
        const s = localMediaBlockNotice(base)!;
        expect(s).toMatch(/blocked/i);
        expect(s).toMatch(/nobody’s voice or video plays/i);
        expect(s).toContain('Require encryption for calls');
        expect(s).toContain('Settings → Privacy & Safety');
        expect(s).toMatch(/Firefox|Safari|iOS/);
    });

    it('under a SERVER policy, offers only the native apps', () => {
        const s = localMediaBlockNotice({ ...base, serverRequired: true })!;
        expect(s).not.toContain('Settings → Privacy & Safety');
        expect(s).toMatch(/Windows or Android app/i);
    });

    it('on an SFU channel, warns regardless of the setting because the join itself refuses', () => {
        const s = localMediaBlockNotice({ ...base, required: false, sfuMode: true })!;
        expect(s).toMatch(/encrypted-only/i);
        expect(s).toMatch(/joining will fail/i);
    });
});

describe('localMediaNotice (the same notice, with its severity)', () => {
    const base = { supported: false, required: true, serverRequired: false, sfuMode: false };

    it('says nothing on a supported engine (positive control for the rig)', () => {
        expect(localMediaNotice({ ...base, supported: true })).toBeNull();
        expect(localMediaNotice({ ...base, supported: true, required: false })).toBeNull();
    });

    it('BLOCKS under enforcement, with exactly the text the text-only view returns', () => {
        const n = localMediaNotice(base)!;
        expect(n.level).toBe('blocked');
        expect(n.text).toBe(localMediaBlockNotice(base));
    });

    it('WARNS, but does not block, when the user turned enforcement off on a mesh call', () => {
        // The old helper was silent here — "not required" then read as
        // "encrypted anyway". The call still goes ahead: the text-only view
        // stays null, so nothing that keys on it blocks the join.
        const i = { ...base, required: false };
        const n = localMediaNotice(i)!;
        expect(n.level).toBe('warning');
        expect(n.text).toMatch(/will not be end-to-end encrypted/i);
        expect(n.text).toMatch(/pass through the server/i);
        expect(n.text).toContain('Require encryption for calls');
        expect(localMediaBlockNotice(i)).toBeNull();
    });

    it('on an SFU channel blocks whatever the setting: the join itself refuses', () => {
        expect(localMediaNotice({ ...base, required: false, sfuMode: true })!.level).toBe('blocked');
    });

    it('the remedy names a Chromium browser before the native apps: the API is Chromium’s, not Windows’s', () => {
        // A Linux or macOS user has Chrome available; sending them only to
        // "the Windows or Android app" sends them somewhere they may not be.
        for (const i of [base, { ...base, serverRequired: true }, { ...base, required: false }, { ...base, sfuMode: true }]) {
            expect(localMediaNotice(i)!.text).toMatch(/Chromium-based browser \(Chrome, Edge or Brave\)/);
        }
    });
});

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

    /**
     * requireMediaE2ee defaults to ON, so a first-time Firefox/Safari web user
     * has media blocked BOTH ways with no setting ever touched. The enforced
     * wording must say exactly that, and exactly what changes it — including
     * the cost of the change, so nobody flips it believing it is harmless.
     */
    it('under enforcement, the local-unsupported wording says media is blocked both ways and names the setting that changes it', () => {
        const s = mediaE2eeExplanation('local-unsupported', '', true)!;
        expect(s).toMatch(/blocked both ways/i);
        expect(s).toMatch(/microphone/i);
        expect(s).toContain('Require encryption for calls');
        expect(s).toContain('Settings → Privacy & Safety');
        // The cost of turning it off is stated in the same breath.
        expect(s).toMatch(/server in a form it can access/i);
        expect(s).toMatch(/Firefox|Safari|iOS/);
    });

    it('when the SERVER requires encryption, the remedy does not offer a setting the user cannot change', () => {
        const s = mediaE2eeExplanation('local-unsupported', '', true, /* serverRequired */ true)!;
        expect(s).toMatch(/blocked both ways/i);
        expect(s).toMatch(/server requires encrypted calls/i);
        expect(s).not.toContain('Settings → Privacy & Safety');
        expect(s).toMatch(/Windows or Android app/i);
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
