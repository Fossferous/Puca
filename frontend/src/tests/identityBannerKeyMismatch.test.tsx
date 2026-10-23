/**
 * IdentityBanner's F-3 wording: when the sign-in check refused the key (the
 * server publishes a different one for this account), the banner says THAT,
 * not "keys unavailable" — the remedy is the server's owner, not a retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const state = vi.hoisted(() => ({ reason: null as null | 'key-mismatch' }));
vi.mock('../api/auth', () => ({
    identityRestoreFailed: () => true,
    identityRestoreReason: () => state.reason,
    onIdentityRestoreChange: () => () => {},
    retryIdentityRestore: vi.fn(async () => {}),
}));

import { IdentityBanner } from '../components/IdentityBanner';

let root: Root | null = null;
let host: HTMLDivElement;

function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
        root = createRoot(host);
        root.render(<IdentityBanner onSignOut={() => {}} />);
    });
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    state.reason = null;
});

describe('IdentityBanner', () => {
    it('a key the server does not publish for you is named as such', () => {
        state.reason = 'key-mismatch';
        mount();
        const text = host.textContent ?? '';
        expect(text).toContain('not the one this server publishes for you');
        expect(text).toContain("tell the server's owner");
        expect(text).not.toContain('Encryption keys unavailable');
    });

    it('CONTROL: any other failure keeps the "keys unavailable" wording', () => {
        mount();
        expect(host.textContent).toContain('Encryption keys unavailable');
    });
});
