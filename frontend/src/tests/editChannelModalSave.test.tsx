/**
 * Edit Channel › General: what a save sends.
 *
 *  - The parent goes only when it changed. The server obeys a null now, so a save from a row
 *    older than another manager's move would otherwise take the channel back out.
 *  - So does the topic, for the same reason: an empty field from a row with no topic would wipe
 *    one another manager has just set. A topic the person emptied goes as empty: left out, the
 *    server keeps the old one, and the editor's own refetch puts it back.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component tests are:
 * @testing-library/react is not a dependency here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel } from '../api/servers';
import { PERM } from '../api/permissionBits';

const updateChannel = vi.fn(async () => {});

vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    updateChannel: (...a: unknown[]) => updateChannel(...(a as [])),
}));

const { EditChannelModal } = await import('../components/EditChannelModal');

const COLLECTION: Channel = { id: 7, name: 'Rooms', channel_type: 2, server_id: 's1', my_permissions: PERM.MANAGE_CHANNELS };

function chan(over: Partial<Channel> = {}): Channel {
    return { id: 42, name: 'notes', channel_type: 0, server_id: 's1', my_permissions: PERM.MANAGE_CHANNELS, ...over };
}

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

const open = async (channel: Channel, onChannelUpdated: (c: Channel) => void = () => {}) => {
    await act(async () => {
        root.render(<EditChannelModal isOpen onClose={() => {}} channel={channel} collections={[COLLECTION]} onChannelUpdated={onChannelUpdated} />);
    });
};

/** A real value change, as a person's typing or choosing makes one. */
const change = async (el: HTMLSelectElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
};

const save = async () => {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save Changes');
    expect(button, 'the Save button').toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

const sent = () => {
    expect(updateChannel).toHaveBeenCalledTimes(1);
    return (updateChannel.mock.calls[0] as unknown as [number, Record<string, unknown>])[1];
};

describe('Edit Channel: the parent', () => {
    it('leaves the parent out of a save that did not change it, under a collection', async () => {
        await open(chan({ parent_id: COLLECTION.id }));
        await save();
        expect(sent()).not.toHaveProperty('parent_id');
    });

    it('and at the top level, where null would undo a move this row is older than', async () => {
        await open(chan({ parent_id: null }));
        await save();
        expect(sent()).not.toHaveProperty('parent_id');
    });

    it('and for a row from a server that sent no parent at all', async () => {
        await open(chan());
        await save();
        expect(sent()).not.toHaveProperty('parent_id');
    });

    it('sends a parent that was chosen', async () => {
        await open(chan({ parent_id: null }));
        await change(container.querySelector<HTMLSelectElement>('#channel-parent')!, String(COLLECTION.id));
        await save();
        expect(sent().parent_id).toBe(COLLECTION.id);
    });

    it('sends null for No parent (top level), which is what takes it out', async () => {
        await open(chan({ parent_id: COLLECTION.id }));
        await change(container.querySelector<HTMLSelectElement>('#channel-parent')!, '');
        await save();
        expect(sent().parent_id).toBeNull();
    });

    it('still tells the list where the row is, whichever it sent', async () => {
        const updated = vi.fn();
        await open(chan({ parent_id: COLLECTION.id }), updated);
        await save();
        expect(updated.mock.calls[0][0].parent_id).toBe(COLLECTION.id);
    });
});

describe('Edit Channel: the topic', () => {
    it('leaves an untouched empty field out: the row can be older than another manager\'s new topic', async () => {
        await open(chan({ description: null }));
        await save();
        expect(sent()).not.toHaveProperty('description');
    });

    it('and for a row from a server that sent no topic at all', async () => {
        await open(chan());
        await save();
        expect(sent()).not.toHaveProperty('description');
    });

    it('and an untouched topic, which would undo another manager\'s change to it', async () => {
        await open(chan({ description: 'the town square' }));
        await save();
        expect(sent()).not.toHaveProperty('description');
    });

    it('and nothing but spaces typed where there was no topic, which is still none', async () => {
        await open(chan({ description: null }));
        await change(container.querySelector<HTMLTextAreaElement>('#channel-topic')!, '   ');
        await save();
        expect(sent()).not.toHaveProperty('description');
    });

    it('sends a first topic for a channel that had none', async () => {
        await open(chan({ description: null }));
        await change(container.querySelector<HTMLTextAreaElement>('#channel-topic')!, 'read the pins');
        await save();
        expect(sent().description).toBe('read the pins');
    });

    it('sends an emptied topic as empty: left out, the server would keep the old one', async () => {
        await open(chan({ description: 'the town square' }));
        await change(container.querySelector<HTMLTextAreaElement>('#channel-topic')!, '');
        await save();
        expect(sent().description).toBe('');
    });

    it('sends a topic of nothing but spaces as empty too', async () => {
        await open(chan({ description: 'the town square' }));
        await change(container.querySelector<HTMLTextAreaElement>('#channel-topic')!, '   ');
        await save();
        expect(sent().description).toBe('');
    });

    it('sends a new topic trimmed, and shows no topic in the list for an empty one', async () => {
        const updated = vi.fn();
        await open(chan({ description: 'old' }), updated);
        await change(container.querySelector<HTMLTextAreaElement>('#channel-topic')!, '  new  ');
        await save();
        expect(sent().description).toBe('new');
        expect(updated.mock.calls[0][0].description).toBe('new');
    });
});
