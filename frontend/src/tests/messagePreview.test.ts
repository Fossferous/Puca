/**
 * Message text -> one-line preview, the ONE function every preview surface
 * uses (reply banner, reply snapshot, pins, search, Quote, the collection
 * feed) and the Edit split.
 *
 * The bug: "when sending an image it shows [string of text]". The composer was
 * fixed long ago (chips), but every place that RE-SHOWS a message printed the
 * decrypted markdown verbatim — `![photo.png](sovereign-enc:<id>?k=<file key>
 * &c=<fetch capability>&m=…)` — so the reply bar, the pinned list and search
 * showed a wall of tokens, and the pinned list and Edit showed the file's
 * decryption key. A history reply snapshot was additionally cut at 100 chars,
 * mid-key, so a parser that needs the closing `)` never matched it.
 *
 * What must hold, whatever the shape: no scheme, no key, no capability, ever;
 * the file NAME is what a person sees.
 */
import { describe, it, expect } from 'vitest';
import {
    messagePreviewSegments,
    messagePreviewText,
    splitEditableContent,
    joinEditedContent,
    messageSearchText,
} from '../api/messagePreview';
import { parseMessage, type Node } from '../utils/messageParser';
import { buildOutgoingContent, type PendingAttachment } from '../api/composerAttachments';
import { encodeClipRef } from '../api/clips/clipRef';

const ID = '746bbec3-d7e1-4366-8854-429b2b874f00';
const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const CAP = '_HEoEOQxCapabilityToken0123';
const IMG = `![photo.png](sovereign-enc:${ID}?k=${KEY}&m=image%2Fpng&c=${CAP})`;

/** Nothing that opens or names the blob may survive into a preview. */
function expectNoSecrets(s: string) {
    expect(s).not.toMatch(/sovereign-(enc|clip)/i);
    expect(s).not.toContain(KEY);
    expect(s).not.toContain(KEY.slice(0, 12));
    expect(s).not.toContain(CAP);
    expect(s).not.toMatch(/[?&][kc]=/);
    expect(s).not.toContain('](');
}

const chip = (name: string, mime: string, href: string, spoiler = false): PendingAttachment => ({
    localId: name, name, mime, status: 'ready', href, previewUrl: null, spoiler,
});

describe('messagePreviewText / messagePreviewSegments: attachments become a label', () => {
    it('a key-bearing image ref is the file name, never the ref', () => {
        const text = messagePreviewText(IMG, 60);
        expectNoSecrets(text);
        expect(text).toContain('photo.png');
        expect(messagePreviewSegments(IMG, 60)).toEqual([
            { type: 'attachment', kind: 'image', name: 'photo.png', spoiler: false },
        ]);
    });

    it('a caption keeps its text and loses the ref', () => {
        const content = `hi ![a.png](sovereign-enc:x?k=${KEY})`;
        const text = messagePreviewText(content, 60);
        expect(text.startsWith('hi ')).toBe(true);
        expect(text).toContain('a.png');
        expectNoSecrets(text);
    });

    it('a ref TRUNCATED mid-key (the old history snapshot, slice(0,100)) is still a label', () => {
        const cut = IMG.slice(0, 100);
        expect(cut).not.toContain(')'); // positive control: really cut inside the href
        const text = messagePreviewText(cut, 60);
        expectNoSecrets(text);
        expect(text).toContain('photo.png');
        // Cut before the scheme was even complete.
        const early = messagePreviewText('look ![photo.png](sover', 60);
        expect(early).toContain('photo.png');
        expect(early).not.toContain('](');
        expect(early).not.toMatch(/sover/i);
    });

    it('several attachments, in order, each with its own kind', () => {
        const content = buildOutgoingContent('two files', [
            chip('a.png', 'image/png', `sovereign-enc:1?k=K1SECRETK1&m=image%2Fpng`),
            chip('b.pdf', 'application/pdf', `sovereign-enc:2?k=K2SECRETK2&m=application%2Fpdf`),
            chip('c.mkv', 'application/octet-stream', `sovereign-enc:3?k=K3SECRETK3&m=application%2Foctet-stream`),
            chip('d.mp3', 'audio/mpeg', `sovereign-enc:4?k=K4SECRETK4&m=audio%2Fmpeg`),
        ]);
        const segs = messagePreviewSegments(content);
        expect(segs.filter(s => s.type === 'attachment')).toEqual([
            { type: 'attachment', kind: 'image', name: 'a.png', spoiler: false },
            { type: 'attachment', kind: 'file', name: 'b.pdf', spoiler: false },
            { type: 'attachment', kind: 'video', name: 'c.mkv', spoiler: false },
            { type: 'attachment', kind: 'audio', name: 'd.mp3', spoiler: false },
        ]);
        const text = messagePreviewText(content);
        expect(text).not.toMatch(/K\dSECRET/);
        expect(text).not.toMatch(/sovereign-enc/i);
        expect(text.startsWith('two files')).toBe(true);
    });

    it('a spoiler attachment hides its name and leaves no || behind', () => {
        const content = buildOutgoingContent('caption', [
            chip('secret-plot.png', 'image/png', `sovereign-enc:1?k=${KEY}&m=image%2Fpng`, true),
            chip('open.png', 'image/png', `sovereign-enc:2?k=K2&m=image%2Fpng`),
        ]);
        expect(content).toContain('||![secret-plot.png]'); // positive control: really spoiler-wrapped
        const segs = messagePreviewSegments(content);
        expect(segs.filter(s => s.type === 'attachment')).toEqual([
            { type: 'attachment', kind: 'image', name: 'secret-plot.png', spoiler: true },
            { type: 'attachment', kind: 'image', name: 'open.png', spoiler: false },
        ]);
        const text = messagePreviewText(content);
        expect(text).not.toContain('secret-plot');
        expect(text).not.toContain('||');
        expect(text).toMatch(/spoiler/i);
        expect(text).toContain('open.png');
        expectNoSecrets(text);
        // A spoiler span that also covers text still hides the file.
        const wide = messagePreviewText(`||the twist ![end.png](sovereign-enc:1?k=${KEY})||`);
        expect(wide).not.toContain('end.png');
    });

    it('an UPPERCASE scheme is the same scheme (URL schemes are case-insensitive)', () => {
        const text = messagePreviewText(`![p.png](SOVEREIGN-ENC:abc?k=${KEY}&m=image%2Fpng)`, 60);
        expectNoSecrets(text);
        expect(text).toContain('p.png');
    });

    it('a bare ref someone typed loses its key and capability too', () => {
        const text = messagePreviewText(`see sovereign-enc:abc?k=${KEY}&c=${CAP} ok`, 80);
        expectNoSecrets(text);
        expect(text.startsWith('see ')).toBe(true);
        expect(text.endsWith(' ok')).toBe(true);
    });

    it('an unnamed image is called "image"', () => {
        expect(messagePreviewSegments(`![](sovereign-enc:1?k=${KEY}&m=image%2Fpng)`)).toEqual([
            { type: 'attachment', kind: 'image', name: 'image', spoiler: false },
        ]);
    });

    it('plain text is untouched (negative control), and newlines survive for Quote', () => {
        expect(messagePreviewText('just text')).toBe('just text');
        expect(messagePreviewText('line one\nline two')).toBe('line one\nline two');
        expect(messagePreviewSegments('just text')).toEqual([{ type: 'text', text: 'just text' }]);
    });

    it('truncates to max with an ellipsis, counting a label as its name', () => {
        expect(messagePreviewText('hello world', 5)).toBe('hello…');
        expect(messagePreviewText('hi', 5)).toBe('hi');
        const long = `${'a'.repeat(10)} ${IMG}`;
        const cut = messagePreviewText(long, 5);
        expect(cut).toBe('aaaaa…');
        expectNoSecrets(cut);
    });

    it('a clip post is "Clip · m:ss" (its href IS the key); a scrubbed one is "Clip (removed)"', () => {
        const href = encodeClipRef({
            key: new Uint8Array(32).fill(1), noncePrefix: new Uint8Array(8).fill(2), clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
            videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 124_000, width: 1920, height: 1080, totalCipherBytes: 1234,
            parts: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], partDurMs: [0, 124_000],
        });
        expect(messagePreviewText(`[Clip 2:04](${href})`, 50)).toBe('Clip · 2:04');
        expect(messagePreviewText('[Clip 2:04](sovereign-clip:v1)', 50)).toBe('Clip (removed)');
        expect(messagePreviewText('[Clip](SOVEREIGN-CLIP:v1?AQEB)', 50)).not.toContain('AQEB');
    });
});

describe('splitEditableContent / joinEditedContent: Edit shows the text, keeps the files', () => {
    const composed = buildOutgoingContent('my caption', [
        chip('a b[1].png', 'image/png', `sovereign-enc:1?k=${KEY}&m=image%2Fpng&c=${CAP}`, true),
        chip('doc.pdf', 'application/pdf', `sovereign-enc:2?k=K2&m=application%2Fpdf`),
    ]);

    it('the editable text carries no ref, no key, no capability', () => {
        const { text, refs } = splitEditableContent(composed);
        expect(text).toBe('my caption');
        expectNoSecrets(text);
        expect(refs).toHaveLength(2);
    });

    it('an unchanged edit round-trips byte-for-byte; a changed one keeps every ref, in order', () => {
        const { text, refs } = splitEditableContent(composed);
        expect(joinEditedContent(text, refs)).toBe(composed);
        const edited = joinEditedContent('new words', refs);
        expect(edited.startsWith('new words ')).toBe(true);
        expect(edited).toContain(`||![a b_1_.png](sovereign-enc:1?k=${KEY}&m=image%2Fpng&c=${CAP})||`);
        expect(edited.indexOf('a b_1_.png')).toBeLessThan(edited.indexOf('doc.pdf'));
    });

    it('clearing the caption leaves the attachments', () => {
        const { refs } = splitEditableContent(composed);
        expect(joinEditedContent('   ', refs)).toBe(refs.join(' '));
    });

    it('a message with only attachments edits as an empty caption', () => {
        const { text, refs } = splitEditableContent(IMG);
        expect(text).toBe('');
        expect(refs).toEqual([IMG]);
    });

    it('a message with no attachments is edited verbatim (negative control)', () => {
        expect(splitEditableContent('plain words')).toEqual({ text: 'plain words', refs: [] });
        expect(joinEditedContent('plain words!', [])).toBe('plain words!');
    });

    it('a bare ref someone typed comes out of the edit box too (its key is a key)', () => {
        const { text, refs } = splitEditableContent(`see sovereign-enc:abc?k=${KEY} ok`);
        expect(text).toBe('see ok');
        expectNoSecrets(text);
        expect(refs).toEqual([`sovereign-enc:abc?k=${KEY}`]);
    });

    it('a ref in the middle of text still comes out of the edit box', () => {
        const { text, refs } = splitEditableContent(`see ${IMG} here`);
        expect(text).toBe('see here');
        expect(refs).toEqual([IMG]);
    });
});

describe('Edit keeps what the message RENDERS: spoilers stay hidden, code stays code', () => {
    /** Every image node in the parsed message, with whether a spoiler hides it. */
    function images(content: string): Array<{ alt: string; hidden: boolean }> {
        const out: Array<{ alt: string; hidden: boolean }> = [];
        const walk = (nodes: Node[], hidden: boolean) => {
            for (const n of nodes) {
                if (n.type === 'image') out.push({ alt: n.alt, hidden });
                if ('children' in n) walk(n.children, hidden || n.type === 'spoiler');
            }
        };
        walk(parseMessage(content), false);
        return out;
    }
    const A = `![a.png](sovereign-enc:${ID}?k=${KEY}&m=image%2Fpng)`;

    it('a picture inside a WIDER spoiler span (text first) is still hidden after an edit', () => {
        const original = `||secret text ${A}||`;
        expect(images(original)).toEqual([{ alt: 'a.png', hidden: true }]); // positive control
        const { text, refs } = splitEditableContent(original);
        expectNoSecrets(text);
        const saved = joinEditedContent(text.replace('secret', 'hidden'), refs);
        expect(images(saved)).toEqual([{ alt: 'a.png', hidden: true }]);
    });

    it('a picture OPENING a wider spoiler span (caption after) is still hidden, and no stray bars', () => {
        const original = `||${A} caption||`;
        expect(images(original)).toEqual([{ alt: 'a.png', hidden: true }]); // positive control
        const { text, refs } = splitEditableContent(original);
        expectNoSecrets(text);
        // The caption is still the spoilered caption, not "caption||".
        expect(text).not.toMatch(/^caption\|\|$/);
        expect(parseMessage(text).some(n => n.type === 'spoiler')).toBe(true);
        const saved = joinEditedContent(text.replace('caption', 'changed'), refs);
        expect(images(saved)).toEqual([{ alt: 'a.png', hidden: true }]);
    });

    it('an unchanged wide-spoiler message still round-trips to the same rendering', () => {
        for (const original of [`||secret text ${A}||`, `||${A} caption||`]) {
            const { text, refs } = splitEditableContent(original);
            expect(images(joinEditedContent(text, refs)), original).toEqual(images(original));
        }
    });

    it('a ref inside a code span is TEXT: Edit leaves it where it is, so it never becomes a live attachment', () => {
        for (const original of [`look \`${A}\` here`, `look\n\`\`\`\n${A}\n\`\`\`\nafter`]) {
            expect(images(original), original).toEqual([]); // positive control: renders as code, not a picture
            const { text, refs } = splitEditableContent(original);
            expect(refs, original).toEqual([]);
            expect(text, original).toBe(original);
            expect(images(joinEditedContent(text, refs)), original).toEqual([]);
        }
        // A real attachment next to the code span still comes out of the box.
        const mixed = splitEditableContent(`\`code\` ${A}`);
        expect(mixed).toEqual({ text: '`code`', refs: [A] });
    });
});

describe('messageSearchText: what search matches', () => {
    it('is the text plus each visible file NAME, never the generated kind words', () => {
        const content = `hi ${IMG} ![doc.pdf](sovereign-enc:2?k=K2&m=application%2Fpdf)`;
        const s = messageSearchText(content);
        expect(s).toContain('hi');
        expect(s).toContain('photo.png');
        expect(s).toContain('doc.pdf');
        expect(s).not.toMatch(/\bimage\b|\bfile\b/i);
        expectNoSecrets(s);
    });

    it('a spoilered file is not searchable by name (that would reveal it), nor by "spoiler"', () => {
        const s = messageSearchText(`||![twist.png](sovereign-enc:1?k=${KEY}&m=image%2Fpng)||`);
        expect(s).not.toContain('twist');
        expect(s).not.toMatch(/spoiler/i);
    });

    it('a clip post is not hit by its generated label', () => {
        expect(messageSearchText('sovereign-clip:abc')).not.toMatch(/clip/i);
    });
});
