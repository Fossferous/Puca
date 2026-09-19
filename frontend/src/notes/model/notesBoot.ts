/**
 * What Notes' entry point starts for offline use, in one call (main.tsx):
 * put the sealed on-device cache back into the query client, ask the browser
 * to keep that storage, and register the web-only offline worker.
 *
 * Deliberately NOT awaited before the first render: the page never waits on
 * IndexedDB. Online, the network usually wins and hydration skips what is
 * already there; offline, the fetches fail fast and the cached copy fills the
 * grid a moment later, under the "showing what was loaded last" banner.
 */
import type { QueryClient } from '@tanstack/react-query';
import { isMobile } from '../../api/platform';
import { hydrateNotesCache, requestPersistentStorage } from './notesCache';
import { registerNotesServiceWorker } from '../sw/registerNotesSw';

export async function bootNotesOffline(qc: QueryClient): Promise<void> {
    try {
        registerNotesServiceWorker();
        if (!isMobile()) requestPersistentStorage();
        await hydrateNotesCache(qc);
    } catch (err) {
        console.warn('[notes] offline cache unavailable:', err);
    }
}
