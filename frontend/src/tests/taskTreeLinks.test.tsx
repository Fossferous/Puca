/**
 * A web address inside a checklist item (TaskTree.tsx) — the shared rows Púca
 * Notes' editor AND Púca's Tasks view both render.
 *
 * Three nested click handlers stack up on this row: the card opens the note,
 * `.tt-description` starts an inline edit, and the link opens a browser. The
 * cases below pin which one wins, because "tapping a link wiped the row into
 * an edit input" is a failure a person hits before any of us does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/openExternal', () => ({ openExternalUrl: vi.fn(), isExternalHref: () => true }));

import { TaskTree } from '../components/TaskTree';
import { openExternalUrl } from '../api/openExternal';
import { installLinkRouter, linkShell } from '../api/linkRouter';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';
import type { Task } from '../api/tasks';

const task = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null,
});

let root: Root;
let host: HTMLDivElement;

function render(tasks: Task[]) {
    act(() => {
        root.render(
            <TaskTree
                tasks={tasks}
                onToggle={() => {}}
                onDelete={() => {}}
                onEdit={() => {}}
                onAddSubtask={() => {}}
                onMove={() => {}}
                onSetAttachments={() => {}}
            />,
        );
    });
}

// Opening a link is the link router's (api/linkRouter.ts), installed at boot
// on every page that renders these rows — here in a shell, where it shows.
let uninstallRouter: () => void;
let shell: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    shell = vi.spyOn(linkShell, 'kind').mockReturnValue('desktop');
    uninstallRouter = installLinkRouter();
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    uninstallRouter();
    shell.mockRestore();
    vi.clearAllMocks();
});

describe('links in a checklist item', () => {
    it('an address in an item becomes a link', () => {
        render([task(1, 'read https://example.com/a')]);
        const a = host.querySelector('.tt-description a.note-link') as HTMLAnchorElement;
        expect(a?.getAttribute('href')).toBe('https://example.com/a');
        expect(host.querySelector('.tt-description')?.textContent).toBe('read https://example.com/a');
    });

    it('tapping the link opens it and does NOT start an inline edit', () => {
        render([task(1, 'read https://example.com/a')]);
        const a = host.querySelector('.tt-description a.note-link')!;
        act(() => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
        expect(openExternalUrl).toHaveBeenCalledTimes(1);
        expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a');
        expect(host.querySelector('input.tt-edit-input')).toBeNull();
    });

    it('POSITIVE CONTROL: tapping the text around it still starts the edit', () => {
        render([task(1, 'read https://example.com/a')]);
        const span = host.querySelector('.tt-description')!;
        act(() => { span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
        expect(host.querySelector('input.tt-edit-input')).not.toBeNull();
    });

    it('an unreadable item is shown as it is, never linkified', () => {
        render([task(1, TASK_DECRYPT_FAILED)]);
        expect(host.querySelector('.tt-description a')).toBeNull();
        expect(host.querySelector('.tt-description')?.textContent).toBe(TASK_DECRYPT_FAILED);
    });
});
