// @vitest-environment jsdom
/**
 * The end of a task's attachment upload: encrypted and sent one file at a time,
 * so tens of seconds after the person chose the files, and often with them
 * somewhere else by now. What went wrong is a toast, not a native alert() that
 * would take the focus from whatever they went to. A refusal at the moment they
 * chose the files is still the alert it was.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    upload: null as null | ((file: File) => Promise<{ href: string; name: string }>),
}));
vi.mock('../api/attachments', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/attachments')>()),
    encryptAndUploadRef: (file: File) => h.upload!(file),
}));
vi.mock('../api/heif', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/heif')>()),
    convertHeifForUpload: async (file: File) => file,
}));

import { TaskTree } from '../components/TaskTree';
import type { Task } from '../api/tasks';
import { setMessageToastSink } from '../components/messageToastBus';
import { ENC_KEY_UNAVAILABLE } from '../api/decryptMarkers';

const task = (id: number, description: string, o: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
});

let root: Root;
let host: HTMLDivElement;
let toasts: string[];
let alertSpy: ReturnType<typeof vi.spyOn>;
const onSetAttachments = vi.fn();

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
                onReorder={() => {}}
                onSetAttachments={onSetAttachments}
            />,
        );
    });
}

/** Press the row's attach button and choose these files in the picker. */
async function choose(row: string, files: File[]) {
    const li = [...host.querySelectorAll('li.tt-item')].find(l => l.querySelector('.tt-description')?.textContent === row)!;
    const attach = [...li.querySelectorAll('button')].find(b => /^Attach/.test(b.getAttribute('title') ?? ''))!;
    act(() => { attach.click(); });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const file = (name: string) => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    onSetAttachments.mockReset();
    HTMLInputElement.prototype.click = function click() {};
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setMessageToastSink(null);
    vi.restoreAllMocks();
});

describe('the end of an attachment upload', () => {
    it('a file that failed is named in a toast, and no modal appears', async () => {
        h.upload = async () => { throw new Error('too big'); };
        render([task(1, 'Buy milk')]);
        await choose('Buy milk', [file('a.png')]);
        expect(toasts).toEqual(['Failed to attach: a.png. Files must be under 10 MB.']);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('the ones that worked are still attached beside the one that did not', async () => {
        h.upload = async f => {
            if (f.name === 'bad.png') throw new Error('too big');
            return { href: `sovereign-enc:${f.name}`, name: f.name };
        };
        render([task(1, 'Buy milk')]);
        await choose('Buy milk', [file('good.png'), file('bad.png')]);
        expect(onSetAttachments).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), [{ href: 'sovereign-enc:good.png', name: 'good.png' }]);
        expect(toasts).toEqual(['Failed to attach: bad.png. Files must be under 10 MB.']);
    });

    it('sidecar locked while the upload ran: a toast, and nothing is overwritten', async () => {
        let finishUpload: (ref: { href: string; name: string }) => void = () => {};
        h.upload = () => new Promise(resolve => { finishUpload = resolve; });
        render([task(1, 'Buy milk')]);
        await choose('Buy milk', [file('a.png')]);
        // Another member's edit arrives while it uploads, under a key this
        // device does not hold.
        render([task(1, 'Buy milk', { attachments: ENC_KEY_UNAVAILABLE })]);
        await act(async () => { finishUpload({ href: 'sovereign-enc:a', name: 'a.png' }); await new Promise(r => setTimeout(r, 0)); });
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toMatch(/can't be read yet/);
        expect(alertSpy).not.toHaveBeenCalled();
        expect(onSetAttachments).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: too many files, refused the moment they were chosen, is still the alert they answer', async () => {
        h.upload = async f => ({ href: f.name, name: f.name });
        render([task(1, 'Buy milk')]);
        await choose('Buy milk', Array.from({ length: 50 }, (_, i) => file(`${i}.png`)));
        expect(alertSpy).toHaveBeenCalledTimes(1);
        expect(toasts).toEqual([]);
    });
});
