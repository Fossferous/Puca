/**
 * A message body is attacker-authored. It is end-to-end encrypted, so no
 * server-side filter can inspect it, and `MessageContent` parses it while
 * RENDERING — synchronously, in the component body.
 *
 * `parseEncAttachment` used to call `decodeURIComponent` on a value that
 * `URLSearchParams` had already decoded. `m=%25` decodes to a lone '%', and the
 * second pass threw `URIError` mid-render. The app's only error boundary was
 * the root one, so that swapped the ENTIRE app for the crash screen — for every
 * viewer, on every platform, and on every subsequent load, because Chat
 * auto-selects the first server and its first text channel. Posting forty
 * characters into a channel, or into a DM to a stranger, was a permanent
 * denial of service against everyone who could read it, and a moderator could
 * not delete it without opening the channel that crashed them (0.9.810 audit,
 * C-06).
 *
 * Two independent guarantees are pinned here, because either alone leaves a
 * hole: the parser is TOTAL, and one message that still manages to throw is
 * contained to its own row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { parseEncAttachment } from '../api/attachments';
import { MessageContent } from '../components/MessageContent';
import { MessageErrorBoundary } from '../components/MessageErrorBoundary';

describe('parseEncAttachment is total', () => {
    it('does not throw on the lone-percent mime that crashed the app', () => {
        // THE REPRO. URLSearchParams turns `m=%25` into '%', which is not a
        // valid percent-encoding, so a second decodeURIComponent throws.
        expect(() => parseEncAttachment('sovereign-enc:abc?k=KEY&m=%25')).not.toThrow();
        const info = parseEncAttachment('sovereign-enc:abc?k=KEY&m=%25');
        expect(info).not.toBeNull();
        expect(info!.id).toBe('abc');
        expect(info!.key).toBe('KEY');
        // Falls back to the raw value rather than inventing one; safeBlobType
        // reduces anything unrecognised to octet-stream downstream.
        expect(info!.mime).toBe('%');
    });

    it('survives every other hostile shape without throwing', () => {
        for (const href of [
            'sovereign-enc:abc?k=KEY&m=%',
            'sovereign-enc:abc?k=KEY&m=%zz',
            'sovereign-enc:abc?k=KEY&m=%E0%A4%A',
            'sovereign-enc:abc?k=KEY&m=' + '%25'.repeat(400),
            'sovereign-enc:abc?k=KEY&c=%25&m=%25',
            'sovereign-enc:?k=KEY',
            'sovereign-enc:abc?m=%25',
        ]) {
            expect(() => parseEncAttachment(href), href).not.toThrow();
        }
    });

    // POSITIVE CONTROLS. Without these the totality change could have quietly
    // altered how every legitimate attachment in existing history parses.
    it('still decodes a normally-encoded mime exactly as before', () => {
        expect(parseEncAttachment('sovereign-enc:abc?k=KEY&m=image%2Fpng&c=CAP'))
            .toEqual({ id: 'abc', key: 'KEY', mime: 'image/png', cap: 'CAP' });
    });

    it('round-trips a mime containing + and ; as the writer encodes it', () => {
        const mime = 'application/xhtml+xml';
        const href = `sovereign-enc:abc?k=KEY&m=${encodeURIComponent(mime)}`;
        expect(parseEncAttachment(href)!.mime).toBe(mime);
    });

    it('still returns null for a ref that is genuinely malformed', () => {
        expect(parseEncAttachment('sovereign-enc:abc')).toBeNull();          // no key
        expect(parseEncAttachment('https://example.test/x?k=K')).toBeNull(); // wrong scheme
    });
});

describe('MessageContent renders a hostile attachment ref instead of throwing', () => {
    // renderToStaticMarkup does NOT run error boundaries, so this exercises the
    // parser fix alone — the boundary cannot mask a regression here.
    it('renders the message body carrying m=%25', () => {
        const content = '[x](sovereign-enc:abc?k=KEY&m=%25)';
        expect(() => renderToStaticMarkup(
            createElement(MessageContent, { content, members: [] }),
        )).not.toThrow();
    });

    it('positive control: the same body with a valid mime renders too', () => {
        const content = '[x](sovereign-enc:abc?k=KEY&m=image%2Fpng)';
        expect(() => renderToStaticMarkup(
            createElement(MessageContent, { content, members: [] }),
        )).not.toThrow();
    });
});

describe('MessageErrorBoundary contains one bad message', () => {
    // createRoot + act, NOT renderToStaticMarkup: error boundaries are INERT in
    // the string renderer, so a boundary test written that way passes on the
    // exception escaping — it proves nothing. (Cost one red run to relearn.)
    const Boom = () => { throw new Error('render exploded'); };

    let container: HTMLDivElement;
    let root: Root;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        // React logs every caught render error; keep the run readable.
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        container.remove();
        errSpy.mockRestore();
    });

    it('is inert while its child renders normally', () => {
        act(() => {
            root.render(createElement(MessageErrorBoundary, { resetKey: 'a' },
                createElement('span', null, 'hello')));
        });
        expect(container.textContent).toContain('hello');
        expect(container.textContent).not.toContain('could not be displayed');
    });

    it('a throwing child does not take the tree down', () => {
        act(() => {
            root.render(createElement('div', null,
                createElement(MessageErrorBoundary, { resetKey: 'bad' }, createElement(Boom)),
                createElement('span', null, 'sibling survives'),
            ));
        });
        expect(container.textContent).toContain('could not be displayed');
        // The rest of the list still renders — that is the whole point.
        expect(container.textContent).toContain('sibling survives');
    });

    it('re-arms when the message content changes, so an edit can recover', () => {
        act(() => {
            root.render(createElement(MessageErrorBoundary, { resetKey: 'bad' }, createElement(Boom)));
        });
        expect(container.textContent).toContain('could not be displayed');

        // Same boundary instance, new message text and a child that renders.
        // Without getDerivedStateFromProps this stays latched — which is the point.
        act(() => {
            root.render(createElement(MessageErrorBoundary, { resetKey: 'fixed' },
                createElement('span', null, 'edited into something valid')));
        });
        expect(container.textContent).toContain('edited into something valid');
        expect(container.textContent).not.toContain('could not be displayed');
    });

    it('stays on the placeholder while the SAME bad message re-renders', () => {
        act(() => {
            root.render(createElement(MessageErrorBoundary, { resetKey: 'bad' }, createElement(Boom)));
        });
        act(() => {
            root.render(createElement(MessageErrorBoundary, { resetKey: 'bad' }, createElement(Boom)));
        });
        expect(container.textContent).toContain('could not be displayed');
    });
});
