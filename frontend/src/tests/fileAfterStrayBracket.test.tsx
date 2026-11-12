/**
 * A spoilered file after a `[` the words left open (a smiley, `:[`) is a spoilered file.
 *
 * The composer sends a spoilered file as `text + ' ' + ||ref||`. The parser used to take a `[` in
 * those words for the start of a link whose label ran, `]` free, to the file's own `](`: the link
 * took the opening bars into its label, no spoiler was left, and the message list drew the file in
 * the clear with the words before it eaten into its name. This is the message list itself, the
 * real MessageContent, not a preview: what is asserted is where the attachment is in the page.
 * The same message in a real browser, with the real stylesheet, is in
 * e2e/modes-look-real-browser.mjs (nothing of it painted, at rest or under the pointer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/attachments', async (orig) => ({
    ...(await orig<typeof import('../api/attachments')>()),
    // Nothing is fetched: the attachment's element is what is in question, not its bytes.
    acquireAttachmentUrl: async (id: string) => ({ url: `blob:decrypted-${id}`, release: () => {} }),
}));

import { MessageContent } from '../components/MessageContent';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const PICTURE = `![medical-results.png](sovereign-enc:abc?k=${KEY}&m=image%2Fpng)`;
const FILE = `[results.zip](sovereign-enc:def?k=${KEY}&m=application%2Fzip)`;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
});

async function render(content: string) {
    await act(async () => { root.render(<MessageContent content={content} members={[]} channels={[]} />); });
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); });
}

/** Whatever stands for a file in the page. */
const attachments = () => Array.from(host.querySelectorAll<HTMLElement>('[class*="attachment"], img, video, audio'));
const inSpoiler = (el: Element) => el.closest('.spoiler-body') !== null;

describe('a spoilered file after a stray `[`, in the message list', () => {
    it.each([
        ['the report: a picture after a smiley', `ugh :[ ||${PICTURE}||`],
        ['a file', `ugh :[ ||${FILE}||`],
        ['a bare bracket', `[ ||${PICTURE}||`],
        ['a bracket on the line before', `ugh :[\n||${PICTURE}||`],
        ['two files', `ugh :[ ||${PICTURE}|| ||${FILE}||`],
        ['words after', `ugh :[ ||${PICTURE}|| thanks`],
    ])('%s: every file is inside the spoiler, none in the clear', async (_, content) => {
        await render(content);
        const found = attachments();
        expect(found.length).toBeGreaterThan(0);
        expect(found.filter(el => !inSpoiler(el)).map(el => el.className)).toEqual([]);
        // The spoiler is there, closed, and the key is nowhere in the page.
        const spoilers = host.querySelectorAll('.spoiler');
        expect(spoilers.length).toBeGreaterThan(0);
        for (const s of spoilers) expect(s.getAttribute('aria-expanded')).toBe('false');
        expect(host.innerHTML).not.toContain(KEY);
    });

    it('the words with it are the words, outside the spoiler, and not its name', async () => {
        await render(`ugh :[ ||${PICTURE}||`);
        // The spoilered picture is drawn above the words, in .message-media
        // (components/messageMediaFirst.ts), and the space that only separated
        // the words from it goes with it: the words are exactly what was typed.
        const outside = Array.from(host.childNodes).filter(n => !(n instanceof HTMLElement && (n.classList.contains('spoiler') || n.classList.contains('message-media'))));
        expect(outside.map(n => n.textContent).join('')).toBe('ugh :[');
        expect(host.querySelector('.message-media .spoiler')).not.toBeNull();
        expect(host.querySelector('.spoiler-body')?.textContent).not.toContain('ugh');
    });

    it('CONTROL: with no stray `[` it was always this', async () => {
        await render(`ugh :( ||${PICTURE}||`);
        expect(attachments().filter(el => !inSpoiler(el))).toEqual([]);
        expect(host.querySelectorAll('.spoiler').length).toBe(1);
    });

    it('CONTROL: a file that is not spoilered is drawn, with the same words', async () => {
        await render(`ugh :[ ${PICTURE}`);
        expect(attachments().length).toBeGreaterThan(0);
        expect(host.querySelectorAll('.spoiler').length).toBe(0);
        // Drawn above the words now (components/messageMediaFirst.ts); the words whole.
        expect(host.textContent).toContain('ugh :[');
    });
});
