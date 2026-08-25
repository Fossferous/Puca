/**
 * One-shot hand-off for a freshly-generated recovery code.
 *
 * register() and the v2→v3 login migration generate a recovery phrase that must
 * be shown to the user exactly once. They stash it here; the authed layout's
 * RecoveryCodeModal consumes and displays it. Deliberately NOT persisted — the
 * whole point is that the user writes it down, not that the device keeps it.
 */
let pending: string | null = null;

export function setPendingRecoveryCode(code: string): void {
    pending = code;
}

export function consumePendingRecoveryCode(): string | null {
    const c = pending;
    pending = null;
    return c;
}
