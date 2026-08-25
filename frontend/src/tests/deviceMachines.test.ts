/**
 * One PC, two device rows, ONE card.
 *
 * Turning on sign-in-screen access enrols a second device row for a machine
 * that already has one — deliberately, because the LocalSystem service may not
 * hold the app's keypair. The user saw two entries for one computer, and the
 * split was worse than cosmetic: only the app's row ever had a MAC, so the row
 * reachable at the sign-in screen could never be woken, while the row that
 * could be woken is offline exactly when you need it.
 *
 * These pin the fold: same MAC means same machine, `role` says which half is
 * which, and a row with no MAC is left alone rather than merged into a heap.
 */
import { describe, it, expect, vi } from 'vitest';

// `lan_info` carries plain JSON in these tests: open is the identity function.
vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
}));

import { groupIntoMachines, machineOf, ungrouped, SIGN_IN_ROW_NAME } from '../api/devices/machines';
import type { VerifiedDevice } from '../api/devices';

function dev(over: Partial<VerifiedDevice> & { id: string }): VerifiedDevice {
    return {
        device_pub: 'x25519:AAA',
        sign_pub: 'ed25519:BBB',
        name: over.id,
        platform: 'windows',
        auth_record: '{}',
        auth_sig: 's',
        host_enabled: false,
        host_policy: null,
        host_sig: null,
        lan_info: null,
        created_at: '2026-08-16T00:00:00Z',
        last_seen_at: null,
        online: false,
        verified: true,
        isThisDevice: false,
        ...over,
    } as VerifiedDevice;
}

function withLan(
    over: Partial<VerifiedDevice> & { id: string },
    lan: { mac: string; role?: 'app' | 'signin'; ip?: string; subnet?: string },
): VerifiedDevice {
    return dev({ ...over, lan_info: JSON.stringify(lan) });
}

const MAC = 'AA:BB:CC:DD:EE:FF';

describe('groupIntoMachines', () => {
    it('folds the app row and the sign-in row of one PC into a single machine', async () => {
        const app = withLan({ id: 'app1', name: 'Study PC' }, { mac: MAC, role: 'app' });
        const svc = withLan({ id: 'svc1', name: SIGN_IN_ROW_NAME }, { mac: MAC, role: 'signin' });

        const machines = await groupIntoMachines([app, svc]);

        expect(machines).toHaveLength(1);
        expect(machines[0].rows.map(r => r.id).sort()).toEqual(['app1', 'svc1']);
        // Named after the row the owner has actually seen and can rename.
        expect(machines[0].primary.id).toBe('app1');
        expect(machines[0].signInRow?.id).toBe('svc1');
        expect(machines[0].mac).toBe(MAC);
    });

    it('does NOT fold two different machines that both have LAN details', async () => {
        // The positive control for the test above: the rig can produce two
        // machines, so a single machine there is a real merge and not a
        // grouping that collapses everything it is given.
        const a = withLan({ id: 'a' }, { mac: MAC, role: 'app' });
        const b = withLan({ id: 'b' }, { mac: '11:22:33:44:55:66', role: 'app' });

        const machines = await groupIntoMachines([a, b]);
        expect(machines).toHaveLength(2);
    });

    it('never merges rows that merely lack a MAC', async () => {
        // Keying unknowns together would collapse every phone on the account
        // into one card. Each stands alone.
        const phone = dev({ id: 'phone', platform: 'android' });
        const tablet = dev({ id: 'tablet', platform: 'android' });
        const mac = dev({ id: 'mini', platform: 'macos' });

        const machines = await groupIntoMachines([phone, tablet, mac]);
        expect(machines).toHaveLength(3);
        expect(machines.every(m => m.mac === null)).toBe(true);
        expect(machines.every(m => m.signInRow === null)).toBe(true);
    });

    it('matches on the MAC case-insensitively', async () => {
        // The Rust collector emits uppercase, but nothing forces a blob written
        // by some other path to. A case difference must not un-merge a machine.
        const app = withLan({ id: 'app1' }, { mac: MAC, role: 'app' });
        const svc = withLan(
            { id: 'svc1', name: SIGN_IN_ROW_NAME },
            { mac: MAC.toLowerCase(), role: 'signin' },
        );
        expect(await groupIntoMachines([app, svc])).toHaveLength(1);
    });

    it('identifies the sign-in row by role, so a rename cannot un-merge the card', async () => {
        // The whole reason `role` exists. Renaming the sign-in row in the
        // Devices UI used to be enough to make it look like a separate PC.
        const app = withLan({ id: 'app1', name: 'Study PC' }, { mac: MAC, role: 'app' });
        const svc = withLan({ id: 'svc1', name: 'Renamed by the owner' }, { mac: MAC, role: 'signin' });

        const [machine] = await groupIntoMachines([app, svc]);
        expect(machine.signInRow?.id).toBe('svc1');
        expect(machine.primary.id).toBe('app1');
    });

    it('falls back to the known name for rows enrolled before role existed', async () => {
        const app = withLan({ id: 'app1', name: 'Study PC' }, { mac: MAC });
        const svc = withLan({ id: 'svc1', name: SIGN_IN_ROW_NAME }, { mac: MAC });

        const [machine] = await groupIntoMachines([app, svc]);
        expect(machine.signInRow?.id).toBe('svc1');
        expect(machine.primary.id).toBe('app1');
    });

    it('is online when EITHER row is, and routes to the one that is up', async () => {
        // The locked machine: the app is gone, the service is holding the door.
        const app = withLan({ id: 'app1', name: 'Study PC', online: false }, { mac: MAC, role: 'app' });
        const svc = withLan(
            { id: 'svc1', name: SIGN_IN_ROW_NAME, online: true },
            { mac: MAC, role: 'signin' },
        );

        const [machine] = await groupIntoMachines([app, svc]);
        expect(machine.online).toBe(true);
        expect(machine.onlineRow?.id).toBe('svc1');
        expect(machine.atSignInScreen).toBe(true);
    });

    it('prefers the SIGN-IN row when both are up, because that means locked', async () => {
        // THE INVERTED PREFERENCE, and why. The service runs its agent only
        // while the console is locked or signed out, and stops it the moment
        // somebody signs in — so both rows being online means the machine is
        // LOCKED with the app still running. The app is an ordinary
        // user-session process and cannot capture a lock screen, so the old
        // "prefer the app row" landed the user on a session with no picture
        // and only reached the sign-in screen after they watched it fail.
        const app = withLan({ id: 'app1', online: true }, { mac: MAC, role: 'app' });
        const svc = withLan(
            { id: 'svc1', name: SIGN_IN_ROW_NAME, online: true },
            { mac: MAC, role: 'signin' },
        );

        const [machine] = await groupIntoMachines([app, svc]);
        expect(machine.onlineRow?.id).toBe('svc1');
        expect(machine.atSignInScreen).toBe(true);
    });

    it('falls through to the app row once the sign-in row goes away', async () => {
        // The unlock case, and the reason no extra condition is needed: the
        // service stops itself when the console is unlocked, so the sign-in
        // row simply stops being online and this resolves to the desktop.
        const app = withLan({ id: 'app1', online: true }, { mac: MAC, role: 'app' });
        const svc = withLan(
            { id: 'svc1', name: SIGN_IN_ROW_NAME, online: false },
            { mac: MAC, role: 'signin' },
        );

        const [machine] = await groupIntoMachines([app, svc]);
        expect(machine.onlineRow?.id).toBe('app1');
        expect(machine.atSignInScreen).toBe(false);
    });

    it('reports a fully powered-off machine as offline with no row to connect to', async () => {
        const app = withLan({ id: 'app1', online: false }, { mac: MAC, role: 'app' });
        const svc = withLan(
            { id: 'svc1', name: SIGN_IN_ROW_NAME, online: false },
            { mac: MAC, role: 'signin' },
        );

        const [machine] = await groupIntoMachines([app, svc]);
        expect(machine.online).toBe(false);
        expect(machine.onlineRow).toBeNull();
        expect(machine.atSignInScreen).toBe(false);
        // Still wakeable: the MAC survived the merge, which is the half that
        // was missing on the sign-in row entirely.
        expect(machine.mac).toBe(MAC);
    });

    it('keeps a sign-in row that has no app row visible on its own', async () => {
        // Enrolled sign-in access but the app has not attested since. The
        // machine must not vanish from the list.
        const svc = withLan({ id: 'svc1', name: SIGN_IN_ROW_NAME }, { mac: MAC, role: 'signin' });
        const [machine] = await groupIntoMachines([svc]);
        expect(machine.primary.id).toBe('svc1');
        expect(machine.signInRow?.id).toBe('svc1');
    });

    it('preserves input order so the list does not reshuffle', async () => {
        const a = withLan({ id: 'a' }, { mac: '01:00:00:00:00:01', role: 'app' });
        const b = withLan({ id: 'b' }, { mac: '01:00:00:00:00:02', role: 'app' });
        const c = dev({ id: 'c', platform: 'android' });
        expect((await groupIntoMachines([a, b, c])).map(m => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('has a synchronous ungrouped view so the grid is never blank while it folds', () => {
        // The fold decrypts and is async; between the list landing and the
        // fold resolving the Devices view used to render ZERO cards — no
        // spinner, no empty state — on every entry. This is what paints in
        // that gap. It must be one card per row and shaped like the fold's
        // output, so nothing flickers between two layouts.
        const app = withLan({ id: 'app1', online: true }, { mac: MAC, role: 'app' });
        const svc = withLan({ id: 'svc1', name: SIGN_IN_ROW_NAME }, { mac: MAC, role: 'signin' });
        const phone = dev({ id: 'phone', platform: 'android' });

        const interim = ungrouped([app, svc, phone]);
        expect(interim).toHaveLength(3); // NOT merged — that is the fold's job
        expect(interim.map(m => m.id)).toEqual(['app1', 'svc1', 'phone']);
        expect(interim[0].online).toBe(true);
        expect(interim[0].onlineRow?.id).toBe('app1');
        expect(interim[1].onlineRow).toBeNull();
        expect(interim.every(m => m.mac === null && m.signInRow === null)).toBe(true);
    });

    it('finds the machine a given row belongs to', async () => {
        const app = withLan({ id: 'app1' }, { mac: MAC, role: 'app' });
        const svc = withLan({ id: 'svc1', name: SIGN_IN_ROW_NAME }, { mac: MAC, role: 'signin' });
        const machines = await groupIntoMachines([app, svc]);

        // Either row resolves to the SAME machine — that is what lets a wake
        // pressed on one half connect through the other.
        expect(machineOf(machines, 'svc1')?.id).toBe('app1');
        expect(machineOf(machines, 'app1')?.id).toBe('app1');
        expect(machineOf(machines, 'nope')).toBeNull();
    });
});

describe('the unlock handover contract', () => {
    it('uses the same literal the service sends', async () => {
        // ONE WIRE CONTRACT, TWO COMPILED HALVES. The Rust half is
        // HANDOVER_REASON in crates/puca-service/src/link.rs, and that
        // crate's own test scans this project for the string. This is the
        // other direction: if someone edits the constant here, the Rust test
        // goes red rather than the freeze silently coming back.
        const { HANDOVER_REASON } = await import('../api/devices/session');
        expect(HANDOVER_REASON).toBe('console-unlocked-handover');
    });
});
