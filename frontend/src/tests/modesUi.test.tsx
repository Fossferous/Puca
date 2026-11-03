/**
 * Server modes on screen (docs/SERVER_MODES.md): the selector, its menu, the start
 * notice, the settings tab that defines modes, the role editor's Switch Modes row,
 * and the personal switch. The sidebar's use of them inside Chat and the look on a
 * real theme are frontend/e2e/modes-walk.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Role } from '../api/servers';
import type { ServerMode, ServerModes } from '../api/serverModes';

const SERVER = 's1';
let stored: ServerModes;
const createMode = vi.fn(async (_s: string, _e: unknown) => ({ id: 9 }));
const updateMode = vi.fn(async (_s: string, _id: number, _e: unknown) => {});
const deleteMode = vi.fn(async (_s: string, _id: number) => {});
const uploadFile = vi.fn(async (_f: File) => ({ id: 'file-1', original_name: 'x', mime_type: 'image/jpeg', size_bytes: 1, url: '' }));
const prepareBackground = vi.fn(async (f: File) => f);

vi.mock('../api/serverModes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/serverModes')>()),
    listModes: async () => stored,
    createMode: (s: string, e: unknown) => createMode(s, e),
    updateMode: (s: string, id: number, e: unknown) => updateMode(s, id, e),
    deleteMode: (s: string, id: number) => deleteMode(s, id),
}));
// The signed-in account, for the role editor's "what do I hold?": nobody unless a test says.
let signedIn: number | null = null;
vi.mock('../api/auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => (signedIn === null ? null : 'a token'),
    decodeJwtPayload: () => (signedIn === null ? null : { sub: signedIn }),
}));
vi.mock('../api/uploads', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/uploads')>()),
    uploadFile: (f: File) => uploadFile(f),
}));
vi.mock('../api/modeLook', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/modeLook')>()),
    prepareBackground: (f: File) => prepareBackground(f),
}));
const MEMBER: Role = { id: 5, server_id: SERVER, name: 'Storyteller', color: '#3498DB', permissions: 1 << 8, position: 1, is_default: false };
const updateRole = vi.fn(async () => {});
let roleBits = MEMBER.permissions;
let myBits = 0;
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    listChannels: async () => [
        { id: 1, name: 'Town Square', channel_type: 1, server_id: SERVER, mode_ids: [3] },
        { id: 2, name: 'Cottage', channel_type: 1, server_id: SERVER, mode_ids: [3] },
        { id: 3, name: 'General voice', channel_type: 1, server_id: SERVER, mode_ids: [] },
        { id: 4, name: 'game-chat', channel_type: 0, server_id: SERVER, mode_ids: [3] },
        { id: 5, name: 'Sleeping', channel_type: 1, server_id: SERVER, is_afk: true, mode_ids: [] },
        { id: 6, name: 'Rooms', channel_type: 2, server_id: SERVER, mode_ids: [99] },
        { id: 7, name: 'Room A', channel_type: 0, server_id: SERVER, parent_id: 6, mode_ids: [] },
        { id: 8, name: 'Voice Under', channel_type: 1, server_id: SERVER, parent_id: 6, mode_ids: [] },
        { id: 10, name: 'Hall', channel_type: 2, server_id: SERVER, mode_ids: [98] },
        { id: 11, name: 'Stranded', channel_type: 1, server_id: SERVER, parent_id: 10, mode_ids: [99] },
    ],
    listRoles: async () => [{ ...MEMBER, permissions: roleBits }],
    listMembersWithRoles: async () => (signedIn === null ? [] : [{ id: signedIn, roles: [{ permissions: myBits }] }]),
    updateRole: (...a: unknown[]) => updateRole(...(a as [])),
}));

const { ModeNotice, ModeSelector } = await import('../components/modes/ModeSelector');
const { endedCallsWarning, modeMenuItems, noticeJoinName } = await import('../components/modes/modeMenu');
const { ModesSettings } = await import('../components/modes/ModesSettings');
const { RoleSettingsModal } = await import('../components/RoleSettingsModal');
const { PERMISSIONS, unsignedMask } = await import('../api/permissionBits');
const { serverLooksAllowed } = await import('../components/modes/useModeLook');
const { applyAppearance, loadSettings } = await import('../components/settingsStore');

const clocktower: ServerMode = {
    id: 3,
    name: 'Blood on the Clocktower',
    background_file_id: null,
    accent_color: null,
    home_channel_id: 1,
    auto_off: true,
    channel_ids: [1, 2, 4],
};
const modes = (over: Partial<ServerModes> = {}): ServerModes => ({
    active_mode_id: null,
    can_switch: true,
    can_edit: true,
    can_call_back: true,
    modes: [clocktower],
    ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.clearAllMocks();
    stored = modes();
    roleBits = MEMBER.permissions;
    signedIn = null;
    myBits = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const render = async (node: React.ReactNode) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const button = (name: string | RegExp) => [...container.querySelectorAll('button')]
    .find(b => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? '')));
const press = async (b: Element | undefined) => {
    expect(b, 'the control').toBeTruthy();
    await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const type = async (el: HTMLInputElement, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

describe('the selector', () => {
    const onOpen = vi.fn();

    it('is a button saying what is on, for someone who may switch, even with nothing on', async () => {
        await render(<ModeSelector data={modes()} activeModeId={null} homeName={null} onOpen={onOpen} />);
        const b = container.querySelector('[data-testid="mode-selector"]')!;
        expect(b.tagName).toBe('BUTTON');
        expect(b.textContent).toContain('Off');
        await render(<ModeSelector data={modes()} activeModeId={3} homeName={null} onOpen={onOpen} />);
        expect(container.querySelector('[data-testid="mode-selector"]')!.textContent).toContain('Blood on the Clocktower');
    });

    it('opens the menu under itself', async () => {
        await render(<ModeSelector data={modes()} activeModeId={null} homeName={null} onOpen={onOpen} />);
        await press(container.querySelector('[data-testid="mode-selector"]')!);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen.mock.calls[0][0]).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
        expect(onOpen.mock.calls[0][1], 'and says what opened it, for the focus to go back to').toBe(container.querySelector('[data-testid="mode-selector"]'));
    });

    it('is a plain label for everyone else while a mode is on, and nothing when none is', async () => {
        const member = modes({ can_switch: false, can_edit: false, can_call_back: false });
        await render(<ModeSelector data={member} activeModeId={3} homeName={null} onOpen={onOpen} />);
        expect(container.querySelector('button')).toBeNull();
        expect(container.querySelector('[data-testid="mode-label"]')!.textContent).toContain('Blood on the Clocktower');
        await render(<ModeSelector data={member} activeModeId={null} homeName={null} onOpen={onOpen} />);
        expect(container.textContent).toBe('');
    });

    it('is a button for someone who holds only Move Members, once there is someone to call back', async () => {
        const mover = modes({ can_switch: false, can_edit: false, can_call_back: true });
        await render(<ModeSelector data={mover} activeModeId={3} homeName="Town Square" onOpen={onOpen} />);
        await press(container.querySelector('[data-testid="mode-selector"]')!);
        expect(onOpen).toHaveBeenCalledTimes(1);
        // Without a mode on or a main channel the menu would be empty: still a label.
        await render(<ModeSelector data={mover} activeModeId={3} homeName={null} onOpen={onOpen} />);
        expect(container.querySelector('button')).toBeNull();
        await render(<ModeSelector data={mover} activeModeId={null} homeName="Town Square" onOpen={onOpen} />);
        expect(container.textContent).toBe('');
        expect(modeMenuItems({ data: mover, activeModeId: 3, homeName: 'Town Square', onSwitch: vi.fn(), onCallBack: vi.fn(), onManage: vi.fn() }).map(i => i.id))
            .toEqual(['mode-call-back']);
    });

    it('is nothing on a server with no modes, or before the answer lands', async () => {
        await render(<ModeSelector data={modes({ modes: [] })} activeModeId={null} homeName={null} onOpen={onOpen} />);
        expect(container.textContent).toBe('');
        await render(<ModeSelector data={undefined} activeModeId={null} homeName={null} onOpen={onOpen} />);
        expect(container.textContent).toBe('');
    });
});

describe('the menu', () => {
    const handlers = { onSwitch: vi.fn(), onCallBack: vi.fn(), onManage: vi.fn() };
    const ids = (data: ServerModes, activeModeId: number | null, homeName: string | null) =>
        modeMenuItems({ data, activeModeId, homeName, ...handlers }).map(i => i.id);

    it('offers Off and every mode, marking the one that is on', () => {
        const items = modeMenuItems({ data: modes(), activeModeId: 3, homeName: 'Town Square', ...handlers });
        expect(items.find(i => i.id === 'mode-3')?.icon).toBe('check');
        expect(items.find(i => i.id === 'mode-off')?.icon).toBeUndefined();
        items.find(i => i.id === 'mode-off')!.onClick!();
        expect(handlers.onSwitch).toHaveBeenCalledWith(null);
        items.find(i => i.id === 'mode-3')!.onClick!();
        expect(handlers.onSwitch).toHaveBeenCalledWith(3);
    });

    it('offers Call everyone back only with a mode on, the right, and somewhere to go', () => {
        expect(ids(modes(), 3, 'Town Square')).toContain('mode-call-back');
        expect(ids(modes(), null, 'Town Square')).not.toContain('mode-call-back');
        expect(ids(modes(), 3, null)).not.toContain('mode-call-back');
        expect(ids(modes({ can_call_back: false }), 3, 'Town Square')).not.toContain('mode-call-back');
    });

    it('offers the switches only with Switch Modes, and Manage modes only with Manage Channels', () => {
        const editorOnly = ids(modes({ can_switch: false, can_call_back: false }), null, null);
        expect(editorOnly).toEqual(['mode-manage']);
        const switchOnly = ids(modes({ can_edit: false, can_call_back: false }), null, null);
        expect(switchOnly).toEqual(['mode-off', 'mode-3']);
    });
});

describe('the warning before a switch', () => {
    it('is silent when nobody would be cut off, and says how many otherwise', () => {
        expect(endedCallsWarning(clocktower, 0)).toBeNull();
        expect(endedCallsWarning(clocktower, 1)).toMatch(/^1 person is in .*Blood on the Clocktower.*disconnected/);
        expect(endedCallsWarning(clocktower, 3)).toMatch(/^3 people are in /);
    });
});

describe('the start notice', () => {
    const on = { onJoin: vi.fn(), onOpenServer: vi.fn(), onDismiss: vi.fn() };

    it('is a polite status line with Join and Dismiss', async () => {
        await render(<ModeNotice modeName="Clocktower" otherServerName={null} joinName="Town Square" {...on} />);
        const n = container.querySelector('[data-testid="mode-notice"]')!;
        expect(n.getAttribute('role')).toBe('status');
        expect(n.getAttribute('aria-live')).toBe('polite');
        expect(n.textContent).toContain('Clocktower');
        await press(button('Join Town Square'));
        expect(on.onJoin).toHaveBeenCalledTimes(1);
        await press(container.querySelector('button[aria-label="Dismiss"]')!);
        expect(on.onDismiss).toHaveBeenCalledTimes(1);
    });

    it('says which server, and offers to open it rather than to join from elsewhere', async () => {
        await render(<ModeNotice modeName="Clocktower" otherServerName="Friends" joinName={null} {...on} />);
        expect(container.textContent).toContain('in Friends');
        expect(button(/^Join/)).toBeUndefined();
        await press(button('Open'));
        expect(on.onOpenServer).toHaveBeenCalledTimes(1);
    });

    it('offers no Join when the mode has no main channel', async () => {
        await render(<ModeNotice modeName="Clocktower" otherServerName={null} joinName={null} {...on} />);
        expect(button(/^Join/)).toBeUndefined();
    });
});

describe('the Join a start notice offers', () => {
    const home = { id: 1, name: 'Town Square' };
    it('goes to the main channel, and is not offered to someone already there', () => {
        expect(noticeJoinName(home, null)).toBe('Town Square');
        expect(noticeJoinName(home, 9)).toBe('Town Square');
        expect(noticeJoinName(home, 1)).toBeNull();
        expect(noticeJoinName(null, null)).toBeNull();
    });
});

describe('Server Settings, Modes', () => {
    it('says plainly that a mode is not access control, and that turning off disconnects', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        expect(container.textContent).toMatch(/does not keep anyone out/);
        expect(container.textContent).toMatch(/use its permissions/);
        expect(container.textContent).toMatch(/disconnects everyone in\s+its voice channels/);
    });

    it('says the background is stored unencrypted', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        expect(container.textContent).toMatch(/Stored\s+unencrypted, like the server icon/);
    });

    it('creates a mode', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        await type(container.querySelector('input[aria-label="New mode name"]')!, '  Werewolf ');
        await press(button('Add mode'));
        expect(createMode).toHaveBeenCalledWith(SERVER, { name: 'Werewolf' });
    });

    it('saves only what changed, so it cannot undo another manager\'s edit', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        expect(button('Save')!.disabled, 'nothing to save yet').toBe(true);
        await press(container.querySelector('input[aria-label="General voice belongs to Blood on the Clocktower"]')!);
        await press(button('Save'));
        expect(updateMode).toHaveBeenCalledTimes(1);
        expect(updateMode.mock.calls[0]).toEqual([SERVER, 3, { channel_ids: [1, 2, 4, 3] }]);
    });

    it('sends empty to clear the accent and zero to clear the main channel', async () => {
        stored = modes({ modes: [{ ...clocktower, accent_color: '#7a1f3d' }] });
        await render(<ModesSettings serverId={SERVER} />);
        await press(button('No accent'));
        const home = container.querySelector('select') as HTMLSelectElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
            set.call(home, '');
            home.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await press(button('Save'));
        expect(updateMode.mock.calls[0][2]).toEqual({ home_channel_id: 0, accent_color: '' });
    });

    it('never offers the AFK channel, and says why', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        expect(container.querySelector('input[aria-label="Sleeping belongs to Blood on the Clocktower"]')).toBeNull();
        expect(container.textContent).toMatch(/AFK channel can't belong to a mode/);
    });

    it('prepares a picture, uploads it through the one door, and saves its id', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        expect(input.accept).toBe('image/jpeg,image/png,image/webp');
        const file = new File(['x'], 'night.png', { type: 'image/png' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(prepareBackground).toHaveBeenCalledWith(file);
        expect(uploadFile).toHaveBeenCalledWith(file);
        expect(updateMode).toHaveBeenCalledWith(SERVER, 3, { background_file_id: 'file-1' });
    });

    it('asks before deleting, and warns when the mode is on', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        stored = modes({ active_mode_id: 3 });
        await render(<ModesSettings serverId={SERVER} />);
        await press(button(/Delete mode/));
        expect(confirm.mock.calls[0][0]).toMatch(/disconnected/);
        expect(deleteMode).not.toHaveBeenCalled();
        confirm.mockReturnValue(true);
        await press(button(/Delete mode/));
        expect(deleteMode).toHaveBeenCalledWith(SERVER, 3);
        confirm.mockRestore();
    });

    it('holding Enter creates one mode', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        const name = container.querySelector<HTMLInputElement>('input[aria-label="New mode name"]')!;
        await type(name, 'Twice');
        createMode.mockImplementationOnce(() => new Promise(() => {}));
        const enter = () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await act(async () => { enter(); });
        await act(async () => { enter(); });
        await act(async () => { enter(); });
        expect(createMode).toHaveBeenCalledTimes(1);
    });

    it('will not delete the mode that is on without Switch Modes, and says why', async () => {
        stored = modes({ active_mode_id: 3, can_switch: false });
        await render(<ModesSettings serverId={SERVER} />);
        expect(button(/Delete mode/)?.disabled).toBe(true);
        expect(container.textContent).toContain('takes the Switch Modes permission');
    });

    it('CONTROL: with Switch Modes, or with the mode off, it will', async () => {
        stored = modes({ active_mode_id: 3 });
        await render(<ModesSettings serverId={SERVER} />);
        expect(button(/Delete mode/)?.disabled).toBe(false);
        stored = modes({ active_mode_id: null, can_switch: false });
        await render(<ModesSettings serverId={SERVER} />);
        expect(button(/Delete mode/)?.disabled).toBe(false);
    });

    it('never sends a channel that is gone, which the server would refuse the whole save for', async () => {
        stored = modes({ modes: [{ ...clocktower, channel_ids: [1, 2, 4, 777] }] });
        await render(<ModesSettings serverId={SERVER} />);
        await act(async () => { container.querySelector<HTMLInputElement>('input[aria-label="Cottage belongs to Blood on the Clocktower"]')!.click(); });
        await press(button('Save'));
        const sent = (updateMode.mock.calls[0] as unknown as [string, number, { channel_ids: number[] }])[2].channel_ids;
        expect(sent).not.toContain(777);
        expect(sent.length).toBeGreaterThan(0);
    });

    it('shows which row is a collection and which are under it', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        const rowOf = (name: string) => [...container.querySelectorAll('label.mode-channel')]
            .find(l => l.querySelector('.mode-channel-name')?.textContent === name)!;
        const icon = (name: string) => rowOf(name).querySelector('.mode-channel-icon')!.innerHTML;
        expect(icon('Rooms'), 'a collection is drawn as one').not.toBe(icon('game-chat'));
        expect(icon('Room A'), 'control: two text channels look alike').toBe(icon('game-chat'));
        const under = rowOf('Room A');
        expect(under.classList.contains('mode-channel-sub')).toBe(true);
        expect(under.querySelector('.mode-channel-parent')?.textContent).toBe('in Rooms');
        expect(rowOf('Rooms').classList.contains('mode-channel-sub')).toBe(false);
        // Ticking the collection takes the row with it, and the row says so.
        await act(async () => { rowOf('Rooms').querySelector('input')!.click(); });
        expect(rowOf('Room A').querySelector('input')!.checked).toBe(true);
        expect(rowOf('Room A').querySelector('input')!.disabled).toBe(true);
        expect(rowOf('Room A').querySelector('.mode-channel-parent')?.textContent).toBe('with Rooms');
    });

    it('says when a channel is listed under nothing, and does not offer it as the main channel', async () => {
        // Ticked in this card too, which would otherwise offer it.
        stored = modes({ modes: [{ ...clocktower, channel_ids: [1, 2, 4, 11] }] });
        await render(<ModesSettings serverId={SERVER} />);
        const rowOf = (name: string) => [...container.querySelectorAll('label.mode-channel')]
            .find(l => l.querySelector('.mode-channel-name')?.textContent === name)!;
        expect(rowOf('Stranded').textContent).toContain('not listed: it and Hall are in different modes');
        expect(rowOf('Voice Under').textContent, 'control: an ordinary subchannel').not.toContain('not listed');
        const options = [...container.querySelectorAll('select option')].map(o => o.textContent);
        expect(options).not.toContain('Stranded');
    });

    it('offers a voice room under a ticked collection as the main channel', async () => {
        await render(<ModesSettings serverId={SERVER} />);
        const options = () => [...container.querySelectorAll('select option')].map(o => o.textContent);
        expect(options()).not.toContain('Voice Under');
        const collection = [...container.querySelectorAll('label.mode-channel')]
            .find(l => l.querySelector('.mode-channel-name')?.textContent === 'Rooms')!.querySelector('input')!;
        await act(async () => { collection.click(); });
        expect(options()).toContain('Voice Under');
    });

    it('is read-only without Manage Channels', async () => {
        stored = modes({ can_edit: false });
        await render(<ModesSettings serverId={SERVER} />);
        expect(container.textContent).toMatch(/need the Manage Channels permission/);
        expect(container.querySelector('input[aria-label="New mode name"]')).toBeNull();
        expect(button('Save')).toBeUndefined();
        expect(container.textContent).toContain('Blood on the Clocktower');
    });
});

describe('the role editor', () => {
    const row = (label: string) => [...container.querySelectorAll('label.permission-item')]
        .find(l => l.querySelector('.permission-label')?.textContent === label);
    const saved = async () => {
        await press([...container.querySelectorAll('button')].find(b => b.textContent === 'Save Changes'));
        expect(updateRole).toHaveBeenCalledTimes(1);
        return (updateRole.mock.calls[0] as unknown as [string, number, { permissions: number }])[2].permissions;
    };
    const open = async () => {
        await act(async () => {
            root.render(<RoleSettingsModal isOpen onClose={() => {}} serverId={SERVER} serverName="S" isOwner embedded />);
        });
    };

    const openAsMember = async (bits: number) => {
        signedIn = 42;
        myBits = bits;
        await act(async () => {
            root.render(<RoleSettingsModal isOpen onClose={() => {}} serverId={SERVER} serverName="S" isOwner={false} embedded />);
        });
        for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    };

    it('offers no Switch Modes row on a backend with no modes, where it would be a right to nothing', async () => {
        await act(async () => {
            root.render(<RoleSettingsModal isOpen onClose={() => {}} serverId={SERVER} serverName="S" isOwner embedded modesSupported={false} />);
        });
        for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(row('Create Invites'), 'control: the editor is up').toBeTruthy();
        expect(row('Switch Modes')).toBeFalsy();
    });

    it('someone with Manage Roles and not Switch Modes cannot tick it, because the server would ignore it', async () => {
        await openAsMember(PERMISSIONS.MANAGE_ROLES);
        expect(row('Create Invites')!.querySelector('input')!.disabled, 'control: they can edit this role').toBe(false);
        expect(row('Switch Modes')!.querySelector('input')!.disabled).toBe(true);
        expect(row('Switch Modes')!.textContent).toContain('Only someone who holds this permission');
    });

    it('CONTROL: holding it too, they can', async () => {
        await openAsMember(unsignedMask(PERMISSIONS.MANAGE_ROLES | PERMISSIONS.SWITCH_MODES));
        expect(row('Switch Modes')!.querySelector('input')!.disabled).toBe(false);
        expect(row('Switch Modes')!.textContent).not.toContain('Only someone who holds this permission');
    });

    it('has a Switch Modes row that saves bit 31 as a POSITIVE number', async () => {
        await open();
        const box = row('Switch Modes')!.querySelector('input')!;
        expect(row('Switch Modes')!.closest('.permission-category')?.querySelector('h4')?.textContent).toBe('Management Permissions');
        expect(box.checked).toBe(false);
        await act(async () => { box.click(); });
        expect(box.checked).toBe(true);
        expect(await saved()).toBe((1 << 8) + 2147483648);
    });

    it('editing another bit of a role that holds it stays positive and keeps it', async () => {
        roleBits = (1 << 8) + 2147483648;
        await open();
        expect(row('Switch Modes')!.querySelector('input')!.checked).toBe(true);
        await act(async () => { row('Speak')!.querySelector('input')!.click(); });
        expect(await saved()).toBe((1 << 8) + (1 << 9) + 2147483648);
    });

    it('takes it away as a positive number too', async () => {
        roleBits = (1 << 8) + 2147483648;
        await open();
        await act(async () => { row('Switch Modes')!.querySelector('input')!.click(); });
        expect(await saved()).toBe(1 << 8);
    });

    it('the constant is the sign bit, which is why the mask has to be made unsigned', () => {
        expect(PERMISSIONS.SWITCH_MODES).toBe(-2147483648);
        expect(((1 << 8) | PERMISSIONS.SWITCH_MODES) < 0).toBe(true);
        expect(unsignedMask((1 << 8) | PERMISSIONS.SWITCH_MODES)).toBe(2147483904);
    });
});

describe('the personal switch', () => {
    const root_ = document.documentElement;
    afterEach(() => {
        root_.removeAttribute('data-server-looks');
        root_.removeAttribute('data-contrast');
    });

    it('is on by default, and applying settings puts it where the look reads it', () => {
        const settings = loadSettings();
        expect(settings.serverLooks).toBe(true);
        applyAppearance(settings);
        expect(root_.getAttribute('data-server-looks')).toBe('on');
        expect(serverLooksAllowed()).toBe(true);
        applyAppearance({ ...settings, serverLooks: false });
        expect(root_.getAttribute('data-server-looks')).toBe('off');
        expect(serverLooksAllowed()).toBe(false);
    });

    it('High Contrast hides the look whatever the switch says', () => {
        const settings = loadSettings();
        applyAppearance({ ...settings, serverLooks: true, highContrast: true });
        expect(serverLooksAllowed()).toBe(false);
        applyAppearance({ ...settings, serverLooks: true, highContrast: false });
        expect(serverLooksAllowed()).toBe(true);
    });
});
