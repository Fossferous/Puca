/**
 * Where Chat.tsx turns a message into words for somewhere that is not the message list, and
 * what it asks the preview to do with a spoiler.
 *
 * `messagePreviewText` and `coverSpoilers` have tests of their own (spoilerPreviews.test.ts),
 * and the real-browser script (e2e/spoiler-keyboard-real-browser.mjs) draws every preview
 * surface with the real components. Neither imports Chat.tsx, so a call site that went back
 * to the raw text passes both: the toast for a direct message again prints a spoiler's words
 * (and the key of an attached file), or Quote puts the word "Spoiler" in the box instead of
 * the bars that make the quote a spoiler too. These pin the two call sites in the source.
 *
 * Every pin is checked against the real source AND against mutated copies of it (applied to a
 * string here, never to the file), so a pin that could not fail fails its own mutation case.
 * Comments are stripped first: prose that mentions a call does not count as the call.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const CHAT = stripComments(readFileSync(join(here, '..', 'components', 'Chat.tsx'), 'utf8'));

/** The toast for a direct message: `pushMessageToast({ title: from, body: ... })`. */
const toastBody = (code: string): string | null => {
    const m = /decryptDMContent\([^)]*\)\s*\.then\(body => pushMessageToast\(\{\s*title: from,\s*body: ([^\n]+?),?\s*\}\)\)/.exec(code);
    return m ? m[1] : null;
};

/** What Quote passes to `formatQuote`. */
const quoteSource = (code: string): string | null => {
    const m = /const quoted = formatQuote\(([^\n]+)\);/.exec(code);
    return m ? m[1] : null;
};

describe('Chat.tsx: what a spoiler becomes where the message is not drawn', () => {
    it('the toast for a direct message says the body as a preview, capped, and never the raw text', () => {
        expect(toastBody(CHAT)).toBe('messagePreviewText(body, 120)');
    });

    it('Quote keeps the bars, so the quote is a spoiler too', () => {
        expect(quoteSource(CHAT)).toBe("messagePreviewText(content, undefined, { spoilers: 'keep' })");
    });

    describe('negative controls: each wiring taken out must fail its pin', () => {
        it('a toast of the raw body (the words, and an attached file\'s key)', () => {
            const mutated = CHAT.replace('body: messagePreviewText(body, 120),', "body: body.length > 120 ? body.slice(0, 120) + '...' : body,");
            expect(mutated).not.toBe(CHAT);
            expect(toastBody(mutated)).not.toBe('messagePreviewText(body, 120)');
        });

        it('a toast with no cap', () => {
            const mutated = CHAT.replace('messagePreviewText(body, 120)', 'messagePreviewText(body)');
            expect(mutated).not.toBe(CHAT);
            expect(toastBody(mutated)).not.toBe('messagePreviewText(body, 120)');
        });

        it('a Quote that hides the spoiler instead of copying its bars', () => {
            const mutated = CHAT.replace("messagePreviewText(content, undefined, { spoilers: 'keep' })", 'messagePreviewText(content)');
            expect(mutated).not.toBe(CHAT);
            expect(quoteSource(mutated)).not.toBe("messagePreviewText(content, undefined, { spoilers: 'keep' })");
        });

        it('a Quote of the raw content', () => {
            const mutated = CHAT.replace("messagePreviewText(content, undefined, { spoilers: 'keep' })", 'content');
            expect(mutated).not.toBe(CHAT);
            expect(quoteSource(mutated)).not.toBe("messagePreviewText(content, undefined, { spoilers: 'keep' })");
        });
    });
});
