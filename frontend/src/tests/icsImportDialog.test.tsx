/**
 * The .ics import dialog’s target picker.
 *
 * A note whose items this device has not read yet is indistinguishable from
 * an empty one by count alone — and importing into it would dedupe against
 * nothing (a second run of the same file duplicates every event) and count
 * the per-list cap from zero. So the picker marks it, refuses to start on it,
 * and says why.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IcsImportDialog, type ImportTargetOption } from '../components/calendar/IcsImportDialog';
import { type IcsParseResult } from '../api/ics';
import { type ImportIO } from '../api/icsImport';

const parsed: IcsParseResult = {
    calName: 'Trip',
    notes: [],
    items: [{
        kind: 'event', uid: 'uid-1', summary: 'Ferry', notes: [],
        schedule: { v: 1, kind: 'event', uid: 'uid-1', allDay: true, start: '2026-10-05', alertTz: 'UTC', alerts: [-540] },
    }],
};

const target = (over: Partial<ImportTargetOption> = {}): ImportTargetOption => ({
    listId: 1, title: 'Trips', count: 0, uids: new Set<string>(), loaded: true, ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null; host = null;
});

function open(targets: ImportTargetOption[]) {
    const io: ImportIO = {
        createList: vi.fn(async () => ({ id: 50 })),
        createTask: vi.fn(async () => ({ id: 51 })),
        sleep: vi.fn(async () => {}),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <IcsImportDialog fileName="trip.ics" parsed={parsed} targets={targets} io={io} onClose={() => {}} onImported={() => {}} />,
    ));
    const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Import into"]')!;
    const pick = (value: string) => act(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const importBtn = () => [...document.body.querySelectorAll<HTMLButtonElement>('.ics-actions button')].find(b => b.textContent?.startsWith('Import'))!;
    return { io, select, pick, importBtn };
}

describe('the .ics import picker waits for a note it has not read', () => {
    it('marks it, disables its option, and will not start on it', async () => {
        const d = open([target({ loaded: false })]);
        const opt = d.select.querySelector<HTMLOptionElement>('option[value="1"]')!;
        expect(opt.disabled).toBe(true);
        expect(opt.textContent).toMatch(/still loading/i);
        d.pick('1');
        expect(d.importBtn().disabled).toBe(true);
        expect(document.body.textContent).toMatch(/Still reading what that note already holds/);
        // Even if the button is reached anyway, nothing is written.
        await act(async () => { d.importBtn().click(); });
        expect(d.io.createTask).not.toHaveBeenCalled();
        expect(d.io.createList).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: the same note, once read, imports', async () => {
        const d = open([target({ loaded: true })]);
        expect(d.select.querySelector<HTMLOptionElement>('option[value="1"]')!.disabled).toBe(false);
        d.pick('1');
        expect(d.importBtn().disabled).toBe(false);
        await act(async () => { d.importBtn().click(); });
        expect(d.io.createList).not.toHaveBeenCalled();
        expect(d.io.createTask).toHaveBeenCalledTimes(1);
    });

    it('a new note is never "not read": the default target still imports', async () => {
        const d = open([target({ loaded: false })]);
        expect(d.importBtn().disabled).toBe(false);
        await act(async () => { d.importBtn().click(); });
        expect(d.io.createList).toHaveBeenCalledTimes(1);
        expect(d.io.createTask).toHaveBeenCalledTimes(1);
    });
});
