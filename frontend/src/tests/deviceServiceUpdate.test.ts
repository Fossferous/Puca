/**
 * The service-needs-update decision.
 *
 * THE SKEW THIS GUARDS: the app auto-updates and the Windows service does not
 * — nothing but enrolment day ever touched it. The running service still
 * answers the control pipe, just without whatever fields the newer app has
 * grown to rely on, which is exactly how 0.8.82's one-card-per-PC merge
 * silently never engaged (the old service never sent `device_id`, so the
 * sign-in row never got its MAC and nothing anywhere said why).
 *
 * The decision is a pure function so this file can pin every branch without a
 * pipe, a service, or elevation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serviceNeedsUpdate } from '../api/devices/lockScreen';

describe('serviceNeedsUpdate', () => {
    it('flags a service too old to even report a fingerprint', () => {
        // An old service omits the field entirely — which is itself the
        // strongest possible evidence it is out of date. This is the exact
        // field case: 0.8.81 service under a 0.8.83 app.
        expect(serviceNeedsUpdate(null, 'abc123')).toBe(true);
    });

    it('flags a fingerprint that differs from the bundled pair', () => {
        expect(serviceNeedsUpdate('old-pair', 'new-pair')).toBe(true);
    });

    it('is quiet when the installed pair IS the bundled pair', () => {
        // The negative control: without it the two tests above would pass for
        // a function that always says "update", which would show a permanent
        // prompt that updates forever and never clears.
        expect(serviceNeedsUpdate('same', 'same')).toBe(false);
    });

    it('offers nothing when this build has no sidecar to offer', () => {
        // A dev build without the bundled binaries cannot update anyone;
        // prompting would dead-end at "component missing".
        expect(serviceNeedsUpdate(null, null)).toBe(false);
        expect(serviceNeedsUpdate('anything', null)).toBe(false);
    });
});

/**
 * `bundledServiceFingerprint` — the failure it must NOT hide.
 *
 * THE BUG THIS PINS. The Tauri command used to return a bare `Option<String>`,
 * collapsing "this build has no sidecars" (normal, silent) and "the sidecars
 * are there but could not be read or hashed" (a real problem on a shipped
 * build) into the same `null`. `serviceNeedsUpdate` treats a null bundled hash
 * as nothing to compare against, so the second case made the "Update the
 * service" card silently never appear — reported live, on a real install where
 * the service was demonstrably running and reachable. The fix is a distinct
 * `error` field that survives exactly the case a bare null erased.
 */
describe('bundledServiceFingerprint', () => {
    let invokeMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();
        invokeMock = vi.fn();
        vi.doMock('../api/platform', async importOriginal => ({
            ...(await importOriginal<typeof import('../api/platform')>()),
            isTauri: () => true,
        }));
        vi.doMock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
    });

    it('reports the hash with no error on success', async () => {
        invokeMock.mockResolvedValue('abc123');
        const { bundledServiceFingerprint } = await import('../api/devices/lockScreen');
        expect(await bundledServiceFingerprint()).toEqual({ hash: 'abc123', error: null });
    });

    it('reports no hash and no error for a dev build with no sidecars', async () => {
        // Ok(None) on the Rust side — the ordinary, silent case.
        invokeMock.mockResolvedValue(null);
        const { bundledServiceFingerprint } = await import('../api/devices/lockScreen');
        expect(await bundledServiceFingerprint()).toEqual({ hash: null, error: null });
    });

    it('carries the reason forward instead of erasing it into a bare null', async () => {
        // Err(reason) on the Rust side. THIS is the shape a bare Option<String>
        // could never distinguish from the dev-build case above — and it is
        // exactly the distinction that was missing when the card silently
        // never appeared on a real, working install.
        invokeMock.mockRejectedValue(new Error('cannot read puca-service.exe: access denied'));
        const { bundledServiceFingerprint } = await import('../api/devices/lockScreen');
        const result = await bundledServiceFingerprint();
        expect(result.hash).toBeNull();
        expect(result.error).toMatch(/access denied/);
    });
});
