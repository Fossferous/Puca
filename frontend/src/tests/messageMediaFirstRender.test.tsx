/**
 * The message list itself: the real MessageContent puts a message's pictures in their own block
 * (.message-media, a block in Chat.css) BEFORE its words, and leaves every other message as it was.
 *
 * The owner's report, 2026-11-12: "images should be above the message" — a picture sent with words
 * was drawn to the right of them. What jsdom can show is the order and the parent; where things
 * land on screen, with the stylesheet, is e2e/images-above-text-real-browser.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/attachments', async (orig) => ({
    ...(await orig<typeof import('../api/attachments')>()),
    // Nothing is fetched: where the attachment's element is, is what is in question.
    acquireAttachmentUrl: async (id: string) => ({ url: `blob:decrypted-${id}`, release: () => {} }),
}));

import { MessageContent } from '../components/MessageContent';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const enc = (id: string, mime: string) => `sovereign-enc:${id}?k=${KEY}&m=${encodeURIComponent(mime)}`;
const PIC = `![shot.png](${enc('p1', 'image/png')})`;
const PIC2 = `![second.jpg](${enc('p2', 'image/jpeg')})`;
const VIDEO = `[clip.mp4](${enc('v1', 'video/mp4')})`;
const FILE = `[notes.pdf](${enc('f1', 'application/pdf')})`;
const WORDS = 'peep the axe she just gave me for free';

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    host = document.createElement('div');
    host.className = 'message-content';
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

/** The text node holding `words`, in the message as rendered. */
function wordsNode(words: string): Text {
    const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes(words)) return n as Text;
    throw new Error(`"${words}" is not in the message: ${host.innerHTML}`);
}
const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('a picture sent with words', () => {
    it("the owner's message: the picture is in the block, and the block is before the words", async () => {
        await render(`${WORDS} ${PIC}`);
        const block = host.querySelector('.message-media');
        expect(block).not.toBeNull();
        // The picture's own element (its loading chip or the picture) is inside the block.
        expect(block!.querySelector('img, .message-image, .attachment-loading, [class*="attachment"]')).not.toBeNull();
        const words = wordsNode(WORDS);
        expect(block!.contains(words)).toBe(false);
        expect(before(block!, words)).toBe(true);
        // The words are whole, with nothing of the picture's ref and no stray space after them.
        expect(words.textContent).toBe(WORDS);
        expect(host.textContent).not.toContain('sovereign-enc');
    });

    it('shows the decrypted picture there once it loads', async () => {
        await render(`${WORDS} ${PIC}`);
        const img = host.querySelector<HTMLImageElement>('.message-media .message-image img');
        // jsdom decodes nothing, so the picture may still be pending; either way it is not beside the words.
        if (img) expect(img.getAttribute('src')).toBe('blob:decrypted-p1');
        expect(host.querySelector('.message-image:not(.message-media .message-image)')).toBeNull();
    });

    it('two pictures stay in the order sent, both in the block', async () => {
        await render(`two ${PIC} ${PIC2}`);
        const block = host.querySelector('.message-media')!;
        expect(block).not.toBeNull();
        expect(block.children.length).toBe(2);
        expect(block.innerHTML.indexOf('p1') === -1 || block.innerHTML.indexOf('p1') < block.innerHTML.indexOf('p2')).toBe(true);
        expect(before(block, wordsNode('two'))).toBe(true);
    });

    it('a spoilered picture moves still covered: the spoiler is in the block, unrevealed', async () => {
        await render(`careful ||${PIC}||`);
        const spoiler = host.querySelector('.message-media .spoiler');
        expect(spoiler).not.toBeNull();
        expect(spoiler!.classList.contains('revealed')).toBe(false);
        expect(before(host.querySelector('.message-media')!, wordsNode('careful'))).toBe(true);
    });

    it('a video goes above the words too', async () => {
        await render(`look ${VIDEO}`);
        const block = host.querySelector('.message-media');
        expect(block).not.toBeNull();
        expect(before(block!, wordsNode('look'))).toBe(true);
    });
});

describe('everything else is drawn as before (no block)', () => {
    it.each([
        ['words alone', 'just words'],
        ['a picture alone', PIC],
        ['two pictures alone', `${PIC} ${PIC2}`],
        ['a file with words', `read ${FILE}`],
        ['a picture in a quote', `> look ${PIC}`],
        ['a spoiler holding words and a picture', `||secret ${PIC}||`],
        ['a picture and a spoilered file', `${PIC} ||${FILE}||`],
    ])('%s', async (_, content) => {
        await render(content);
        expect(host.querySelector('.message-media')).toBeNull();
    });
});

/** The message's text outside the block: the words as drawn. */
const outside = () => Array.from(host.childNodes)
    .filter(n => !(n instanceof HTMLElement && n.classList.contains('message-media')))
    .map(n => n.textContent).join('');

describe('the words and the pictures keep the layout the sender typed (release review)', () => {
    it('punctuation glued to the picture stays on its word', async () => {
        await render(`look ${PIC}.`);
        expect(host.querySelector('.message-media')).not.toBeNull();
        expect(outside()).toBe('look.');
    });

    it('a paragraph break around a picture on its own line', async () => {
        await render(`first\n\n${PIC}\n\nsecond`);
        expect(outside()).toBe('first\n\nsecond');
    });

    it('pictures on separate lines are still on separate lines in the block', async () => {
        await render(`caption\n${PIC}\n${PIC2}`);
        const block = host.querySelector('.message-media')!;
        expect(block.children.length).toBe(2);
        expect(Array.from(block.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent)).toEqual(['\n']);
    });
});
