/**
 * Publishing this machine's LAN details — to BOTH of its device rows.
 *
 * THE BUG THIS PINS. `installLanPublisher` PATCHed `thisDeviceId()` and nothing
 * else, so a PC with sign-in-screen access enrolled had a MAC on the row that
 * is offline while it is locked, and NO MAC at all on the row that is the only
 * way in at the sign-in screen. Wake was therefore refused on the very row the
 * user needs, with advice ("open Púca on that device once") that publishes
 * to the other row and can never help.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const patched: Array<{ id: string; blob: string }> = [];
let collected: Record<string, unknown> | null = null;
let companion: { enrolled: boolean; deviceId: string | null } = {
    enrolled: false,
    deviceId: null,
};
let failOn: string | null = null;

// PARTIAL: config.ts reads getApiBaseUrl/getWebSocketUrl from this module at
// import time, so replacing it wholesale breaks the module graph, not the test.
vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => true,
}));

vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    // Seal is the identity function, so the test can read the role back out.
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
}));

vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'app-row',
}));
vi.mock('../api/devices/index', () => ({
    updateDeviceLanInfo: (id: string, blob: string) => {
        if (failOn === id) return Promise.reject(new Error('patch refused'));
        patched.push({ id, blob });
        return Promise.resolve({});
    },
}));

vi.mock('../api/devices/lockScreen', () => ({
    unattendedAccessState: () => Promise.resolve(companion),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string) => (cmd === 'lan_info' ? Promise.resolve(collected) : Promise.resolve(null)),
}));

import { installLanPublisher, __resetLanPublisherForTests } from '../api/devices/lanInfo';

const LAN = {
    v: 1,
    mac: 'AA:BB:CC:DD:EE:FF',
    ip: '192.168.0.77',
    subnet: '192.168.0',
    broadcast: '192.168.0.255',
    wired: true,
    iface: 'Ethernet',
};

/** Fire the event the publisher hooks, and let its async work settle.
 *
 *  Real task turns, not just microtasks: `collectLanInfo` does a dynamic
 *  `import('@tauri-apps/api/core')`, and a module load does not resolve inside
 *  a drained microtask queue. */
async function attest(): Promise<void> {
    window.dispatchEvent(new Event('deviceAttested'));
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
}

// INSTALLED ONCE for the whole file. `__resetLanPublisherForTests` clears the
// `installed` flag but cannot detach the window listener it added, so calling
// install per test stacks listeners and every later `attest()` publishes once
// per test that ran before it.
installLanPublisher();

beforeEach(() => {
    patched.length = 0;
    collected = { ...LAN };
    companion = { enrolled: false, deviceId: null };
    failOn = null;
    // Clears the remembered fingerprint so each test starts unpublished.
    __resetLanPublisherForTests();
});

describe('installLanPublisher', () => {
    it('publishes to BOTH rows when sign-in-screen access is enrolled', async () => {
        companion = { enrolled: true, deviceId: 'signin-row' };
        await attest();

        expect(patched.map(p => p.id)).toEqual(['app-row', 'signin-row']);
        // Same machine, same adapter — the shared MAC is what lets the UI
        // recognise the two rows as one card.
        for (const p of patched) {
            expect(JSON.parse(p.blob).mac).toBe(LAN.mac);
        }
    });

    it('tags each row with which half of the machine it is', async () => {
        // Without this the merge would have to key on the device NAME, which is
        // renameable from the Devices UI.
        companion = { enrolled: true, deviceId: 'signin-row' };
        await attest();

        const roles = Object.fromEntries(patched.map(p => [p.id, JSON.parse(p.blob).role]));
        expect(roles).toEqual({ 'app-row': 'app', 'signin-row': 'signin' });
    });

    it('publishes only its own row when nothing is enrolled', async () => {
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row']);
    });

    it('does not publish twice for an unchanged network', async () => {
        companion = { enrolled: true, deviceId: 'signin-row' };
        await attest();
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row', 'signin-row']);
    });

    it('publishes the newly-enrolled companion even though the network never changed', async () => {
        // THE GUARD THAT WOULD HAVE SWALLOWED THE FIX. The fingerprint used to
        // key on the device id and the hardware only, so enrolling sign-in
        // access on a machine that never moves would never republish — and the
        // new row would sit without a MAC for ever.
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row']);

        companion = { enrolled: true, deviceId: 'signin-row' };
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row', 'app-row', 'signin-row']);
    });

    it('retries the whole publish when the companion PATCH fails', async () => {
        // A half-done publish must not be remembered as finished, or the row
        // stays un-wakeable until something else changes.
        companion = { enrolled: true, deviceId: 'signin-row' };
        failOn = 'signin-row';
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row']);

        failOn = null;
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row', 'app-row', 'signin-row']);
    });

    it('ignores a companion id identical to this row', async () => {
        // Defensive: PATCHing the same row twice is harmless but pointless, and
        // it would make the "both rows" assertion above meaningless.
        companion = { enrolled: true, deviceId: 'app-row' };
        await attest();
        expect(patched.map(p => p.id)).toEqual(['app-row']);
    });

    it('publishes nothing when the adapter cannot be read', async () => {
        collected = null;
        companion = { enrolled: true, deviceId: 'signin-row' };
        await attest();
        expect(patched).toEqual([]);
    });
});
