// @vitest-environment jsdom
/**
 * The recovery code is deliberately never persisted — so what survives a
 * reload is only whether the user ever CONFIRMED saving one. Documents the
 * loss (positive control: a module reload drops the phrase) and the marker
 * that now points the user at Settings instead of saying nothing.
 *
 * The marker is the account's, like the code (review of signout-left): one
 * marker for the whole device told whoever signed in next that THEIR code was
 * never saved, and their answer took the warning away from the account it was
 * for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let store: Record<string, string>;
function backingStore() {
    const s: Record<string, string> = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in s ? s[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { s[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete s[k]; });
    return s;
}

beforeEach(() => { store = backingStore(); sessionStorage.clear(); vi.resetModules(); });

describe('the recovery phrase hand-off', () => {
    it('POSITIVE CONTROL: the phrase does not survive a module reload', async () => {
        const a = await import('../api/recoveryPrompt');
        a.setPendingRecoveryCode('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu', 'ann');
        vi.resetModules();
        const b = await import('../api/recoveryPrompt');
        expect(b.consumePendingRecoveryCode('ann')).toBeNull();
    });

    it('the unacknowledged marker DOES survive, until the user confirms', async () => {
        const a = await import('../api/recoveryPrompt');
        a.markRecoveryCodeUnacknowledged('ann');
        vi.resetModules();
        const b = await import('../api/recoveryPrompt');
        expect(b.recoveryCodeReminderDue('ann')).toBe(true);
        b.acknowledgeRecoveryCode('ann');
        expect(b.recoveryCodeReminderDue('ann')).toBe(false);
    });

    it('"Later" snoozes for the tab only; a new code re-arms it', async () => {
        const m = await import('../api/recoveryPrompt');
        m.markRecoveryCodeUnacknowledged('ann');
        m.snoozeRecoveryCodeReminder('ann');
        expect(m.recoveryCodeReminderDue('ann')).toBe(false);
        sessionStorage.clear();                       // a fresh tab
        expect(m.recoveryCodeReminderDue('ann')).toBe(true);
        m.snoozeRecoveryCodeReminder('ann');
        m.showRecoveryCode('one two three four five six seven eight nine ten eleven twelve', 'ann');
        expect(m.recoveryCodeReminderDue('ann')).toBe(true);
        expect(m.consumePendingRecoveryCode('ann')).toMatch(/^one two/);
    });
});

describe('whose marker it is', () => {
    it('only the account the code was made for is reminded, whatever the case of its name', async () => {
        const m = await import('../api/recoveryPrompt');
        m.markRecoveryCodeUnacknowledged('Bob');
        expect(m.recoveryCodeReminderDue('alice')).toBe(false);
        expect(m.recoveryCodeReminderDue(null)).toBe(false);
        expect(m.recoveryCodeReminderDue('BOB')).toBe(true);
        expect(m.recoveryCodeReminderDue(' bob ')).toBe(true);
    });

    it('another account\'s answer leaves it alone, and each account answers for its own', async () => {
        const m = await import('../api/recoveryPrompt');
        m.markRecoveryCodeUnacknowledged('bob');
        m.acknowledgeRecoveryCode('alice');
        expect(m.recoveryCodeReminderDue('bob')).toBe(true);
        m.markRecoveryCodeUnacknowledged('alice');
        expect(m.recoveryCodeReminderDue('alice')).toBe(true);
        m.acknowledgeRecoveryCode('Alice');
        expect(m.recoveryCodeReminderDue('alice')).toBe(false);
        expect(m.recoveryCodeReminderDue('bob')).toBe(true);
        vi.resetModules();
        const b = await import('../api/recoveryPrompt');
        expect(b.recoveryCodeReminderDue('bob'), 'still owed after a reload').toBe(true);
        expect(b.recoveryCodeReminderDue('alice')).toBe(false);
    });

    it('"Later" is the account\'s own', async () => {
        const m = await import('../api/recoveryPrompt');
        m.markRecoveryCodeUnacknowledged('alice');
        m.markRecoveryCodeUnacknowledged('bob');
        m.snoozeRecoveryCodeReminder('alice');
        expect(m.recoveryCodeReminderDue('alice')).toBe(false);
        expect(m.recoveryCodeReminderDue('bob')).toBe(true);
        // A new code for Alice re-arms only hers.
        m.snoozeRecoveryCodeReminder('bob');
        m.showRecoveryCode('one two three four five six seven eight nine ten eleven twelve', 'alice');
        expect(m.recoveryCodeReminderDue('alice')).toBe(true);
        expect(m.recoveryCodeReminderDue('bob')).toBe(false);
    });

    it('a marker left by a version before markers had owners goes to the first account asked about, once', async () => {
        store['recovery_code_unacked_v1'] = '1';
        const m = await import('../api/recoveryPrompt');
        expect(m.recoveryCodeReminderDue(null), 'nobody signed in takes nothing').toBe(false);
        expect(m.recoveryCodeReminderDue('carol')).toBe(true);
        expect(store['recovery_code_unacked_v1'], 'taken over by its account').toBeUndefined();
        expect(m.recoveryCodeReminderDue('dave')).toBe(false);
        m.acknowledgeRecoveryCode('carol');
        expect(m.recoveryCodeReminderDue('carol')).toBe(false);
    });

    it('storage that cannot be read reminds nobody and throws nothing', async () => {
        const m = await import('../api/recoveryPrompt');
        store['recovery_code_unacked_v2'] = '{not json';
        expect(m.recoveryCodeReminderDue('bob')).toBe(false);
        m.markRecoveryCodeUnacknowledged('bob');
        expect(m.recoveryCodeReminderDue('bob')).toBe(true);
        vi.mocked(window.localStorage.getItem).mockImplementation(() => { throw new Error('blocked'); });
        expect(m.recoveryCodeReminderDue('bob')).toBe(false);
        expect(() => m.markRecoveryCodeUnacknowledged('bob')).not.toThrow();
        expect(() => m.acknowledgeRecoveryCode('bob')).not.toThrow();
    });
});
