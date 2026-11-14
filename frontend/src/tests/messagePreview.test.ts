// @vitest-environment jsdom
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
import { parseMessage, typedSpan, type Node } from '../utils/messageParser';
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

    it('an old octet-stream ref named .mp3 is audio, as the message list plays it', () => {
        const content = `[old-song.mp3](sovereign-enc:5?k=K5SECRETK5&m=application%2Foctet-stream)`
            + ` [notes.txt](sovereign-enc:6?k=K6SECRETK6&m=application%2Foctet-stream)`;
        expect(messagePreviewSegments(content).filter(s => s.type === 'attachment')).toEqual([
            { type: 'attachment', kind: 'audio', name: 'old-song.mp3', spoiler: false },
            { type: 'attachment', kind: 'file', name: 'notes.txt', spoiler: false },
        ]);
        expect(messagePreviewText(content)).toBe('Audio: old-song.mp3 File: notes.txt');
    });

    it('follows the player rule exactly: audio the message list will not play previews as a file', () => {
        // The message list asks audioMimeFor (after videoMimeFor); a playlist
        // type and AMR get the download chip there, so a music note here
        // would promise a player the message does not have.
        const content = `[list.m3u](sovereign-enc:7?k=K7SECRETK7&m=audio%2Fx-mpegurl)`
            + ` [memo.amr](sovereign-enc:8?k=K8SECRETK8&m=audio%2Famr)`
            + ` [voice-1.webm](sovereign-enc:9?k=K9SECRETK9&m=audio%2Fwebm%3Bcodecs%3Dopus)`
            + ` [take.m4a](sovereign-enc:10?k=K10SECRETK10&m=audio%2Fx-m4a)`;
        expect(messagePreviewSegments(content).filter(s => s.type === 'attachment')).toEqual([
            { type: 'attachment', kind: 'file', name: 'list.m3u', spoiler: false },
            { type: 'attachment', kind: 'file', name: 'memo.amr', spoiler: false },
            // Controls: a Púca Notes recording and Windows' .m4a type still play.
            { type: 'attachment', kind: 'audio', name: 'voice-1.webm', spoiler: false },
            { type: 'attachment', kind: 'audio', name: 'take.m4a', spoiler: false },
        ]);
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

    it('a bare ref the list draws as code or in an address stays where it is; one it draws as words comes out', () => {
        for (const original of [`see \`sovereign-enc:abc?k=${KEY}\` ok`, `go https://x.org/sovereign-enc:abc ok`, `\`\`\`\nsovereign-enc:abc?k=${KEY}\n\`\`\``]) {
            expect(splitEditableContent(original), original).toEqual({ text: original, refs: [] });
        }
        // CONTROL: the same ref in words.
        expect(splitEditableContent(`see sovereign-enc:abc?k=${KEY} ok`).refs).toEqual([`sovereign-enc:abc?k=${KEY}`]);
    });

    it('a bare ref comes out as far as its words go, and takes nothing the list draws after it', () => {
        // A pattern of what an address holds took the backtick after it: the code it opened was gone from
        // the box, and the save drew the spoilered file in the clear.
        const S = `||[secret.pdf](sovereign-enc:${ID}?k=K1&m=application%2Fpdf)||`;
        const coded = `see sovereign-enc:abc?k=${KEY}\`||\` ${S}`;
        const { text, refs } = splitEditableContent(coded);
        expect(text).toBe('see `||`');
        expect(refs).toEqual([`sovereign-enc:abc?k=${KEY}`, S]);
        const saved = parseMessage(joinEditedContent(`${text} more`, refs));
        expect(saved.find(n => n.type === 'code')).toEqual({ type: 'code', value: '||' });
        expect(saved.some(n => n.type === 'spoiler' && n.children.some(c => c.type === 'link' && c.label === 'secret.pdf'))).toBe(true);
        // Nor the `[` of a link it runs into.
        expect(splitEditableContent(`see sovereign-enc:abc?k=${KEY}[docs](https://example.org) ok`))
            .toEqual({ text: 'see [docs](https://example.org) ok', refs: [`sovereign-enc:abc?k=${KEY}`] });
        // A `_` in a key the list reads as emphasis: cut there, the emphasis would pair the bars after it
        // otherwise. It stays as the list draws it, key and all.
        const marked = 'see sovereign-enc:abc?k=A_B_C ok';
        expect(splitEditableContent(marked)).toEqual({ text: marked, refs: [] });
    });

    it('an address in what looks like a file and is drawn as words comes out of the box too', () => {
        // An empty label, a space before the `)` or after the `(`: the list draws words, key and all.
        for (const [original, text] of [
            [`look [](sovereign-enc:abc?k=${KEY}&m=application%2Fpdf) here`, 'look []( ) here'],
            [`look [a.pdf](sovereign-enc:abc?k=${KEY} ) here`, 'look [a.pdf]( ) here'],
            [`[a.pdf]( sovereign-enc:abc?k=${KEY})`, '[a.pdf]( )'],
        ]) {
            expect(parseMessage(original).every(n => n.type === 'text'), original).toBe(true); // positive control: words
            const split = splitEditableContent(original);
            expect(split.text, original).toBe(text);
            expect(split.text).not.toContain(KEY);
            expect(split.text).not.toMatch(/sovereign-enc/i);
            expect(split.refs, original).toHaveLength(1);
        }
    });

    it('a file the message DRAWS comes out of the box, where a pattern of its own saw code', () => {
        // A backtick, a file and a fence never closed: the list draws the file, and `` `[^`]+` `` read a
        // span of code from the backtick to the fence, so Edit left the file, key and all, in the box.
        const F = `[g.pdf](sovereign-enc:${ID}?k=${KEY}&m=application%2Fpdf&c=${CAP})`;
        for (const [original, ref] of [[`\`${F}\`\`\``, F], [`\`${A}\`\`\``, A], [`a \`b ${A} c\n\`\`\`\nd`, A]]) {
            expect(JSON.stringify(parseMessage(original)), original).toContain(ref.slice(ref.indexOf('](') + 2, -1)); // positive control: drawn
            const { text, refs } = splitEditableContent(original);
            expectNoSecrets(text);
            expect(refs, original).toEqual([ref]);
            // Saved, it is still drawn, and so are the words.
            const saved = parseMessage(joinEditedContent(text, refs));
            expect(saved.some(n => (n.type === 'link' || n.type === 'image') && ref.includes(n.href)), original).toBe(true);
        }
    });

    it('a file the message hides stays hidden, whichever bars the list says hide it', () => {
        // Each stretch between two `||` is a spoiler here: the readings disagree. Two bars come before the
        // second file, so counting them said it was in none, and Edit took it out as a file in the clear.
        const B = `[secret.pdf](sovereign-enc:${ID}?k=${KEY}&m=application%2Fpdf)`;
        const original = `_||[_](sovereign-enc:abc?k=K1)||${B}||`;
        const hiddenFiles = (content: string) => {
            const out: string[] = [];
            const walk = (nodes: Node[], under: boolean) => {
                for (const n of nodes) {
                    if (n.type === 'link' && under) out.push(n.label);
                    if ('children' in n) walk(n.children, under || n.type === 'spoiler');
                }
            };
            walk(parseMessage(content), false);
            return out;
        };
        expect(hiddenFiles(original)).toEqual(['_', 'secret.pdf']); // positive control
        // NEGATIVE CONTROL: an even number of bars before it.
        expect((original.slice(0, original.indexOf('[secret')).match(/\|\|/g) ?? []).length % 2).toBe(0);
        const { text, refs } = splitEditableContent(original);
        expectNoSecrets(text);
        expect(refs).toEqual(['||[_](sovereign-enc:abc?k=K1)||', `||${B}||`]);
        expect(hiddenFiles(joinEditedContent(text, refs))).toEqual(['_', 'secret.pdf']);
        expect(hiddenFiles(joinEditedContent(`${text} more`, refs))).toEqual(['_', 'secret.pdf']);
    });

    it('words that leave a `||` open do not take a hidden file\'s bars: it goes first, still hidden', () => {
        const P = (n: number) => `![p${n}.png](sovereign-enc:i${n}?k=K${n}_Z&m=image%2Fpng)`;
        const D = `[d2.pdf](sovereign-enc:i2?k=K2_Z&m=application%2Fpdf)`;
        const original = `b_c\`||${P(0)}||${D}**${P(1)}||*[**`;
        const hidden = (content: string) => {
            const out = new Map<string, boolean>();
            const walk = (nodes: Node[], under: boolean) => {
                for (const n of nodes) {
                    if (n.type === 'image' || n.type === 'link') out.set(n.type === 'image' ? n.alt : n.label, under);
                    if ('children' in n) walk(n.children, under || n.type === 'spoiler');
                }
            };
            walk(parseMessage(content), false);
            return out;
        };
        const before = hidden(original);
        expect([...before.values()]).toEqual([true, true, true]); // positive control: all three are hidden
        const { text, refs } = splitEditableContent(original);
        expect(text).toBe('b_c`|| || ** ||*[**');
        // CONTROL: the words first, as the composer sends them, draws p0 in the clear.
        expect(hidden(`${text} ${refs.join(' ')}`).get('p0.png')).toBe(false);
        const saved = joinEditedContent(text, refs);
        expect(hidden(saved)).toEqual(before);
        expect(saved.startsWith(refs.join(' '))).toBe(true);
    });
});

// ---- Edit, as a property: what the list draws ----------------------------------------------------------

describe('property: Edit takes out the files the list draws, and puts each back as it was drawn', () => {
    /** Every file the list draws, with whether a spoiler hides it. */
    const drawnFiles = (content: string) => {
        const out: Array<{ href: string; hidden: boolean }> = [];
        const walk = (nodes: Node[], hidden: boolean) => {
            for (const n of nodes) {
                if ((n.type === 'image' || n.type === 'link') && /^sovereign-(?:enc|clip):/i.test(n.href)) out.push({ href: n.href, hidden });
                if ('children' in n) walk(n.children, hidden || n.type === 'spoiler');
            }
        };
        walk(parseMessage(content), false);
        return out;
    };
    // Files (F, G), a bare ref someone typed (B), and what a ref can run into: code, a link, markup, bars.
    const PARTS = ['||', '||', '_', '*', '`', '```', '\n```\n', ' ', ' ', 'a', 'b_c', '\n> ', '[', '](', 'F', 'F', 'G', 'B', '||F||', '~~', '**', 'https://x/a_b', '[w](https://x/a)'];
    const messages = () => {
        let seed = 99;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        const out: string[] = [];
        for (let k = 0; k < 24000; k++) {
            let id = 0;
            const content = Array.from({ length: 1 + next(10) }, () => PARTS[next(PARTS.length)]).join('')
                .replace(/F/g, () => `![p${id}.png](sovereign-enc:i${id}?k=K${id++}_Z&m=image%2Fpng)`)
                .replace(/G/g, () => `[d${id}.pdf](sovereign-enc:i${id}?k=K${id++}_Z&m=application%2Fpdf)`)
                .replace(/B/g, () => `sovereign-enc:b${id}?k=K${id++}_Z`);
            if (drawnFiles(content).length) out.push(content);
        }
        return out;
    };
    const MESSAGES = messages();

    /** What Edit used to take out: every whole ref a pattern finds, but in what a pattern of its own takes for code. */
    const byPattern = (content: string) => {
        const code = Array.from(content.matchAll(/```[\s\S]*?```|`[^`]+`/g), m => [m.index, m.index + m[0].length]);
        let text = content;
        for (const m of content.matchAll(/(\|\|)?(!?)\[([^[\]\n]*)\]\(\s*(sovereign-(?:enc|clip):[^)\s]*)\s*\)(\|\|)?/gi)) {
            if (!code.some(([a, b]) => m.index >= a && m.index < b)) text = text.replace(m[0], '');
        }
        return text;
    };

    it('no file the list draws is left in the box, key and all', () => {
        expect(MESSAGES.length).toBeGreaterThan(10000);
        const left = MESSAGES.filter(c => drawnFiles(c).some(f => splitEditableContent(c).text.includes(f.href)));
        expect(left.slice(0, 3)).toEqual([]);
        // NEGATIVE CONTROL: the pattern of its own left hundreds.
        expect(MESSAGES.filter(c => drawnFiles(c).some(f => byPattern(c).includes(f.href))).length).toBeGreaterThan(100);
    });

    it('nothing the list draws as code, a link, an address or a name is cut out of the box', () => {
        const cut: string[] = [];
        for (const content of MESSAGES) {
            const { text } = splitEditableContent(content);
            const walk = (nodes: Node[]) => {
                for (const n of nodes) {
                    const span = typedSpan(n);
                    const drawnAs = span && n.type !== 'text' && n.type !== 'spoiler' && !((n.type === 'image' || n.type === 'link') && /^sovereign-/i.test(n.href));
                    if (drawnAs && !text.includes(content.slice(span[0], span[1])) && cut.length < 3) cut.push(JSON.stringify([content, text]));
                    if ('children' in n) walk(n.children);
                }
            };
            walk(parseMessage(content));
        }
        expect(cut).toEqual([]);
    });

    it('saved, its words changed or not, every file is drawn again, and each that was hidden is hidden', () => {
        const wrong: string[] = [];
        let firstWouldUnhide = 0;
        for (const content of MESSAGES) {
            const before = drawnFiles(content);
            const { text, refs } = splitEditableContent(content);
            for (const words of [text, `${text} more`]) {
                const after = drawnFiles(joinEditedContent(words, refs));
                const ok = before.every(f => {
                    const same = after.filter(a => a.href === f.href);
                    return same.length > 0 && (!f.hidden || same.every(a => a.hidden));
                });
                if (!ok && wrong.length < 3) wrong.push(JSON.stringify([content, words]));
            }
            // CONTROL: the words always first.
            const plain = drawnFiles(text.trim() && refs.length ? `${text.trim()} ${refs.join(' ')}` : text.trim() || refs.join(' '));
            if (before.some(f => f.hidden && plain.some(a => a.href === f.href && !a.hidden))) firstWouldUnhide++;
        }
        expect(wrong).toEqual([]);
        expect(firstWouldUnhide).toBeGreaterThan(100);
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
