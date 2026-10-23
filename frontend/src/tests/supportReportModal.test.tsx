import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Server } from '../api/servers';

const send = vi.fn<(ownerId: number, note: string, signal?: AbortSignal) => Promise<number>>();
vi.mock('../api/supportReport', async (orig) => ({
    ...(await orig<typeof import('../api/supportReport')>()),
    sendSupportReport: (ownerId: number, note: string, _deps?: unknown, opts?: { signal?: AbortSignal }) => send(ownerId, note, opts?.signal),
}));

import { SupportReportModal } from '../components/SupportReportModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const srv = (id: string, name: string, owner_id: number): Server =>
    ({ id, name, owner_id, created_at: '2026-01-01T00:00:00Z' });

let host: HTMLDivElement;
let root: Root;

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const checked = () => radios().filter(r => r.getAttribute('aria-checked') === 'true');
const sendButton = () => [...host.querySelectorAll('button')].find(b => /Send report|Measuring/.test(b.textContent ?? ''))!;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

function show(servers: Server[], me: number, preferred?: string, onClose: () => void = () => {}) {
    act(() => { root.render(<SupportReportModal servers={servers} currentUserId={me} preferredServerId={preferred} onClose={onClose} />); });
}
const closeButton = () => host.querySelector<HTMLButtonElement>('button[title="Close"]')!;

describe('SupportReportModal', () => {
    beforeEach(() => {
        send.mockReset();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('a server list that arrives after opening still has an owner picked', () => {
        show([], 1, 'b');
        expect(host.textContent).toContain('not in any server');
        show([srv('a', 'Alpha', 5), srv('b', 'Bravo', 6)], 1, 'b');
        expect(checked().map(r => r.textContent)).toEqual(['BThe owner of Bravo']);
        expect(sendButton().disabled).toBe(false);
    });

    it('sends to the picked owner with the note, then says where it went', async () => {
        send.mockResolvedValue(3 * 1024 * 1024);
        show([srv('a', 'Alpha', 5), srv('b', 'Bravo', 6)], 1);
        act(() => { radios().find(r => r.textContent?.includes('Bravo'))!.click(); });
        expect(checked().map(r => r.textContent)).toEqual(['BThe owner of Bravo']);
        const note = host.querySelector('textarea')!;
        act(() => {
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            set.call(note, 'stream froze');
            note.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => { sendButton().click(); });
        await flush();
        expect(send).toHaveBeenCalledWith(6, 'stream froze', expect.any(AbortSignal));
        expect(host.textContent).toContain('Sent to the owner of Bravo (3.0 MB)');
    });

    it('a failed send stays open and says why', async () => {
        send.mockRejectedValue(new Error('File too large'));
        show([srv('a', 'Alpha', 5)], 1);
        act(() => { sendButton().click(); });
        await flush();
        expect(host.textContent).toContain('Could not send the report: File too large');
        expect(sendButton().disabled).toBe(false);
    });

    it('Close always works, also while a send is stuck, and it cancels that send', async () => {
        send.mockImplementation(() => new Promise<number>(() => {}));
        const onClose = vi.fn();
        show([srv('a', 'Alpha', 5)], 1, undefined, onClose);
        act(() => { sendButton().click(); });
        await flush();
        expect(sendButton().textContent).toContain('Measuring');
        const signal = send.mock.calls[0][2]!;
        expect(signal.aborted).toBe(false);
        expect(closeButton().disabled).toBe(false);
        act(() => { closeButton().click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        // The overlay dismisses it too.
        act(() => { host.querySelector<HTMLElement>('.forward-modal-overlay')!.click(); });
        expect(onClose).toHaveBeenCalledTimes(2);
        // Leaving the page (the dialog unmounting) is what cancels the send.
        act(() => root.render(<div />));
        expect(signal.aborted).toBe(true);
    });

    it('a send that times out says so and leaves the dialog usable', async () => {
        send.mockRejectedValue(new Error('The upload gave no answer within 61 s'));
        show([srv('a', 'Alpha', 5)], 1);
        act(() => { sendButton().click(); });
        await flush();
        expect(host.textContent).toContain('Could not send the report: The upload gave no answer within 61 s');
        expect(closeButton().disabled).toBe(false);
        expect(sendButton().disabled).toBe(false);
    });

    it('your own server is labelled as yours', () => {
        show([srv('a', 'Alpha', 1)], 1);
        expect(radios().map(r => r.textContent)).toEqual(['AYou (owner of Alpha)']);
    });
});
