// @vitest-environment jsdom
/**
 * A picture added to a note with no connection ("Not sent yet": its ref is
 * `puca-parked:`, its ciphertext only on this device) is decrypted only while
 * something shows it, and a sign-out takes its plaintext URL away.
 *
 * Its plaintext URL used to be a page Blob cached per parked id until the
 * picture uploaded or the account signed out: decrypted the whole time a
 * note waited for a connection, shown or not, which in Chromium means on
 * disk (blob_storage) under memory pressure. Now each component that shows
 * one holds it (useHeldParkedUrl, api/parkedPreview.ts), the holders share
 * one URL, and the last to let go releases it. jsdom has no Worker, so the
 * URL is made on the page (api/plaintextHost.ts's fallback) and released by
 * revoking it: what is counted here. The real disk is measured by
 * e2e/plaintext-disk-real-browser.mjs.
 *
 * Signing out: a parked picture's CIPHERTEXT goes with the account's
 * database, which `logout()` deletes; its PLAINTEXT URL lives in the
 * document, and Púca Notes' sign-out does not reload the page, so the
 * cleanup registered through api/logoutHooks.ts is what takes it away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { logout } from '../api/auth';
import { acquireParkedUrl, parkedPreviewStats, setParkedReader, clearParkedPreviews } from '../api/parkedPreview';
import { parkedHref, bytesToB64 } from '../api/parkedMedia';
import { NoteImages } from '../components/NoteImages';
import { NoteHero } from '../notes/components/NoteCardContent';
import { galleryItems } from '../api/noteMedia';

const href = parkedHref('photo-1', 'image/jpeg');
const sidecar = JSON.stringify([{ href, name: 'photo.jpg' }]);
const PLAIN = new TextEncoder().encode('PLAINTEXT-OF-A-PARKED-PHOTO');

let made: string[] = [];
let revoked: string[] = [];
let reads = 0;
let sealedRecord: { data: string; key: string; mime: string };
let container: HTMLDivElement;
let root: Root;

const settle = async () => {
    await act(async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); });
};
const live = () => made.filter(u => !revoked.includes(u));

beforeEach(async () => {
    made = []; revoked = []; reads = 0;
    clearParkedPreviews();
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { const u = `blob:parked-${made.length + 1}`; made.push(u); return u; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });
    // A sealed record exactly as notesBlobs.ts stores one: nonce || AES-GCM, base64; key base64url.
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, PLAIN));
    const sealed = new Uint8Array(12 + ct.length); sealed.set(nonce); sealed.set(ct, 12);
    const rec = { data: bytesToB64(sealed), key: bytesToB64(keyBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), mime: 'image/jpeg' };
    sealedRecord = rec;
    setParkedReader(async () => { reads++; return rec; });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    clearParkedPreviews();
    vi.restoreAllMocks();
});

describe('a parked picture is decrypted only while something shows it', () => {
    it('shown in the editor: one URL; the editor closed: it is let go at once', async () => {
        await act(async () => { root.render(<NoteImages opened={sidecar} editable={false} />); });
        await settle();
        const img = container.querySelector('img');
        expect(img?.getAttribute('src'), 'the picture is shown from its decrypted copy').toBe('blob:parked-1');
        expect(live()).toEqual(['blob:parked-1']);
        await act(async () => { root.render(<div />); });
        expect(revoked, 'nothing shows it any more: its plaintext URL goes').toEqual(['blob:parked-1']);
    });

    it('a card and the editor share one decrypted copy, which goes only when both stop', async () => {
        const items = galleryItems(sidecar);
        const both = (card: boolean, editor: boolean) => (
            <>
                {card && <NoteHero items={items} visible />}
                {editor && <NoteImages opened={sidecar} editable={false} />}
            </>
        );
        await act(async () => { root.render(both(true, true)); });
        await settle();
        const srcs = [...container.querySelectorAll('img')].map(i => i.getAttribute('src'));
        expect(srcs).toEqual(['blob:parked-1', 'blob:parked-1']);
        expect(made, 'decrypted once for both').toEqual(['blob:parked-1']);
        expect(reads).toBe(1);
        await act(async () => { root.render(both(true, false)); });
        expect(revoked, 'the card still shows it').toEqual([]);
        await act(async () => { root.render(both(false, false)); });
        expect(revoked).toEqual(['blob:parked-1']);
        // Shown again: decrypted again from the sealed copy.
        await act(async () => { root.render(both(false, true)); });
        await settle();
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:parked-2');
        expect(reads).toBe(2);
    });

    it('a record that goes (uploaded) takes its URL with it, and a later hold gets nothing', async () => {
        const hold = await acquireParkedUrl(href);
        expect(hold?.url).toBe('blob:parked-1');
        const { revokeParkedPreviews } = await import('../api/parkedPreview');
        revokeParkedPreviews(['photo-1']);
        expect(revoked).toEqual(['blob:parked-1']);
        hold!.release(); // a holder letting go afterwards changes nothing
        expect(revoked).toEqual(['blob:parked-1']);
        setParkedReader(async () => null);
        expect(await acquireParkedUrl(href), 'the bytes are gone').toBeNull();
        expect(parkedPreviewStats().entries).toBe(0);
    });

    it('let go while it was still opening: nothing is left hosted', async () => {
        let open!: () => void;
        const gate = new Promise<void>(r => { open = r; });
        setParkedReader(async () => { await gate; return sealedRecord; });
        await act(async () => { root.render(<NoteImages opened={sidecar} editable={false} />); });
        await act(async () => { root.render(<div />); });
        open();
        await settle();
        expect(made, 'control: it was opened after all').toEqual(['blob:parked-1']);
        expect(live(), 'and let go as soon as it landed').toEqual([]);
        expect(parkedPreviewStats()).toEqual({ entries: 0, hosted: 0 });
    });
});

describe('a sign-out takes a parked picture’s decrypted preview away', () => {
    it('the URL is released while it is still shown, and the picture is decrypted again rather than handed back', async () => {
        const hold = await acquireParkedUrl(href);
        expect(hold?.url).toBe('blob:parked-1');
        // Positive control: while held it is shared, so a second ask is the SAME url.
        const again = await acquireParkedUrl(href);
        expect(again?.url).toBe('blob:parked-1');
        expect(reads).toBe(1);

        logout();

        expect(revoked).toContain('blob:parked-1');
        // ...and nothing holds it any more: the next ask decrypts afresh.
        const next = await acquireParkedUrl(href);
        expect(next?.url).toBe('blob:parked-2');
        expect(reads).toBe(2);
        hold!.release(); again!.release(); next!.release();
    });
});
