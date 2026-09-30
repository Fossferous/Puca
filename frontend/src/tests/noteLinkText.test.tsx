/**
 * The one renderer both front doors use for a note's links (NoteLinkText).
 *
 * The case that matters most is the last one: rendering a link must make ZERO
 * network calls. api/linkPreview.ts records why the favicon and thumbnail
 * fetches were deleted for chat — a render told a third party the hostname,
 * the reader's IP and the moment of reading — and for a note, which the
 * server itself cannot read, it would announce that someone is reading THIS
 * note right now. This is the test a future "just a small site icon" has to
 * get past.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/openExternal', () => ({ openExternalUrl: vi.fn(), isExternalHref: () => true }));

import { NoteLinkText } from '../components/NoteLinkText';
import { openExternalUrl } from '../api/openExternal';
import { installLinkRouter, linkShell, type LinkShell } from '../api/linkRouter';

let root: Root;
let host: HTMLDivElement;
const anchor = () => host.querySelector('a.note-link') as HTMLAnchorElement | null;
// Opening is the link router's (api/linkRouter.ts), installed at boot on
// every page that renders this; the component only keeps the tap off its row.
let uninstallRouter: () => void;
let shell: ReturnType<typeof vi.spyOn>;
const inShell = (s: LinkShell) => shell.mockReturnValue(s);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    shell = vi.spyOn(linkShell, 'kind').mockReturnValue('desktop');
    uninstallRouter = installLinkRouter();
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    uninstallRouter();
    shell.mockRestore();
    vi.clearAllMocks();
});

describe('NoteLinkText', () => {
    it('renders an anchor for a URL, opening safely and in a new place', () => {
        act(() => { root.render(<NoteLinkText text="see https://example.com/a now" />); });
        const a = anchor()!;
        expect(a).not.toBeNull();
        expect(a.getAttribute('href')).toBe('https://example.com/a');
        expect(a.getAttribute('target')).toBe('_blank');
        // BOTH: noreferrer, not noopener alone — the destination must not
        // learn the origin and path of the page reading a sealed note.
        expect(a.getAttribute('rel')).toContain('noopener');
        expect(a.getAttribute('rel')).toContain('noreferrer');
        expect(host.textContent).toBe('see https://example.com/a now');
    });

    it('a click opens the link outside the app ONCE and does NOT reach the row around it', () => {
        const parentClick = vi.fn();
        act(() => {
            root.render(<div onClick={parentClick}><NoteLinkText text="https://example.com/a" /></div>);
        });
        act(() => { anchor()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
        // Once: a component that also opened its own link would open it
        // twice in the shells, the router having done it already.
        expect(openExternalUrl).toHaveBeenCalledTimes(1);
        expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a');
        expect(parentClick).not.toHaveBeenCalled();
        // POSITIVE CONTROL: a click on the plain text DOES reach the row —
        // so the assertion above is about stopPropagation, not about the
        // event never being dispatched.
        act(() => {
            host.querySelector('div')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(parentClick).toHaveBeenCalledTimes(1);
    });

    it('on the web the anchor\'s own new tab opens it: nothing prevented, nothing opened by hand, and still not the row', () => {
        inShell('web');
        const parentClick = vi.fn();
        act(() => {
            root.render(<div onClick={parentClick}><NoteLinkText text="https://example.com/a" /></div>);
        });
        // Read on React's own root container, registered after React's: it
        // runs once the component's handler has (stopPropagation spares
        // listeners on the same node), and the event goes no higher.
        let prevented: boolean | null = null;
        host.addEventListener('click', e => { prevented = e.defaultPrevented; e.preventDefault(); });
        act(() => { anchor()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
        expect(prevented).toBe(false);
        expect(openExternalUrl).not.toHaveBeenCalled();
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('interactive={false} marks the link without making it one', () => {
        act(() => { root.render(<NoteLinkText text="https://example.com/a" interactive={false} />); });
        expect(host.querySelector('a')).toBeNull();
        expect(host.querySelector('span.note-link')?.textContent).toBe('https://example.com/a');
    });

    it('a refused scheme is plain text, with no anchor at all', () => {
        act(() => { root.render(<NoteLinkText text="javascript:alert(1) and //evil.example/x" />); });
        expect(host.querySelector('a')).toBeNull();
        expect(host.textContent).toBe('javascript:alert(1) and //evil.example/x');
    });

    it('renders WITHOUT fetching anything — no favicon, no preview, no image', () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no fetch')));
        const RealImage = globalThis.Image;
        const imageSpy = vi.fn();
        // @ts-expect-error — a constructor stub is the point of the spy
        globalThis.Image = function () { imageSpy(); return new RealImage(); };
        try {
            act(() => { root.render(<NoteLinkText text="look at https://example.com/a and https://b.example" />); });
            expect(host.querySelectorAll('a.note-link')).toHaveLength(2);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(imageSpy).not.toHaveBeenCalled();
            expect(host.querySelector('img')).toBeNull();
        } finally {
            globalThis.Image = RealImage;
        }
    });
});
