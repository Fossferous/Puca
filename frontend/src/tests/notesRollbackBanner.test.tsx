/**
 * A refused rollback (a restored server backup, usually) is not a dead end:
 * the banner offers both ways out and says what each does, and each button
 * runs the engine operation the engine tests pin (notesPrefsSync.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../notes/model/notesPrefsSync', async (orig) => ({
    ...(await orig<typeof import('../notes/model/notesPrefsSync')>()),
    acceptServerNotesPrefs: vi.fn(),
    overwriteServerNotesPrefs: vi.fn(),
}));

import { acceptServerNotesPrefs, overwriteServerNotesPrefs, type PrefsSyncStatus } from '../notes/model/notesPrefsSync';
import { PrefsSyncBanner } from '../notes/components/SyncBanners';

let root: Root | null = null;
function render(status: PrefsSyncStatus): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<PrefsSyncBanner status={status} />); });
    return host;
}
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; vi.clearAllMocks(); });

describe('the rollback banner', () => {
    it('offers "use the server’s copy" and "keep this device’s", each wired to its operation', () => {
        const host = render('rollback');
        const accept = host.querySelector<HTMLButtonElement>('[data-sync="rollback"] button[data-action="accept-server"]');
        const keep = host.querySelector<HTMLButtonElement>('[data-sync="rollback"] button[data-action="keep-mine"]');
        expect(accept?.textContent).toMatch(/server/i);
        expect(keep?.textContent).toMatch(/this device/i);
        // It says what each choice does, not only that something is wrong.
        expect(host.textContent).toMatch(/replaces this device’s/);
        expect(host.textContent).toMatch(/replaces the server’s/);
        act(() => { accept!.click(); });
        expect(acceptServerNotesPrefs).toHaveBeenCalledTimes(1);
        expect(overwriteServerNotesPrefs).not.toHaveBeenCalled();
        act(() => { keep!.click(); });
        expect(overwriteServerNotesPrefs).toHaveBeenCalledTimes(1);
    });

    it('positive control: nothing is shown while syncing is fine', () => {
        const host = render('synced');
        expect(host.querySelector('[data-sync]')).toBeNull();
    });
});
