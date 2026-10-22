/**
 * The role editor's Automated Streaming section (StreamOnlyRoleSection.tsx,
 * docs/STREAM_ONLY.md). "Opened for this role" is an ordinary channel
 * overwrite that allows Connect - the server's rule (permissions.rs
 * stream_only_layer) - so the section must write exactly that, keep any other
 * bits the role's overwrite already carries, and delete only an overwrite it
 * would leave empty. It is not offered for @everyone or the Owner role, and
 * only the owner or an administrator can change it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PERMISSIONS } from '../api/permissionBits';

const listChannels = vi.fn();
const getChannelOverwrites = vi.fn();
const putChannelOverwrite = vi.fn(async () => {});
const deleteChannelOverwrite = vi.fn(async () => {});
vi.mock('../api/servers', () => ({ listChannels: (...a: unknown[]) => listChannels(...a) }));
vi.mock('../api/channels', () => ({
    getChannelOverwrites: (...a: unknown[]) => getChannelOverwrites(...a),
    putChannelOverwrite: (...a: unknown[]) => putChannelOverwrite(...(a as [])),
    deleteChannelOverwrite: (...a: unknown[]) => deleteChannelOverwrite(...(a as [])),
}));

const { StreamOnlyRoleSection } = await import('../components/StreamOnlyRoleSection');
const { nextOverwrite, isOpenedFor, STREAM_ONLY_OPEN_BITS } = await import('../components/streamOnlyOverwrite');

const OPEN = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CONNECT | PERMISSIONS.STREAM;

describe('the overwrite it writes', () => {
    it('opens with View, Connect and Stream, keeping what else the role overwrite carries', () => {
        expect(STREAM_ONLY_OPEN_BITS).toBe(OPEN);
        expect(nextOverwrite(undefined, true)).toEqual({ allow: OPEN, deny: 0 });
        expect(nextOverwrite({ allow: PERMISSIONS.SPEAK, deny: PERMISSIONS.CONNECT | PERMISSIONS.VIDEO }, true))
            .toEqual({ allow: PERMISSIONS.SPEAK | OPEN, deny: PERMISSIONS.VIDEO });
    });
    it('closes by removing exactly those bits, deleting an overwrite that would be empty', () => {
        expect(nextOverwrite({ allow: OPEN, deny: 0 }, false)).toBeNull();
        expect(nextOverwrite({ allow: OPEN | PERMISSIONS.SPEAK, deny: PERMISSIONS.VIDEO }, false))
            .toEqual({ allow: PERMISSIONS.SPEAK, deny: PERMISSIONS.VIDEO });
    });
    it("reads 'opened' the way the server does: an allow of Connect", () => {
        expect(isOpenedFor(PERMISSIONS.CONNECT)).toBe(true);
        expect(isOpenedFor(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.STREAM)).toBe(false);
        expect(isOpenedFor(undefined)).toBe(false);
    });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
beforeEach(() => {
    listChannels.mockResolvedValue([
        { id: 10, name: 'general', channel_type: 0, server_id: 's' },
        { id: 11, name: 'stage', channel_type: 1, server_id: 's' },
        { id: 12, name: 'lounge', channel_type: 1, server_id: 's' },
    ]);
    getChannelOverwrites.mockImplementation(async (cid: number) => (cid === 11 ? [{ role_id: 5, allow: OPEN, deny: 0 }] : []));
    putChannelOverwrite.mockClear();
    deleteChannelOverwrite.mockClear();
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function mount(role: { id: number; is_default: boolean; name: string; permissions: number }, canRestrict: boolean) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const full = { ...role, server_id: 's', color: '#99AAB5', position: 1 };
    await act(async () => {
        root!.render(
            <StreamOnlyRoleSection serverId="s" role={full} editPermissions={role.permissions} onToggle={() => {}} canRestrict={canRestrict} />,
        );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return container;
}

const streamOnlyRole = { id: 5, is_default: false, name: 'Stream only', permissions: PERMISSIONS.STREAM | PERMISSIONS.STREAM_ONLY };

describe('rendered', () => {
    it('lists the VOICE channels, ticks the opened one, and writes the overwrite on a tick', async () => {
        const c = await mount(streamOnlyRole, true);
        const boxes = [...c.querySelectorAll<HTMLInputElement>('[data-testid="role-stream-channel"]')];
        expect(boxes.map(b => b.dataset.channelId)).toEqual(['11', '12']); // not the text channel
        expect(boxes.map(b => b.checked)).toEqual([true, false]);
        await act(async () => { boxes[1].click(); });
        expect(putChannelOverwrite).toHaveBeenCalledWith(12, 5, OPEN, 0);
        await act(async () => { boxes[0].click(); });
        expect(deleteChannelOverwrite).toHaveBeenCalledWith(11, 5);
    });

    it('is locked for an editor who is not the owner or an administrator', async () => {
        const c = await mount(streamOnlyRole, false);
        expect(c.querySelector<HTMLInputElement>('[data-testid="role-stream-only"]')!.disabled).toBe(true);
        expect(c.querySelector('[data-testid="role-stream-channel"]'), 'no channel list for them').toBeNull();
        // NEGATIVE CONTROL: the owner may change it.
        await act(async () => root!.unmount());
        container!.remove();
        const o = await mount(streamOnlyRole, true);
        expect(o.querySelector<HTMLInputElement>('[data-testid="role-stream-only"]')!.disabled).toBe(false);
    });

    it('is not offered for @everyone (the server refuses the bits there)', async () => {
        const c = await mount({ id: 1, is_default: true, name: '@everyone', permissions: 0 }, true);
        expect(c.querySelector('[data-testid="role-automated-streaming"]')).toBeNull();
    });
});
