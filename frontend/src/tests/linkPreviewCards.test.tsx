/**
 * Which links get a card under the message: the REAL MessageContent and LinkPreview as Chat
 * renders them, two siblings fed the same text. A spoiler's link is hidden in the message, so a
 * card printing it in full, for anyone to press, would give away what the spoiler is for. The
 * card reads what the message renders, so its address is the link's own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageContent } from '../components/MessageContent';
import { LinkPreview } from '../components/LinkPreview';
import { extractUrls } from '../api/linkPreview';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

async function said(content: string) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<><MessageContent content={content} members={[]} /><LinkPreview content={content} /></>);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return [...host.querySelectorAll<HTMLAnchorElement>('a.link-preview-card')].map(a => a.getAttribute('href'));
}

describe('a link in a spoiler has no card', () => {
    it.each([
        ['a bare address', '||https://example.invalid/the-butler-did-it||'],
        ['a link with its own words', '||[who did it](https://example.invalid/the-butler-did-it)||'],
        ['among words', '||it was https://example.invalid/the-butler-did-it all along||'],
        ['in bold in it', '||**https://example.invalid/the-butler-did-it**||'],
        ['it in bold', '**||https://example.invalid/the-butler-did-it||**'],
        ['it in a quote', '> ||https://example.invalid/the-butler-did-it||'],
        ['in code in it', '||`https://example.invalid/the-butler-did-it`||'],
    ])('%s', async (_, content) => {
        expect(await said(content)).toEqual([]);
        expect(host!.textContent, 'the message itself still holds it').toContain(content.includes('who did it') ? 'who did it' : 'the-butler-did-it');
    });

    it('one outside it still has one, and only that one', async () => {
        expect(await said('see https://example.invalid/open and ||https://example.invalid/hidden||')).toEqual(['https://example.invalid/open']);
    });

    it('the same address outside it was never hidden, so it has one', async () => {
        expect(await said('https://example.invalid/both ||https://example.invalid/both||')).toEqual(['https://example.invalid/both']);
    });
});

describe('the card has the address the link has', () => {
    it('CONTROL: a bare address, in a quote too', async () => {
        expect(await said('https://example.invalid/a')).toEqual(['https://example.invalid/a']);
        act(() => root?.unmount());
        expect(await said('> https://example.invalid/b')).toEqual(['https://example.invalid/b']);
    });

    it('bold around an address is not in it', async () => {
        expect(await said('**https://example.invalid/a**')).toEqual(['https://example.invalid/a']);
    });

    it('[text](address) leaves its bracket out', async () => {
        expect(await said('[the plot](https://example.invalid/plot)')).toEqual(['https://example.invalid/plot']);
        expect(host!.querySelector('a.message-link')!.getAttribute('href')).toBe('https://example.invalid/plot');
    });

    it('words that look like an address are only words: the card is for where the link goes', async () => {
        expect(await said('[https://shown.invalid/x](https://real.invalid/y)')).toEqual(['https://real.invalid/y']);
    });

    it('punctuation after a bare address is not in it', async () => {
        expect(await said('read https://example.invalid/a, then (https://example.invalid/b).')).toEqual([
            'https://example.invalid/a',
            'https://example.invalid/b',
        ]);
    });

    it('CONTROL: an address in code has one, as it always did', async () => {
        expect(await said('`https://example.invalid/in-code`')).toEqual(['https://example.invalid/in-code']);
        act(() => root?.unmount());
        expect(await said('```\nhttps://example.invalid/in-block\n```')).toEqual(['https://example.invalid/in-block']);
    });
});

describe('what has no card', () => {
    it('a picture, which the message draws', async () => {
        expect(await said('https://example.invalid/pic.png')).toEqual([]);
        act(() => root?.unmount());
        expect(await said('![a picture](https://example.invalid/pic)')).toEqual([]);
    });

    it('an attachment or a clip, whose address is a key', () => {
        expect(extractUrls('[f.pdf](sovereign-enc:abc?k=secret&m=application/pdf) ![p.png](sovereign-enc:def?k=secret&m=image/png) [c](sovereign-clip:ghi?k=secret)')).toEqual([]);
    });

    it('a link that is no web address', () => {
        expect(extractUrls('[mail](mailto:a@example.invalid) [here](/invite/abc)')).toEqual([]);
    });

    it('a server of your own on this machine', async () => {
        expect(await said('http://localhost:3000/x http://127.0.0.1/y')).toEqual([]);
    });

    it('no text at all', () => {
        expect(extractUrls('')).toEqual([]);
    });
});
