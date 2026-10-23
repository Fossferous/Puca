// @vitest-environment jsdom
/**
 * api/notesLink.ts: the "Open in Púca Notes" link in the Tasks view. It must be
 * absent wherever following it would replace the app you are in: the desktop and
 * Android shells (another origin) and, since the iPhone Home Screen app, that too
 * (a standalone window has no second window, so a target=_blank link navigates
 * the app itself and drops its socket and any live call).
 *
 * Positive control: the plain browser case returns the link, so a function that
 * returned null for everyone cannot pass the rest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const platform = vi.hoisted(() => ({ tauri: false, mobile: false }));
vi.mock('../api/platform', () => ({ isTauri: () => platform.tauri, isMobile: () => platform.mobile }));

import { notesUrl } from '../api/notesLink';

const setStandalone = (v: boolean | undefined) => {
    if (v === undefined) delete (navigator as unknown as Record<string, unknown>).standalone;
    else Object.defineProperty(navigator, 'standalone', { value: v, configurable: true });
};

beforeEach(() => { platform.tauri = false; platform.mobile = false; setStandalone(undefined); });
afterEach(() => setStandalone(undefined));

describe('notesUrl', () => {
    it('POSITIVE CONTROL: a browser tab gets the link, naming the file', () => {
        expect(notesUrl()).toBe(`${window.location.origin}/notes/index.html`);
        setStandalone(false); // Safari tab on an iPhone
        expect(notesUrl()).toBe(`${window.location.origin}/notes/index.html`);
    });
    it('the desktop and Android apps get none', () => {
        platform.tauri = true;
        expect(notesUrl()).toBeNull();
        platform.tauri = false;
        platform.mobile = true;
        expect(notesUrl()).toBeNull();
    });
    it('an iPhone or iPad Home Screen app gets none', () => {
        setStandalone(true);
        expect(notesUrl()).toBeNull();
    });
});
