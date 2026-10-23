/**
 * Audit 2026-10, F-5: the safety-number screen says when the key it shows is
 * not the one this device pinned for that person on first contact.
 *
 * DMs and channel keys refuse a served key that conflicts with the pin and
 * tell the person to "verify their safety number" — and this screen showed
 * the NEW key's number with no warning at all (its `changed` badge only ever
 * covered a key the person had verified), with a "mark verified" button that
 * moves the pin to it. Comparing the number out of band still caught a swap;
 * the screen just did not say what the device already knew.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const served = vi.hoisted(() => ({ key: null as string | null }));
vi.mock('../api/dms', () => ({ getCachedPublicKey: async () => served.key }));

import { setActiveIdentity } from '../api/e2ee';
import { pinServedIdentityKey } from '../api/keyVerification';
import { SafetyNumberModal } from '../components/SafetyNumberModal';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['me', 'a1'.repeat(16)] as const;
const OLD = ['old', 'b2'.repeat(16)] as const;
const NEW = ['new', 'c3'.repeat(16)] as const;
beforeAll(() => warmIdentities([ME, OLD, NEW]), WARM_TIMEOUT_MS);

// setup.ts's localStorage never reads back; the pin store must.
const memStore = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
        setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
        removeItem: (k: string) => { memStore.delete(k); },
        clear: () => { memStore.clear(); },
        key: (i: number) => [...memStore.keys()][i] ?? null,
        get length() { return memStore.size; },
    },
});

let root: Root | null = null;
let host: HTMLDivElement;

async function mount(userId: number) {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
        root = createRoot(host);
        root.render(<SafetyNumberModal userId={userId} username="sam" onClose={() => {}} />);
    });
    // The effect awaits the (mocked) key lookup: let it land.
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
});

describe('SafetyNumberModal and a TOFU-pin conflict', () => {
    it('warns when the key shown is not the one this device pinned', async () => {
        setActiveIdentity(await testIdentity(...ME));
        pinServedIdentityKey(7, (await testIdentity(...OLD)).publicKeyEncoded); // first contact
        served.key = (await testIdentity(...NEW)).publicKeyEncoded;              // what the server serves now

        await mount(7);

        expect(host.querySelector('[data-testid="safety-pin-conflict"]')?.textContent)
            .toContain('not the key this device has been using for sam');
        expect(host.textContent).toContain('They match — trust this new key');
    });

    it('CONTROL: no warning when the served key is the pinned one, or nothing is pinned yet', async () => {
        setActiveIdentity(await testIdentity(...ME));
        served.key = (await testIdentity(...NEW)).publicKeyEncoded;
        await mount(8); // nothing pinned for 8

        expect(host.querySelector('[data-testid="safety-pin-conflict"]')).toBeNull();
        expect(host.textContent).toContain('They match — mark verified');
    });

    it('confirming the new key clears the warning', async () => {
        setActiveIdentity(await testIdentity(...ME));
        pinServedIdentityKey(9, (await testIdentity(...OLD)).publicKeyEncoded);
        served.key = (await testIdentity(...NEW)).publicKeyEncoded;
        await mount(9);

        const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('trust this new key'));
        act(() => button!.click());

        expect(host.querySelector('[data-testid="safety-pin-conflict"]')).toBeNull();
        expect(host.textContent).toContain('Verified');
    });
});
