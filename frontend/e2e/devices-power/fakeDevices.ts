/**
 * The device list the harness shows: the real api/devices module, with the
 * list and the signed-in account played here. Every row is VERIFIED (a real
 * list verifies each row against the account's signing key; there is no
 * account here), so the cards offer what they would for the owner.
 *
 * `window.__devicesGoOffline` lists ids the NEXT reads report offline — a PC
 * that went away between the card being painted and the press.
 */
export * from '../../src/api/devices/index';
import type { VerifiedDevice } from '../../src/api/devices/index';

const row = (id: string, name: string, over: Partial<VerifiedDevice> = {}): VerifiedDevice => ({
    id, name,
    device_pub: 'x25519:AAA', sign_pub: 'ed25519:BBB',
    platform: 'windows', auth_record: '{}', auth_sig: 's',
    host_enabled: true, host_policy: null, host_sig: null, lan_info: null,
    created_at: '2026-10-01T00:00:00Z', last_seen_at: '2026-10-27T06:57:18Z',
    online: true, verified: true, isThisDevice: false,
    ...over,
} as VerifiedDevice);

/** By id: how each stand-in PC answers is in fakeSession.ts's SCRIPTS. */
const ROWS: VerifiedDevice[] = [
    row('pc-going', 'Slim-Jim'),
    row('pc-old', 'Old Laptop'),
    row('pc-refused', 'Desk PC'),
    row('pc-declined', 'Garage PC'),
    row('pc-attended', 'Living Room PC'),
    row('pc-gone', 'Media PC'),
    // Not offered: offline, a phone, a Linux box.
    row('pc-off', 'Spare PC', { online: false }),
    row('phone-1', 'Pixel', { platform: 'android' }),
    row('linux-1', 'Server', { platform: 'linux' }),
];

export function currentUserId(): number | null {
    return 42;
}

export async function listDevices(): Promise<VerifiedDevice[]> {
    const gone = new Set((window as unknown as { __devicesGoOffline?: string[] }).__devicesGoOffline ?? []);
    return ROWS.map(r => ({ ...r, online: r.online && !gone.has(r.id) }));
}
