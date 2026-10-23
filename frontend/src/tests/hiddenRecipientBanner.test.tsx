/**
 * The F-2 notice: when channelKeys.ts refuses to give a channel's key to an
 * id the server listed for it that is not in the member list people see,
 * the person is told which channel, and in which server. The refusal is
 * channelKeys.test.ts / channelKeysWrapSetVisibility.test.ts; this is only
 * what reaches the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HiddenRecipientNotice } from '../api/channelKeys';

const state = vi.hoisted(() => ({
    notices: [] as HiddenRecipientNotice[],
    listener: null as null | (() => void),
}));
vi.mock('../api/channelKeys', () => ({
    hiddenRecipientNotices: () => state.notices,
    onHiddenRecipientsChange: (cb: () => void) => { state.listener = cb; return () => { state.listener = null; }; },
}));

import { HiddenRecipientBanner } from '../components/HiddenRecipientBanner';

const general: HiddenRecipientNotice = { channelId: 42, serverId: 's1', channelName: 'general', serverName: 'Home', userIds: [99] };

let root: Root | null = null;
let host: HTMLDivElement;

function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
        root = createRoot(host);
        root.render(<HiddenRecipientBanner />);
    });
}
const banner = () => host.querySelector('[data-testid="hidden-recipient-banner"]');
const tell = () => act(() => state.listener?.());

beforeEach(() => {
    state.notices = [];
    state.listener = null;
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
});

describe('HiddenRecipientBanner', () => {
    it('shows nothing while nothing was refused', () => {
        mount();
        expect(banner()).toBeNull();
    });

    it('names the channel and the server, and says the key was not given', () => {
        state.notices = [general];
        mount();
        expect(banner()?.textContent).toContain('#general in Home');
        expect(banner()?.textContent).toContain("did not give them the channel's key");
        expect(banner()?.getAttribute('role')).toBe('alert');
    });

    it('appears when a refusal happens while it is mounted', () => {
        mount();
        expect(banner()).toBeNull();
        state.notices = [general];
        tell();
        expect(banner()?.textContent).toContain('#general');
    });

    it('a dismissed notice stays dismissed, and comes back when the refusal grows', () => {
        state.notices = [general];
        mount();
        act(() => (host.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click());
        expect(banner()).toBeNull();
        tell();
        expect(banner()).toBeNull();
        state.notices = [{ ...general, userIds: [99, 100] }];
        tell();
        expect(banner()?.textContent).toContain('2 people who are not members');
    });

    it('names the other channels too, and falls back to the id for a channel it has no name for', () => {
        state.notices = [general, { channelId: 77, serverId: 's2', channelName: null, serverName: null, userIds: [5] }];
        mount();
        expect(banner()?.textContent).toContain('one other channel: a channel (id 77)');
    });
});
