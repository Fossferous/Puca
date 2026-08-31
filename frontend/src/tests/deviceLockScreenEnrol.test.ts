/**
 * Enrolling sign-in-screen access — one row per machine, ever.
 *
 * THE PROLIFERATION THIS PINS. Every enrolment mints a fresh keypair (the
 * service deliberately never reuses one), and the device id is derived from
 * the keys — so each re-enrol creates a NEW server row and the old one's
 * private key is destroyed in the same breath. Nothing revoked the
 * predecessor, so they accumulated: a real machine collected THREE dead
 * "This PC (sign-in screen)" cards before the pattern was understood. And the
 * fresh row's lan_info waited for the next socket attestation — days away on
 * a desktop that stays up — so it sat un-wakeable and un-grouped too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
let pipeState: Record<string, unknown> = {};
let failFinish = false;

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => true,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'lock_screen_state') return Promise.resolve(pipeState);
        if (cmd === 'lock_screen_begin_enrol') {
            return Promise.resolve({
                device_id: 'new-id',
                device_pub: 'x25519:NEW',
                sign_pub: 'ed25519:NEW',
            });
        }
        if (cmd === 'lock_screen_finish_enrol') {
            return failFinish ? Promise.reject(new Error('pipe broke')) : Promise.resolve();
        }
        if (cmd === 'lock_screen_unenrol') return Promise.resolve();
        return Promise.resolve(null);
    },
}));

vi.mock('../api/client', () => ({
    apiClient: { post: (..._a: unknown[]) => { calls.push('POST /devices'); return Promise.resolve({}); } },
}));

vi.mock('../api/auth', () => ({
    getToken: () => 'x.y.z',
    decodeJwtPayload: () => ({ sub: 1 }),
}));

vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    deriveAccountSigningKey: () => ({ publicKeyEncoded: 'ed25519:ACCT' }),
}));

vi.mock('../api/deviceIdentity/identity', () => ({
    buildAuthRecord: () => ({ canonical: '{}', deviceId: 'new-id' }),
    signAuthRecord: () => 'sig',
}));

const revoked: string[] = [];
vi.mock('../api/devices/index', () => ({
    revokeDevice: (id: string) => { revoked.push(id); calls.push(`revoke:${id}`); return Promise.resolve(); },
}));

let published = 0;
vi.mock('../api/devices/lanInfo', () => ({
    publishNow: () => { published += 1; calls.push('publishNow'); return Promise.resolve(); },
}));

import { enrolLockScreenAccess, unenrolLockScreenAccess } from '../api/devices/lockScreen';

beforeEach(() => {
    calls.length = 0;
    revoked.length = 0;
    published = 0;
    failFinish = false;
    // The machine is already enrolled as 'old-id' — the re-enrol case.
    pipeState = {
        service_installed: true, enrolled: true, armed: true,
        device_id: 'old-id', bins_hash: 'h',
    };
});

describe('enrolLockScreenAccess', () => {
    it('retires the predecessor row, and only AFTER the new enrolment landed', async () => {
        expect(await enrolLockScreenAccess()).toBeNull();
        expect(revoked).toEqual(['old-id']);
        // Order: the revoke must come after finish — revoking first would
        // leave the machine unreachable if any later step failed.
        expect(calls.indexOf('revoke:old-id')).toBeGreaterThan(calls.indexOf('lock_screen_finish_enrol'));
    });

    it('publishes the fresh row\'s LAN details immediately', async () => {
        // Without this the row waits for the NEXT socket attestation — days
        // away on a desktop that stays up — sitting un-wakeable the whole
        // time while its own error text tells the user to open Puca on a
        // machine where Puca is already open.
        expect(await enrolLockScreenAccess()).toBeNull();
        expect(published).toBe(1);
    });

    it('revokes nothing when the machine was not already enrolled', async () => {
        // The positive control's sibling: a first enrolment has no
        // predecessor, and revoking whatever id happened to be lying around
        // would be data loss.
        pipeState = {
            service_installed: true, enrolled: false, armed: false,
            device_id: null, bins_hash: 'h',
        };
        expect(await enrolLockScreenAccess()).toBeNull();
        expect(revoked).toEqual([]);
    });

    it('keeps the predecessor when the new enrolment fails', async () => {
        // A failed re-enrol must not ALSO destroy the old row's card: the old
        // key is already gone, but the visible record of "this machine was
        // reachable" should not vanish on a failure path.
        failFinish = true;
        expect(await enrolLockScreenAccess()).not.toBeNull();
        expect(revoked).toEqual([]);
        expect(published).toBe(0);
    });
});

describe('unenrolLockScreenAccess', () => {
    it('retires the row it just forgot', async () => {
        // "Off" used to leave a permanently-offline card behind — the machine
        // forgot its keys but the server kept the row.
        expect(await unenrolLockScreenAccess()).toBeNull();
        expect(revoked).toEqual(['old-id']);
    });

    it('revokes nothing when nothing was enrolled', async () => {
        pipeState = {
            service_installed: true, enrolled: false, armed: false,
            device_id: null, bins_hash: 'h',
        };
        expect(await unenrolLockScreenAccess()).toBeNull();
        expect(revoked).toEqual([]);
    });
});
