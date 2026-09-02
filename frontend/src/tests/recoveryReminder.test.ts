/**
 * The recovery code is deliberately never persisted — so what survives a
 * reload is only whether the user ever CONFIRMED saving one. Documents the
 * loss (positive control: a module reload drops the phrase) and the marker
 * that now points the user at Settings instead of saying nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function backingStore() {
    const store: Record<string, string> = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    return store;
}

beforeEach(() => { backingStore(); sessionStorage.clear(); vi.resetModules(); });

describe('the recovery phrase hand-off', () => {
    it('POSITIVE CONTROL: the phrase does not survive a module reload', async () => {
        const a = await import('../api/recoveryPrompt');
        a.setPendingRecoveryCode('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu');
        vi.resetModules();
        const b = await import('../api/recoveryPrompt');
        expect(b.consumePendingRecoveryCode()).toBeNull();
    });

    it('the unacknowledged marker DOES survive, until the user confirms', async () => {
        const a = await import('../api/recoveryPrompt');
        a.markRecoveryCodeUnacknowledged();
        vi.resetModules();
        const b = await import('../api/recoveryPrompt');
        expect(b.recoveryCodeReminderDue()).toBe(true);
        b.acknowledgeRecoveryCode();
        expect(b.recoveryCodeReminderDue()).toBe(false);
    });

    it('"Later" snoozes for the tab only; a new code re-arms it', async () => {
        const m = await import('../api/recoveryPrompt');
        m.markRecoveryCodeUnacknowledged();
        m.snoozeRecoveryCodeReminder();
        expect(m.recoveryCodeReminderDue()).toBe(false);
        sessionStorage.clear();                       // a fresh tab
        expect(m.recoveryCodeReminderDue()).toBe(true);
        m.snoozeRecoveryCodeReminder();
        m.showRecoveryCode('one two three four five six seven eight nine ten eleven twelve');
        expect(m.recoveryCodeReminderDue()).toBe(true);
        expect(m.consumePendingRecoveryCode()).toMatch(/^one two/);
    });
});
