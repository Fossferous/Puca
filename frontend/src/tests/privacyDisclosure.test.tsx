/**
 * The in-app privacy disclosure names the three things the clients really do
 * send beyond the user's own server — the FCM wake signal, background
 * location's existence, all-files access — and states the no-telemetry
 * claim beside them, with a link to the long-form statement resolved from
 * the server's own GET /source.
 *
 * Pinned as text because the value of the page IS the text: a rewrite that
 * dropped one of the exceptions would turn an accurate notice into an
 * overstated one, which is worse than none.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({ get: vi.fn<(path: string) => Promise<unknown>>() }));
vi.mock('../api/client', () => ({ apiClient: { get: (p: string) => h.get(p) } }));

import { PrivacyDisclosure } from '../components/PrivacyDisclosure';
import { privacyDocUrl } from '../components/privacyDisclosure.utils';
import { AccountExportCard } from '../components/AccountExportCard';
import { resultSummary } from '../api/accountExport';

let container: HTMLDivElement;
let root: Root;

async function mount(el: React.ReactElement): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
        root = createRoot(container);
        root.render(el);
    });
    await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    h.get.mockReset();
    h.get.mockResolvedValue({ repository: 'https://github.com/example/puca-fork', commit: 'abc', license: 'AGPL-3.0-or-later' });
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove();
});

describe('PrivacyDisclosure', () => {
    it('states no telemetry AND the three real disclosures, in one place', async () => {
        await mount(<PrivacyDisclosure />);
        const text = container.textContent ?? '';
        expect(text).toContain('No analytics, no crash reporting');
        // The exceptions, in the same breath — a claim without them overstates.
        expect(text).toContain('{"w":"1"}');            // the FCM wake signal, and its whole body
        expect(text).toContain('Location reminders');   // background location exists, and stays local
        expect(text).toContain('All files access');     // and what the storage grant is for
        // The update checks name where they go: the operator's hosts, not a central one.
        expect(text).toMatch(/\/app-version/);
        expect(text).toMatch(/\/api\/mobile-updates\/check/);
        // The one third-party STUN case is stated, not hidden.
        expect(text).toMatch(/Google’s public STUN servers as a last resort/);
        // Browser voice honesty (CMP-01) is consistent with Voice & Video.
        expect(text).toMatch(/Firefox, Safari and iOS, media is blocked by default/);
    });

    it('links the long-form statement in the repository GET /source names', async () => {
        await mount(<PrivacyDisclosure />);
        const a = container.querySelector('a[href*="PRIVACY.md"]') as HTMLAnchorElement | null;
        expect(a, 'the docs link must render').toBeTruthy();
        expect(a!.getAttribute('href')).toBe('https://github.com/example/puca-fork/blob/main/docs/PRIVACY.md');
        expect(a!.getAttribute('rel')).toContain('noopener');
        expect(h.get).toHaveBeenCalledWith('/source');
    });

    it('falls back to the published repository when /source cannot be read', async () => {
        h.get.mockRejectedValue(new Error('offline'));
        await mount(<PrivacyDisclosure />);
        const a = container.querySelector('a[href*="PRIVACY.md"]') as HTMLAnchorElement | null;
        expect(a!.getAttribute('href')).toBe('https://github.com/Fossferous/Puca/blob/main/docs/PRIVACY.md');
    });
});

describe('privacyDocUrl', () => {
    it('builds a blob link for a forge URL and leaves an unknown host at its root', () => {
        expect(privacyDocUrl('https://github.com/x/y/')).toBe('https://github.com/x/y/blob/main/docs/PRIVACY.md');
        expect(privacyDocUrl('https://github.com/x/y.git')).toBe('https://github.com/x/y/blob/main/docs/PRIVACY.md');
        expect(privacyDocUrl('https://code.example.org/puca')).toBe('https://code.example.org/puca');
        expect(privacyDocUrl(null)).toBe('https://github.com/Fossferous/Puca/blob/main/docs/PRIVACY.md');
    });
});

describe('AccountExportCard', () => {
    it('says plainly that the file is plaintext and that other people’s messages are not in it', async () => {
        await mount(<AccountExportCard username="alice" />);
        const text = container.textContent ?? '';
        expect(text).toMatch(/readable plaintext/);
        expect(text).toMatch(/Other people’s messages are not included/);
        expect(container.querySelector('button')?.textContent).toBe('Export my data');
    });

    it('the result line counts what this device could actually read', () => {
        expect(resultSummary('C:/dl/puca-export.json', true, { sealed: 3, opened: 2, unreadable: 1 }))
            .toBe('Saved to C:/dl/puca-export.json. 2 of 3 encrypted items could be read on this device; 1 is included as ciphertext only.');
        expect(resultSummary('puca-export.json', false, { sealed: 1, opened: 1, unreadable: 0 }))
            .toBe('Downloaded as puca-export.json. 1 of 1 encrypted item could be read on this device.');
        expect(resultSummary('x.json', true, { sealed: 0, opened: 0, unreadable: 0 }))
            .toBe('Saved to x.json. Nothing in it was encrypted.');
    });
});
