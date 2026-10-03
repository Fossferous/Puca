/**
 * Edit Channel › Permissions — the voice rows (Connect / Speak / Video /
 * Stream / Play Games).
 *
 * The backend has always accepted channel overwrites for these four bits, but
 * the editor offered no row for them, so a server owner could not deny Speak
 * in one voice channel without editing the role everywhere. What is pinned
 * here:
 *
 *  - A VOICE channel offers the four rows, and each saves ITS OWN bit — a
 *    label wired to the wrong bit would save a real, wrong overwrite.
 *  - Setting one touches only that bit: allow/deny bits the row does not own
 *    (other rows, other clients, future permissions) survive the save.
 *  - A TEXT (or collection) channel shows none of them: there they would be
 *    controls that change nothing. Its existing rows are unchanged.
 *  - POSITIVE CONTROL: an existing row (Create Clips) saves through the same
 *    path, so a broken harness cannot pass the voice cases vacuously.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are: @testing-library/react is not a dependency here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel, Role } from '../api/servers';
import type { ChannelOverwrite } from '../api/channels';
import { PERM } from '../api/permissionBits';

const listRoles = vi.fn(async (): Promise<Role[]> => roles);
const updateChannel = vi.fn(async () => {});
const getChannelOverwrites = vi.fn(async (): Promise<ChannelOverwrite[]> => existing);
const putChannelOverwrite = vi.fn(async () => {});
const deleteChannelOverwrite = vi.fn(async () => {});

// Keep every other export real; only the network-touching calls the modal
// makes are replaced.
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    listRoles: (...a: unknown[]) => listRoles(...(a as [])),
    updateChannel: (...a: unknown[]) => updateChannel(...(a as [])),
}));
vi.mock('../api/channels', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/channels')>()),
    getChannelOverwrites: (...a: unknown[]) => getChannelOverwrites(...(a as [])),
    putChannelOverwrite: (...a: unknown[]) => putChannelOverwrite(...(a as [])),
    deleteChannelOverwrite: (...a: unknown[]) => deleteChannelOverwrite(...(a as [])),
}));

const { EditChannelModal } = await import('../components/EditChannelModal');

const CHANNEL_ID = 42;
const EVERYONE: Role = { id: 1, server_id: 's1', name: '@everyone', color: '#99AAB5', permissions: 0, position: 0, is_default: true };
const MEMBER: Role = { id: 5, server_id: 's1', name: 'Member', color: '#3498DB', permissions: 0, position: 1, is_default: false };
const MUTED: Role = { id: 9, server_id: 's1', name: 'Muted', color: '#E74C3C', permissions: 0, position: 2, is_default: false };

let roles: Role[] = [];
let existing: ChannelOverwrite[] = [];

const VOICE_ROWS = ['Connect', 'Speak', 'Video', 'Stream', 'Play Games'] as const;

function chan(over: Partial<Channel> = {}): Channel {
    return {
        id: CHANNEL_ID,
        name: 'Lounge',
        channel_type: 1,
        server_id: 's1',
        my_permissions: PERM.MANAGE_CHANNELS,
        ...over,
    };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    roles = [EVERYONE, MEMBER, MUTED];
    existing = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

function button(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
}

function labelled(label: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

async function click(el: Element | null | undefined) {
    expect(el, 'the control to click must exist').toBeTruthy();
    await act(async () => {
        el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

/** Render, open the Permissions tab (which lazy-loads roles + overwrites) and
 *  select the named role. */
async function openPermissions(channel: Channel, roleName: string) {
    await act(async () => {
        root.render(
            <EditChannelModal isOpen onClose={() => {}} channel={channel} onChannelUpdated={() => {}} />,
        );
    });
    await click(button('Permissions'));
    expect(listRoles).toHaveBeenCalledWith('s1');
    expect(getChannelOverwrites).toHaveBeenCalledWith(channel.id);
    const role = [...container.querySelectorAll('.channel-perms-role')]
        .find(b => b.querySelector('.channel-perms-role-name')?.textContent === roleName);
    await click(role);
    expect(role!.classList.contains('active'), `${roleName} must be the selected role`).toBe(true);
}

async function savePermissions() {
    const save = button('Save Permissions');
    expect(save!.disabled, 'a change must enable Save Permissions').toBe(false);
    await click(save);
}

/** Every row label rendered in the editor, in order. */
function rowLabels(): string[] {
    return [...container.querySelectorAll('.channel-perm-row .channel-perm-label')]
        .map(l => l.firstChild?.textContent ?? '');
}

describe('EditChannelModal — voice permission rows', () => {
    it('a voice channel offers Connect, Speak, Video, Stream and Play Games below the existing rows', async () => {
        await openPermissions(chan(), 'Member');
        expect(rowLabels()).toEqual([
            'View Channel', 'Send Messages', 'Add Tasks', 'Complete Tasks', 'Manage Tasks',
            'Manage Messages', 'Create Clips',
            ...VOICE_ROWS,
        ]);
        for (const row of VOICE_ROWS) {
            for (const state of ['inherit', 'allow', 'deny']) {
                expect(labelled(`${row}: ${state}`), `${row}: ${state}`).toBeTruthy();
            }
            // No overwrite yet: every voice row starts on Inherit.
            expect(labelled(`${row}: inherit`)!.classList.contains('active')).toBe(true);
        }
        const hint = container.querySelector('.channel-perms-voice-hint');
        expect(hint?.textContent).toContain('server owner or administrators');
        expect(hint?.textContent).toContain('A Deny of Connect or Speak takes effect straight away');
    });

    it('denying Speak for a role saves allow=0, deny=512 for exactly that role', async () => {
        await openPermissions(chan(), 'Member');
        await click(labelled('Speak: deny'));
        expect(labelled('Speak: deny')!.classList.contains('active')).toBe(true);
        await savePermissions();

        expect(putChannelOverwrite).toHaveBeenCalledTimes(1);
        expect(putChannelOverwrite).toHaveBeenCalledWith(CHANNEL_ID, MEMBER.id, 0, 512);
        expect(PERM.SPEAK).toBe(512);
        expect(deleteChannelOverwrite).not.toHaveBeenCalled();
    });

    it.each([
        ['Connect', PERM.CONNECT, 256],
        ['Speak', PERM.SPEAK, 512],
        ['Video', PERM.VIDEO, 1024],
        ['Stream', PERM.STREAM, 2048],
        // docs/GAMES.md: a voice-only bit, 1 << 28 on the wire.
        ['Play Games', PERM.PLAY_GAMES, 268435456],
    ] as const)('%s saves its own bit (allow and deny)', async (row, bit, literal) => {
        // The literal pins the wire value independently of PERM, so a PERM
        // typo cannot make the row and the assertion agree on a wrong bit.
        expect(bit).toBe(literal);

        await openPermissions(chan(), 'Muted');
        await click(labelled(`${row}: allow`));
        await savePermissions();
        expect(putChannelOverwrite).toHaveBeenLastCalledWith(CHANNEL_ID, MUTED.id, literal, 0);

        await click(labelled(`${row}: deny`));
        await savePermissions();
        expect(putChannelOverwrite).toHaveBeenLastCalledWith(CHANNEL_ID, MUTED.id, 0, literal);
        expect(putChannelOverwrite).toHaveBeenCalledTimes(2);
    });

    it('setting Speak touches only its bit: bits it does not own survive the save', async () => {
        // Send Messages allowed by an earlier edit, plus a bit this client has
        // no row for (another client's, or a future permission's).
        const FOREIGN = 1 << 29;
        existing = [{ role_id: MEMBER.id, allow: PERM.SEND_MESSAGES | FOREIGN, deny: PERM.VIDEO }];
        await openPermissions(chan(), 'Member');
        // Loaded state is reflected before anything is touched.
        expect(labelled('Send Messages: allow')!.classList.contains('active')).toBe(true);
        expect(labelled('Video: deny')!.classList.contains('active')).toBe(true);

        await click(labelled('Speak: deny'));
        await savePermissions();
        expect(putChannelOverwrite).toHaveBeenCalledWith(
            CHANNEL_ID, MEMBER.id, PERM.SEND_MESSAGES | FOREIGN, PERM.VIDEO | PERM.SPEAK,
        );
    });

    it('returning Speak to Inherit on a Speak-only overwrite deletes the overwrite', async () => {
        existing = [{ role_id: MUTED.id, allow: 0, deny: PERM.SPEAK }];
        await openPermissions(chan(), 'Muted');
        expect(labelled('Speak: deny')!.classList.contains('active')).toBe(true);

        await click(labelled('Speak: inherit'));
        await savePermissions();
        expect(deleteChannelOverwrite).toHaveBeenCalledWith(CHANNEL_ID, MUTED.id);
        expect(putChannelOverwrite).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: the existing Create Clips row saves through the same path', async () => {
        await openPermissions(chan(), 'Member');
        await click(labelled('Create Clips: deny'));
        await savePermissions();
        expect(putChannelOverwrite).toHaveBeenCalledTimes(1);
        expect(putChannelOverwrite).toHaveBeenCalledWith(CHANNEL_ID, MEMBER.id, 0, PERM.CREATE_CLIPS);
    });

    it.each([
        ['text', 0],
        ['collection', 2],
    ])('a %s channel shows no Connect/Speak/Video/Stream/Play Games rows and no voice hint', async (_kind, channelType) => {
        await openPermissions(chan({ name: 'general', channel_type: channelType }), 'Member');
        // The editor DID render (so absence below is not a tab that failed
        // to load): the existing rows are all there, in their order.
        expect(rowLabels()).toEqual([
            'View Channel', 'Send Messages', 'Add Tasks', 'Complete Tasks', 'Manage Tasks',
            'Manage Messages', 'Create Clips',
        ]);
        expect(labelled('View Channel: deny')).toBeTruthy();
        for (const row of VOICE_ROWS) {
            for (const state of ['inherit', 'allow', 'deny']) {
                expect(labelled(`${row}: ${state}`), `${row}: ${state} must not render`).toBeNull();
            }
        }
        expect(container.querySelector('.channel-perms-voice-hint')).toBeNull();
        expect(container.querySelector('.channel-perm-desc')).toBeNull();
    });
});
