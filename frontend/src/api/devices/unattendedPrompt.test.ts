import { describe, it, expect, beforeEach } from 'vitest';
import {
    requestUnattendedPassphrase,
    resetUnattendedPassphraseHandler,
    setUnattendedPassphraseHandler,
} from './unattendedPrompt';

describe('unattended passphrase prompt bridge', () => {
    beforeEach(() => resetUnattendedPassphraseHandler());

    it('resolves NULL when no UI is mounted rather than hanging', () => {
        // The failure that matters: a headless host (autostart, tray-only, or a
        // service-launched agent) has no dialog to show. If the request hung, the
        // session would sit half-open forever waiting on something that can never
        // appear. Refusing is the only safe answer.
        return expect(requestUnattendedPassphrase('dev-1')).resolves.toBeNull();
    });

    it('hands the request to the mounted UI and resolves with its answer', async () => {
        setUnattendedPassphraseHandler(req => {
            expect(req.peerDevice).toBe('dev-1');
            req.resolve('the passphrase');
        });
        await expect(requestUnattendedPassphrase('dev-1')).resolves.toBe('the passphrase');
    });

    it('treats a refusal as null, not as an empty passphrase', async () => {
        // An empty string would be SENT and signed, producing a wrong-passphrase
        // rejection; null means "the user declined" and the caller ends the
        // session cleanly. The distinction changes what the user is told.
        setUnattendedPassphraseHandler(req => req.resolve(null));
        await expect(requestUnattendedPassphrase('dev-1')).resolves.toBeNull();
    });

    it('ignores a second resolve, so a double-click cannot answer twice', async () => {
        // HONEST SCOPE: this passes because a promise's resolve is already
        // idempotent, not because of anything this module does — an explicit
        // guard here was removed after a mutation proved it dead. The test
        // stays because it pins the CONTRACT callers depend on: if this ever
        // stops being promise-backed, this goes red.

        setUnattendedPassphraseHandler(req => {
            req.resolve('first');
            req.resolve('second');
        });
        await expect(requestUnattendedPassphrase('dev-1')).resolves.toBe('first');
    });

    it('lets the last registration win, so a remount replaces rather than stacks', async () => {
        setUnattendedPassphraseHandler(req => req.resolve('old'));
        setUnattendedPassphraseHandler(req => req.resolve('new'));
        await expect(requestUnattendedPassphrase('dev-1')).resolves.toBe('new');
    });

    it('unregistering restores the refuse-by-default behaviour', async () => {
        const off = setUnattendedPassphraseHandler(req => req.resolve('x'));
        off();
        await expect(requestUnattendedPassphrase('dev-1')).resolves.toBeNull();
    });

    it('unregistering a STALE handler does not disable the current one', async () => {
        // Mount A, mount B, then A unmounts. A's cleanup must not silently
        // remove B — that would leave the app unable to prompt at all, which
        // fails closed but looks like "unattended access is broken".
        const offA = setUnattendedPassphraseHandler(req => req.resolve('a'));
        setUnattendedPassphraseHandler(req => req.resolve('b'));
        offA();
        await expect(requestUnattendedPassphrase('dev-1')).resolves.toBe('b');
    });
});
