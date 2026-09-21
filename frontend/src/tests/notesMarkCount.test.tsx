/**
 * The open note's "n of m" bar must count the marks its arrows can REACH.
 *
 * The count used to come from the model (findRanges over the note's items),
 * which is right on the first render and then drifts: TaskTree's Completed
 * section unmounts its rows when collapsed, taking their marks with it, while
 * the model still counted them — "3 of 9" over a list of four, with prev/next
 * cycling a shorter list than the label promised.
 *
 * The drift is only reproducible when the marks disappear WITHOUT the counting
 * component re-rendering, which is exactly what a child's own state does. Each
 * test here therefore toggles the marks from inside a child.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useMarkCount } from '../notes/components/useMarkCount';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** A section that hides its own marks, like TaskTree's Completed section:
 *  its state changes re-render IT, never the component doing the counting. */
function Collapsible() {
    const [open, setOpen] = useState(true);
    return (
        <div>
            <button type="button" onClick={() => setOpen(o => !o)}>toggle</button>
            {open && <mark className="notes-hl">done</mark>}
            {open && <mark className="notes-hl">done too</mark>}
        </div>
    );
}

function Harness({ active }: { active: boolean }) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const count = useMarkCount(bodyRef, active);
    return (
        <>
            <span id="count">{count}</span>
            <div ref={bodyRef}>
                <mark className="notes-hl">open item</mark>
                <Collapsible />
            </div>
        </>
    );
}

const shown = () => document.querySelector('#count')!.textContent;
const marks = () => document.querySelectorAll('mark.notes-hl').length;

async function mount(active = true) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness active={active} />); });
}
async function toggle() {
    const btn = document.querySelector('button')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // The observer reports on a microtask; one more turn lets the recount land.
    await act(async () => { await Promise.resolve(); });
}

describe('useMarkCount', () => {
    afterEach(() => {
        act(() => { root?.unmount(); });
        host?.remove();
        root = null;
        host = null;
    });

    it('counts the marks in the DOM on the first render, before paint', async () => {
        await mount();
        expect(marks()).toBe(3);
        expect(shown()).toBe('3');
    });

    it('follows marks that a CHILD unmounts without re-rendering the counter', async () => {
        await mount();
        await toggle();
        expect(marks()).toBe(1);
        expect(shown()).toBe('1');      // the model would still have said 3
    });

    it('follows them back when the section reopens', async () => {
        await mount();
        await toggle();
        await toggle();
        expect(marks()).toBe(3);
        expect(shown()).toBe('3');
    });

    it('POSITIVE CONTROL: inactive (no query) is zero however many marks exist', async () => {
        await mount(false);
        expect(marks()).toBe(3);
        expect(shown()).toBe('0');
    });
});
