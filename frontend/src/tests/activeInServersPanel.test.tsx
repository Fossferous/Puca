/**
 * The member list's "Active in your servers" panel (ActiveInServers.tsx): what it draws for a view,
 * that a row goes to its server and nowhere else (it never joins a call), and that it folds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActiveInServers } from '../components/ActiveInServers';
import type { ActiveServer } from '../components/activeServers';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const view: ActiveServer[] = [
    { serverId: 'a', serverName: 'Alpha', isCurrent: true, rooms: [{ channelId: 1, name: 'Lounge', users: [{ id: 7, username: 'ana' }, { id: 8, username: 'bo' }, { id: 9, username: 'cy' }] }] },
    { serverId: 'b', serverName: 'Beta', isCurrent: false, rooms: [{ channelId: 10, name: 'Raid', users: [{ id: 5, username: 'dee' }] }] },
];

async function mount(props: Partial<Parameters<typeof ActiveInServers>[0]> = {}) {
    const onGo = vi.fn();
    const onToggle = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <ActiveInServers
                view={view}
                collapsed={false}
                onToggle={onToggle}
                onGo={onGo}
                nameOf={(_s, _u, username) => username}
                personOf={(_s, _c, userId, username) => ({ id: userId, name: username })}
                {...props}
            />,
        );
    });
    return { onGo, onToggle };
}

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('ActiveInServers', () => {
    it('lists every server that has a call, with its rooms and who is in them', async () => {
        await mount();
        const text = host!.textContent ?? '';
        expect(text).toContain('Alpha');
        expect(text).toContain('Beta');
        expect(text).toContain('Lounge');
        expect(text).toContain('ana, bo + 1 more');
        expect(text).toContain('dee');
        expect(host!.querySelector('.active-panel-count')?.textContent).toBe('4');
        expect(host!.querySelector('[data-server-id="a"] .active-server-here')?.textContent).toBe('this server');
        expect(host!.querySelector('[data-server-id="b"] .active-server-here')).toBeNull();
    });

    it('goes to the room\'s server when a row is pressed, and does nothing else', async () => {
        const { onGo } = await mount();
        const row = host!.querySelector('[data-channel-id="10"]') as HTMLButtonElement;
        await act(async () => { row.click(); });
        expect(onGo).toHaveBeenCalledWith('b', 10);
        expect(onGo).toHaveBeenCalledTimes(1);
    });

    it('says so when nobody is in a voice channel anywhere', async () => {
        await mount({ view: [] });
        expect(host!.textContent).toContain('Nobody is in a voice channel in any of your servers.');
        expect(host!.querySelector('.active-panel-count')).toBeNull();
    });

    it('folds to its heading, which is a button that says whether it is open', async () => {
        const { onToggle } = await mount();
        const toggle = host!.querySelector('.active-panel-toggle') as HTMLButtonElement;
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        await act(async () => { toggle.click(); });
        expect(onToggle).toHaveBeenCalledTimes(1);

        await act(async () => { root!.unmount(); });
        host!.remove();
        await mount({ collapsed: true });
        expect(host!.querySelector('.active-panel-toggle')?.getAttribute('aria-expanded')).toBe('false');
        expect(host!.querySelector('.active-rooms')).toBeNull();
        // Folded, the count stays: what is going on is still known.
        expect(host!.querySelector('.active-panel-count')?.textContent).toBe('4');
    });
});
