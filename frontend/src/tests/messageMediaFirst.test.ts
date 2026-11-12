// @vitest-environment jsdom
/**
 * A message's pictures and videos go above its words (components/messageMediaFirst.ts).
 *
 * The owner's report, 2026-11-12: a picture sent with words was drawn to the RIGHT of them, the
 * words on its bottom edge. The composer sends `words ![photo](ref)` on one line and the picture is
 * an inline span, so the reading side takes the pictures out of the line and draws them first.
 * These cases run the real parser's output through the real split, so a change to either that puts
 * a picture back in the line of words fails here. The page itself (the block, its place above the
 * words, in a real browser with the real stylesheet) is e2e/images-above-text-real-browser.mjs.
 */
import { describe, it, expect } from 'vitest';
import { parseMessage, type Node } from '../utils/messageParser';
import { liftMediaAbove, encAttachmentKind } from '../components/messageMediaFirst';
import { buildOutgoingContent, type PendingAttachment } from '../api/composerAttachments';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const enc = (id: string, mime: string) => `sovereign-enc:${id}?k=${KEY}&m=${encodeURIComponent(mime)}`;
const PIC = `![shot.png](${enc('p1', 'image/png')})`;
const PIC2 = `![second.jpg](${enc('p2', 'image/jpeg')})`;
const VIDEO = `[clip.mp4](${enc('v1', 'video/mp4')})`;
const FILE = `[notes.pdf](${enc('f1', 'application/pdf')})`;
const SONG = `[song.mp3](${enc('a1', 'audio/mpeg')})`;
const HEIC_BY_NAME = `[IMG.heic](${enc('h1', 'application/octet-stream')})`;

/** The split's two halves, as text a reader would see: media by name, words as typed. */
function shape(content: string): { media: string[]; words: string } | null {
    const split = liftMediaAbove(parseMessage(content));
    if (!split) return null;
    const name = (n: Node): string => {
        switch (n.type) {
            case 'image': return `[pic ${n.alt}]`;
            case 'link': return `[att ${n.label}]`;
            case 'url': return `[url ${n.href}]`;
            case 'spoiler': return `||${n.children.map(name).join('')}||`;
            case 'text': return n.value;
            default: return `<${n.type}>`;
        }
    };
    const words = (ns: Node[]): string => ns.map(n => {
        if (n.type === 'text') return n.value;
        if (n.type === 'strong') return `**${words(n.children)}**`;
        return name(n);
    }).join('');
    return { media: split.media.filter(n => !(n.type === 'text' && n.value.trim() === '')).map(name), words: words(split.words) };
}

/** The whitespace kept between the pictures in the block, in order. */
function gaps(content: string): string[] {
    const split = liftMediaAbove(parseMessage(content))!;
    return split.media.filter(n => n.type === 'text').map(n => (n as { value: string }).value);
}

describe('what the composer sends: words, then the pictures', () => {
    const ready = (name: string, mime: string, href: string, spoiler = false): PendingAttachment =>
        ({ localId: name, name, mime, status: 'ready', href, previewUrl: null, spoiler });

    it("the owner's message: the picture comes out of the line, the words keep all of theirs", () => {
        const content = buildOutgoingContent('peep the axe she just gave me for free', [ready('shot.png', 'image/png', enc('p1', 'image/png'))]);
        expect(content).toBe(`peep the axe she just gave me for free ${PIC}`);
        expect(shape(content)).toEqual({ media: ['[pic shot.png]'], words: 'peep the axe she just gave me for free' });
    });

    it('several pictures keep their order, and the space between them', () => {
        const content = buildOutgoingContent('two', [
            ready('shot.png', 'image/png', enc('p1', 'image/png')),
            ready('second.jpg', 'image/jpeg', enc('p2', 'image/jpeg')),
        ]);
        const split = liftMediaAbove(parseMessage(content))!;
        expect(split.media.map(n => n.type)).toEqual(['image', 'text', 'image']);
        expect(shape(content)).toEqual({ media: ['[pic shot.png]', '[pic second.jpg]'], words: 'two' });
    });

    it('a spoilered picture goes up as the spoiler it is (still hidden: the spoiler node itself moves)', () => {
        const content = buildOutgoingContent('careful', [ready('shot.png', 'image/png', enc('p1', 'image/png'), true)]);
        expect(content).toBe(`careful ||${PIC}||`);
        const split = liftMediaAbove(parseMessage(content))!;
        expect(split.media).toHaveLength(1);
        expect(split.media[0].type).toBe('spoiler');
        expect(shape(content)!.words).toBe('careful');
    });

    it('a video goes above the words too', () => {
        expect(shape(`look ${VIDEO}`)).toEqual({ media: ['[att clip.mp4]'], words: 'look' });
    });

    it('a picture and a file: the picture goes up, the file chip stays after the words', () => {
        expect(shape(`here ${PIC} ${FILE}`)).toEqual({ media: ['[pic shot.png]'], words: 'here [att notes.pdf]' });
    });
});

describe('what moves and what stays', () => {
    it('a picture from another site, written as Markdown or as a bare address, moves like an attachment', () => {
        expect(shape('lol ![cat](https://example.org/cat.gif)')).toEqual({ media: ['[pic cat]'], words: 'lol' });
        expect(shape('lol https://example.org/cat.gif')).toEqual({ media: ['[url https://example.org/cat.gif]'], words: 'lol' });
    });

    it('a HEIC known only by its name is a picture (the card it may become stays above too)', () => {
        expect(encAttachmentKind(enc('h1', 'application/octet-stream'), 'IMG.heic')).toBe('picture');
        expect(shape(`from my phone ${HEIC_BY_NAME}`)).toEqual({ media: ['[att IMG.heic]'], words: 'from my phone' });
    });

    it('a video known only by its name is a video', () => {
        expect(encAttachmentKind(enc('v2', 'application/octet-stream'), 'clip.mkv')).toBe('video');
    });

    it('audio, a file, a link and a broken ref are not pictures: nothing moves', () => {
        expect(encAttachmentKind(enc('a1', 'audio/mpeg'), 'song.mp3')).toBe('audio');
        expect(encAttachmentKind(enc('f1', 'application/pdf'), 'notes.pdf')).toBe('file');
        expect(encAttachmentKind('sovereign-enc:nokey', 'x.png')).toBe('file');
        expect(shape(`listen ${SONG}`)).toBeNull();
        expect(shape(`read ${FILE}`)).toBeNull();
        expect(shape('see https://example.org/page')).toBeNull();
        expect(shape('see [the docs](https://example.org/docs.png.html)')).toBeNull();
    });

    it('a message with no words is drawn as it always was', () => {
        expect(shape(PIC)).toBeNull();
        expect(shape(`${PIC} ${PIC2}`)).toBeNull();
        expect(shape(`${PIC} ${FILE}`)).toBeNull();
        expect(shape(`||${PIC}||`)).toBeNull();
    });

    it('a picture inside a quote, or a spoiler that also holds words, stays where it is', () => {
        expect(shape(`> look ${PIC}`)).toBeNull();
        expect(shape(`||secret ${PIC}||`)).toBeNull();
    });

    it('a scrubbed clip ("clip removed") is words, not a video', () => {
        expect(shape('my clip [Clip 0:05](sovereign-clip:v1)')).toBeNull();
    });
});

describe('the whitespace the picture leaves behind', () => {
    it('picture first: the words start with no space', () => {
        expect(shape(`${PIC} after`)).toEqual({ media: ['[pic shot.png]'], words: 'after' });
        expect(shape(` ${PIC} after`)).toEqual({ media: ['[pic shot.png]'], words: 'after' });
    });

    it('mid-sentence: one space where the picture was', () => {
        expect(shape(`before ${PIC} after`)).toEqual({ media: ['[pic shot.png]'], words: 'before after' });
    });

    it('on a line of its own: one line break, no empty line', () => {
        expect(shape(`line one\n${PIC}\nline two`)).toEqual({ media: ['[pic shot.png]'], words: 'line one\nline two' });
    });

    it('formatting either side is kept, a space between', () => {
        expect(shape(`**bold** ${PIC} more`)).toEqual({ media: ['[pic shot.png]'], words: '**bold** more' });
    });

    it('the words as typed are otherwise untouched (leading spaces, runs of spaces)', () => {
        expect(shape(`  two  spaces ${PIC}`)).toEqual({ media: ['[pic shot.png]'], words: '  two  spaces' });
    });
});

// The release review of 0d0fe39a (2026-11-12) found four ways the split laid
// a message out other than the sender did. Each case below failed there.
describe('punctuation glued to a picture goes with its words, no space', () => {
    it('closing punctuation after the picture joins the word before it', () => {
        expect(shape('this https://example.org/cat.png, right?')).toEqual({ media: ['[url https://example.org/cat.png]'], words: 'this, right?' });
        expect(shape(`(see ${PIC})`)).toEqual({ media: ['[pic shot.png]'], words: '(see)' });
        expect(shape(`look ${PIC}.`)).toEqual({ media: ['[pic shot.png]'], words: 'look.' });
    });

    it('opening punctuation before the picture joins the word after it', () => {
        expect(shape(`(${PIC} see)`)).toEqual({ media: ['[pic shot.png]'], words: '(see)' });
    });

    it('CONTROL: punctuation the sender spaced off keeps its space', () => {
        expect(shape(`look ${PIC} .`)).toEqual({ media: ['[pic shot.png]'], words: 'look .' });
        expect(shape(`well ${PIC}then`)).toEqual({ media: ['[pic shot.png]'], words: 'well then' });
    });
});

describe('a paragraph break around a picture on its own line is kept', () => {
    it('a blank line on both sides: the two paragraphs stay apart', () => {
        expect(shape('first paragraph\n\nhttps://example.org/cat.gif\n\nsecond paragraph'))
            .toEqual({ media: ['[url https://example.org/cat.gif]'], words: 'first paragraph\n\nsecond paragraph' });
    });

    it('a blank line on one side: the wider break is the one between the paragraphs', () => {
        expect(shape(`first\n\n${PIC}\nsecond`)!.words).toBe('first\n\nsecond');
        expect(shape(`first\n${PIC}\n\nsecond`)!.words).toBe('first\n\nsecond');
    });
});

describe('pictures keep the whitespace that stood between them', () => {
    it('on separate lines: still stacked', () => {
        expect(gaps(`caption\n${PIC}\n${PIC2}`)).toEqual(['\n']);
        expect(gaps(`${PIC}\n\n${PIC2}\ncaption`)).toEqual(['\n\n']);
        expect(shape(`caption\n${PIC}\n${PIC2}`)!.words).toBe('caption');
    });

    it('touching: still touching, no space added', () => {
        const split = liftMediaAbove(parseMessage(`${PIC}${PIC2} caption`))!;
        expect(split.media.map(n => n.type)).toEqual(['image', 'image']);
    });

    it('words between them, on other lines: stacked; on the same line: side by side', () => {
        expect(gaps(`${PIC}\nand\n${PIC2}`)).toEqual(['\n']);
        expect(gaps(`${PIC} and ${PIC2}`)).toEqual([' ']);
    });
});

describe('a spoilered file is a file', () => {
    it('a picture and a spoilered file, no words: drawn as it always was', () => {
        expect(shape(`${PIC} ||${FILE}||`)).toBeNull();
        expect(shape(`${PIC} ||${FILE} ${PIC2}||`)).toBeNull();
    });

    it('CONTROL: with words, the picture goes up and the spoilered file stays with the words', () => {
        expect(shape(`${PIC} ||${FILE}|| thanks`)).toEqual({ media: ['[pic shot.png]'], words: '||[att notes.pdf]|| thanks' });
    });
});
