/** Friends' PCs on the harness page: the real shares module, with the list
 *  of accepted shares played here. */
export * from '../../src/api/devices/shares';
import type { IncomingShare } from '../../src/api/devices/shares';

const share = (id: number, host: string, name: string, caps: IncomingShare['capabilities']): IncomingShare => ({
    id, host_device: host, host_device_name: name, host_platform: 'windows',
    owner_user: 9, owner_username: 'Friend', capabilities: caps,
    status: 'accepted', ready: true, online: true, created_at: '2026-10-01T00:00:00Z',
});

export async function listIncomingShares(): Promise<IncomingShare[]> {
    return [
        share(1, 'their-box', 'Box', ['control', 'files']),
        // Control on the share, but the PC says no (it disagrees with the
        // server's copy): the card must say so, not fail quietly.
        share(2, 'attic', 'Attic PC', ['control']),
        // View-only: not offered at all.
        share(3, 'den', 'Den PC', ['view_only']),
    ];
}
