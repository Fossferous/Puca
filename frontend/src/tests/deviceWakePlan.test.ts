/**
 * Waker SELECTION — which of your devices gets asked to broadcast.
 *
 * The existing deviceWakeClipboard suite cannot reach this logic: without an
 * unlocked identity every `lan_info` decrypts to null, so every device looks
 * like "no network details" and planWake returns before it ever ranks
 * anything. Mocking the seal/open pair is what makes the interesting half
 * testable, and that half had two real bugs in it.
 */
import { describe, it, expect, vi } from 'vitest';

// `lan_info` carries plain JSON in these tests: open is the identity function.
vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
}));

import { planWake, canSendWakePackets } from '../api/devices/wake';
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
        created_at: '2026-07-28T00:00:00Z',
        last_seen_at: null,
        online: true,
        verified: true,
        isThisDevice: false,
        ...over,
    } as VerifiedDevice;
}

/** A device carrying decryptable LAN details. */
function withLan(
    over: Partial<VerifiedDevice> & { id: string },
    lan: { mac: string; ip?: string; subnet?: string; broadcast?: string; wired?: boolean },
): VerifiedDevice {
    return dev({ ...over, lan_info: JSON.stringify(lan) });
}

const TARGET = () => withLan(
    { id: 'pc', name: 'Study PC', online: false },
    { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.0.10', subnet: '192.168.0', broadcast: '192.168.0.255' },
);

describe('who is allowed to send a wake packet', () => {
    it('accepts every desktop platform and refuses everything else', () => {
        // Sending needs a raw UDP socket, which only the desktop shell has.
        expect(canSendWakePackets('windows')).toBe(true);
        expect(canSendWakePackets('macos')).toBe(true);
        expect(canSendWakePackets('linux')).toBe(true);
        expect(canSendWakePackets('android')).toBe(false);
        expect(canSendWakePackets('ios')).toBe(false);
        expect(canSendWakePackets('web')).toBe(false);
    });

    it('never picks a phone, even when it is the only device online', async () => {
        // THE REGRESSION. The old test was `platform !== 'web'`, so an Android
        // phone was chosen, `requestWake` relayed to it, and the responder
        // silently bailed on `!isTauri()`. The user saw a wake that reported
        // success and woke nothing.
        const target = TARGET();
        const phone = withLan(
            { id: 'phone', name: 'Pixel', platform: 'android' },
            { mac: '11:22:33:44:55:66', ip: '192.168.0.5', subnet: '192.168.0' },
        );
        const plan = await planWake(target, [target, phone], 'phone');
        expect(plan.waker).toBeNull();
        // And it must say WHY, naming the real obstacle.
        expect(plan.reason).toMatch(/desktop app/i);
        expect(plan.reason).toContain('Study PC');
        // The MAC still resolved — the target is wakeable, just not from here.
        expect(plan.mac).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('never asks the dead machine\'s OWN second row to wake it', async () => {
        // ONE PC IS TWO DEVICE ROWS once sign-in-screen access is enrolled, and
        // only the id was compared — so the sign-in row of the very machine
        // being woken was a legal waker. The server's guard is an id compare
        // too, and the 75s idle reaper keeps a just-powered-off row looking
        // online long enough to be chosen: the relay then "succeeds" into an
        // orphaned channel and no packet is ever sent, with no error anywhere.
        const target = TARGET();
        const itsOwnSignInRow = withLan(
            // Still reported online: this is exactly the reaper window.
            { id: 'pc-signin', name: 'This PC (sign-in screen)', online: true },
            { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.0.10', subnet: '192.168.0' },
        );
        const plan = await planWake(target, [target, itsOwnSignInRow], null);
        expect(plan.waker).toBeNull();
        expect(plan.mac).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('DOES pick that same row when it is a genuinely different machine', async () => {
        // The positive control for the test above. Identical in every respect
        // except the MAC — so the exclusion is keyed on the machine and has not
        // silently become "never pick a sign-in row", which would take the
        // always-on half of every other PC out of the running.
        const target = TARGET();
        const otherPcSignInRow = withLan(
            { id: 'pc-signin', name: 'This PC (sign-in screen)', online: true },
            { mac: '99:88:77:66:55:44', ip: '192.168.0.11', subnet: '192.168.0' },
        );
        const plan = await planWake(target, [target, otherPcSignInRow], null);
        expect(plan.waker?.id).toBe('pc-signin');
    });

    it('matches the machine case-insensitively', async () => {
        const target = TARGET();
        const sameBox = withLan(
            { id: 'pc-signin', online: true },
            { mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.0.10', subnet: '192.168.0' },
        );
        expect((await planWake(target, [target, sameBox], null)).waker).toBeNull();
    });

    it('picks a desktop on the same subnet', async () => {
        const target = TARGET();
        const desktop = withLan(
            { id: 'laptop', name: 'Laptop' },
            { mac: '99:88:77:66:55:44', ip: '192.168.0.11', subnet: '192.168.0' },
        );
        const plan = await planWake(target, [target, desktop], null);
        expect(plan.waker?.id).toBe('laptop');
        expect(plan.mac).toBe('AA:BB:CC:DD:EE:FF');
        expect(plan.broadcast).toBe('192.168.0.255');
    });

    it('excludes a desktop that is known to be on a different network', async () => {
        // Broadcasting into the wrong LAN cannot work, and offering it would
        // burn the full three-minute wait before saying so.
        const target = TARGET();
        const elsewhere = withLan(
            { id: 'work', name: 'Work PC' },
            { mac: '00:00:00:00:00:01', ip: '10.20.30.40', subnet: '10.20.30' },
        );
        const plan = await planWake(target, [target, elsewhere], null);
        expect(plan.waker).toBeNull();
    });

    it('still tries a desktop whose own subnet is unknown', async () => {
        // LAN collection is Windows-only, so a Mac or Linux box on the same
        // switch has no recorded subnet. Excluding it would leave the only
        // machine that could help permanently unusable.
        const target = TARGET();
        const mac = dev({ id: 'mini', name: 'Mac mini', platform: 'macos', lan_info: null });
        const plan = await planWake(target, [target, mac], null);
        expect(plan.waker?.id).toBe('mini');
    });

    it('prefers a known-same-subnet device over one whose subnet is unknown', async () => {
        const target = TARGET();
        const unknown = dev({ id: 'mini', name: 'Mac mini', platform: 'macos', lan_info: null });
        const known = withLan(
            { id: 'laptop', name: 'Laptop' },
            { mac: '99:88:77:66:55:44', ip: '192.168.0.11', subnet: '192.168.0' },
        );
        // Listed unknown-first so a naive implementation that just takes the
        // first eligible device fails this.
        const plan = await planWake(target, [target, unknown, known], null);
        expect(plan.waker?.id).toBe('laptop');
    });

    it('ignores devices that are offline or unverified', async () => {
        const target = TARGET();
        const offline = withLan(
            { id: 'a', name: 'A', online: false },
            { mac: '1', ip: '192.168.0.12', subnet: '192.168.0' },
        );
        const unverified = withLan(
            { id: 'b', name: 'B', verified: false },
            { mac: '2', ip: '192.168.0.13', subnet: '192.168.0' },
        );
        const plan = await planWake(target, [target, offline, unverified], null);
        expect(plan.waker).toBeNull();
    });

    it('prefers another device over the one asking', async () => {
        const target = TARGET();
        const here = withLan({ id: 'here', name: 'Here' }, { mac: '3', ip: '192.168.0.14', subnet: '192.168.0' });
        const there = withLan({ id: 'there', name: 'There' }, { mac: '4', ip: '192.168.0.15', subnet: '192.168.0' });
        const plan = await planWake(target, [target, here, there], 'here');
        expect(plan.waker?.id).toBe('there');
    });

    it('uses this device when it is the only candidate', async () => {
        // Waking a SECOND machine from the one you are sitting at is a normal
        // thing to want; "prefer someone else" must not become "refuse".
        //
        // NOTE: this plan is only usable because `requestWake` sends the packet
        // LOCALLY when the waker is this device. The server refuses to relay a
        // device's wake request back to itself, so for most of this feature's
        // life this exact plan was produced, refused, and reported to the user
        // three minutes later as a suspected BIOS problem. A green test here
        // means nothing on its own — see the requestWake suite below.
        const target = TARGET();
        const here = withLan({ id: 'here', name: 'Here' }, { mac: '3', ip: '192.168.0.14', subnet: '192.168.0' });
        const plan = await planWake(target, [target, here], 'here');
        expect(plan.waker?.id).toBe('here');
    });

    it('does not reach past a same-subnet device for one whose subnet is unknown', async () => {
        // The prefer-someone-else rule must apply WITHIN the best rank, never
        // across it: trading a device known to be on the target's network for
        // one that merely might be is the opposite of what the ranking is for.
        const target = TARGET();
        const here = withLan({ id: 'here', name: 'Here' }, { mac: '3', ip: '192.168.0.14', subnet: '192.168.0' });
        const unknown = dev({ id: 'mini', name: 'Mac mini', platform: 'macos', lan_info: null });
        const plan = await planWake(target, [target, here, unknown], 'here');
        expect(plan.waker?.id).toBe('here');
    });

    it('says the network is wrong when the only computer is elsewhere', async () => {
        // Three different obstacles used to collapse into one message. Telling
        // someone to "leave a computer switched on" when theirs IS on, just on
        // another network, sends them to fix the wrong thing.
        const target = TARGET();
        const elsewhere = withLan(
            { id: 'work', name: 'Work PC' },
            { mac: '5', ip: '10.20.30.40', subnet: '10.20.30' },
        );
        const plan = await planWake(target, [target, elsewhere], null);
        expect(plan.waker).toBeNull();
        expect(plan.reason).toMatch(/different network/i);
        expect(plan.reason).not.toMatch(/phone|browser/i);
    });
});

describe('sending the wake request', () => {
    it('sends the packet locally when this device is the chosen waker', async () => {
        // THE REGRESSION that made the two-machine case (laptop wakes desktop)
        // fail end to end: the plan named this device, requestWake relayed it,
        // and the server refused a device's request to wake via itself. No
        // packet, no error, three minutes of waiting.
        const sent: unknown[] = [];
        // Spread the original: `platform` also exports the API/WS base-URL
        // helpers that config.ts calls at import time, so a bare replacement
        // breaks the whole module graph rather than this one function.
        vi.doMock('../api/platform', async (importOriginal) => ({
            ...(await importOriginal<typeof import('../api/platform')>()),
            isTauri: () => true,
        }));
        vi.doMock('@tauri-apps/api/core', () => ({
            invoke: (cmd: string, args: unknown) => { sent.push({ cmd, args }); return Promise.resolve(2); },
        }));
        vi.resetModules();
        const { requestWake: freshRequestWake } = await import('../api/devices/wake');

        const here = withLan({ id: 'here', name: 'Here' }, { mac: '3' });
        await freshRequestWake(
            { waker: here, mac: 'AA:BB:CC:DD:EE:FF', broadcast: '192.168.0.255' },
            'here',
        );
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            cmd: 'wol_send',
            args: { mac: 'AA:BB:CC:DD:EE:FF', broadcast: '192.168.0.255' },
        });
    });
});
