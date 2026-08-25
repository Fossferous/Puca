/**
 * A SETTING NEEDS ITS UI IN THE SAME CHANGE.
 *
 * This repo has shipped stored values with no control that changes them more
 * than once (the tray toggle among them), which produces a feature nobody can
 * use and a preference nobody can turn off. "Zoom to the text cursor while
 * typing" defaults ON and takes over the viewport while someone types, so the
 * off switch is not optional — and the only place it can live is this sheet:
 * every control inside the keyboard overlay must re-focus the hidden field or
 * Android closes the soft keyboard, and a checkbox that dismisses the keyboard is
 * worse than a slightly misfiled one.
 *
 * The assertions on the EXISTING follow-cursor row are the positive control that
 * this rig can see a checkbox at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/devices/session', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/devices/session')>();
    return { ...real, requestMonitor: vi.fn(), setPrivacyMode: vi.fn(), sendInput: vi.fn() };
});

const { MouseMenu } = await import('../components/DeviceStageMobileMenus');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const setFollowCaret = vi.fn();
const setFollowCursor = vi.fn();
const setAutoKeyboard = vi.fn();

async function mount(over: { followCaret?: boolean; followCursor?: boolean; autoKeyboard?: boolean } = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <MouseMenu
                isMouseMode
                setMouseMode={() => {}}
                showVirtualMouse={false}
                setShowVirtualMouse={() => {}}
                followCursor={over.followCursor ?? true}
                setFollowCursor={setFollowCursor}
                followCaret={over.followCaret ?? true}
                setFollowCaret={setFollowCaret}
                autoKeyboard={over.autoKeyboard ?? true}
                setAutoKeyboard={setAutoKeyboard}
                onCopyDiagnostics={() => {}}
            />,
        );
    });
}

/** The row whose label text contains `text`, and its checkbox. */
function row(text: string): { label: HTMLLabelElement; box: HTMLInputElement } {
    const label = [...host!.querySelectorAll('label')].find(l => l.textContent?.includes(text));
    expect(label, `no row labelled "${text}"`).toBeTruthy();
    const box = label!.querySelector<HTMLInputElement>('input[type=checkbox]');
    expect(box, `the "${text}" row has no checkbox`).toBeTruthy();
    return { label: label as HTMLLabelElement, box: box! };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('the caret-follow toggle', () => {
    it('exists, with the exact label the feature is described by', async () => {
        await mount();
        // POSITIVE CONTROL: the row above it, which shipped long ago.
        expect(row('Follow the cursor while zoomed').box.checked).toBe(true);
        expect(row('Zoom to the text cursor while typing').box.checked).toBe(true);
    });

    it('reflects the stored preference rather than a local guess', async () => {
        await mount({ followCaret: false, followCursor: true });
        expect(row('Zoom to the text cursor while typing').box.checked).toBe(false);
        expect(row('Follow the cursor while zoomed').box.checked).toBe(true);
    });

    it('reports a click to the setter that remembers it', async () => {
        await mount({ followCaret: true });
        await act(async () => { row('Zoom to the text cursor while typing').box.click(); });
        expect(setFollowCaret).toHaveBeenCalledWith(false);
        expect(setFollowCursor, 'and does not touch the row above').not.toHaveBeenCalled();
    });

    it('turns back on from off', async () => {
        await mount({ followCaret: false });
        await act(async () => { row('Zoom to the text cursor while typing').box.click(); });
        expect(setFollowCaret).toHaveBeenCalledWith(true);
    });

    it('sits directly under the other camera setting', async () => {
        await mount();
        const labels = [...host!.querySelectorAll('label')].map(l => l.textContent ?? '');
        const cursor = labels.findIndex(t => t.includes('Follow the cursor while zoomed'));
        const caret = labels.findIndex(t => t.includes('Zoom to the text cursor while typing'));
        expect(cursor).toBeGreaterThanOrEqual(0);
        expect(caret, 'the two camera settings belong together').toBe(cursor + 1);
    });
});

// The auto-keyboard is the other decision made FOR the user over the remote
// caret (deviceAutoKeyboard.ts), defaults ON, and opens a keyboard over the
// picture — so its off switch is not optional either, and it lives here for
// the same reason the caret-follow one does.
describe('the auto-keyboard toggle', () => {
    const LABEL = 'Open the keyboard when a text box is tapped';

    it('exists, checked by default, under the caret-follow row', async () => {
        await mount();
        expect(row(LABEL).box.checked).toBe(true);
        const labels = [...host!.querySelectorAll('label')].map(l => l.textContent ?? '');
        const caret = labels.findIndex(t => t.includes('Zoom to the text cursor while typing'));
        expect(labels.findIndex(t => t.includes(LABEL)), 'the two keyboard settings belong together')
            .toBe(caret + 1);
    });

    it('reflects the stored preference', async () => {
        await mount({ autoKeyboard: false });
        expect(row(LABEL).box.checked).toBe(false);
        // Positive control: the neighbouring row is unaffected.
        expect(row('Zoom to the text cursor while typing').box.checked).toBe(true);
    });

    it('reports a click to the setter that remembers it, and only to it', async () => {
        await mount({ autoKeyboard: true });
        await act(async () => { row(LABEL).box.click(); });
        expect(setAutoKeyboard).toHaveBeenCalledWith(false);
        expect(setFollowCaret).not.toHaveBeenCalled();
        expect(setFollowCursor).not.toHaveBeenCalled();
    });
});
