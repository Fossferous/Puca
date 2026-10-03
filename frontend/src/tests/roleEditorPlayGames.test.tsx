/**
 * Role editor › Voice Permissions › Play Games (docs/GAMES.md: PLAY_GAMES =
 * 1 << 28 opens a table and sits; `DEFAULT_MEMBER` has it). The row must be
 * there, in the voice group, and save exactly its own bit — the literal pins
 * the wire value independently of PERMISSIONS, so a typo in the map cannot
 * make the row and the assertion agree on a wrong bit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Role } from '../api/servers';

const MEMBER: Role = { id: 5, server_id: 's1', name: 'Member', color: '#3498DB', permissions: 1 << 8, position: 1, is_default: false };
const updateRole = vi.fn(async () => {});
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    listRoles: async () => [{ ...MEMBER }],
    listMembersWithRoles: async () => [],
    updateRole: (...a: unknown[]) => updateRole(...(a as [])),
}));

const { RoleSettingsModal } = await import('../components/RoleSettingsModal');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const row = (label: string) => [...container.querySelectorAll('label.permission-item')]
    .find(l => l.querySelector('.permission-label')?.textContent === label);

describe('Role editor — Play Games', () => {
    it('is listed under Voice Permissions with a description, and saves bit 1 << 28', async () => {
        await act(async () => {
            root.render(<RoleSettingsModal isOpen onClose={() => {}} serverId="s1" serverName="S" isOwner embedded />);
        });
        const play = row('Play Games');
        expect(play, 'the Play Games row').toBeTruthy();
        expect(play!.closest('.permission-category')?.querySelector('h4')?.textContent).toBe('Voice Permissions');
        expect(play!.querySelector('.permission-desc')?.textContent).toMatch(/Poker or Blackjack/);
        const box = play!.querySelector('input')!;
        expect(box.checked).toBe(false);
        await act(async () => { box.click(); });
        await act(async () => {
            [...container.querySelectorAll('button')].find(b => b.textContent === 'Save Changes')!
                .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(updateRole).toHaveBeenCalledTimes(1);
        const [, id, body] = updateRole.mock.calls[0] as unknown as [string, number, { permissions: number }];
        expect(id).toBe(MEMBER.id);
        expect(body.permissions).toBe((1 << 8) | 268435456);
    });
});
