// @vitest-environment jsdom
/**
 * A message shown ANYWHERE BUT in the message list must not print what a
 * `||spoiler||` hides: the line above a reply, the "Replying to" bar, the pinned
 * list, search results and the collection feed (all <MessagePreview>), what
 * search matches, and the words of a DM's toast. 0.9.855 and 0.9.856 made the
 * message list hide a spoiler's code, links, mentions and file names, and left
 * every one of these printing the raw `||words||`.
 *
 * The preview reads the spoilers off the SAME parse the list draws
 * (utils/messageParser), not off a pattern of its own. The property below is
 * what that buys: for generated messages, whatever the parser hides is absent
 * from the preview, and whatever it shows is present.
 *
 * What would have to break for this to go green wrongly: the generator below
 * makes messages where a hand-made pairing of `||` goes wrong (a `_` or `*` in
 * the words before, an address straight before the bars, code with bars in it),
 * and the CONTROL runs the same check against the preview as it was (the raw
 * text) and must find leaks, so a check that could not fail would fail here.
 */
import { describe, it, expect } from 'vitest';
import {
    messagePreviewSegments,
    messagePreviewText,
    messageSearchText,
    segmentLabel,
    type PreviewSegment,
} from '../api/messagePreview';
import { parseMessage, spoilerSpan, type Node } from '../utils/messageParser';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const ENC = (name: string) => `![${name}](sovereign-enc:abc?k=${KEY}&m=image%2Fpng)`;

const text = (c: string, max?: number) => messagePreviewText(c, max);

/** Words the message list reads as more than words (an emphasis in `my_file_name`, a quote, a
 *  fence, a heading), none with a file in it: a preview of them with no spoiler is them, whole. */
const WORDS_AROUND = [
    'check my_file_name', 'a_b_c', 'user_id and group_id', 'build_all_the_things', '_private and _other',
    'trailing_ and_', '100%_off_today', 'ünï_côdé_text', '# head_ing_x', '- item_one', '_a_ _b_', '__a__ and _b_',
    '> a\n> \n> b', '> a\n>\n> b', '> ```\n> code\n> ```', '```\ncode\n```', '```py\ncode_x\n```', '```a```', '<https://example.org/a_b>',
    '[x](javascript:alert(1))', 'a\\_b\\_c', '*a* _b_ **c** __d__ ~~e~~', '@bob_the_builder x_y', 'http://example.org/a_b_c and d_e',
];

describe('a preview never prints a spoiler\'s words', () => {
    const SECRET = 'thedemonisalice';
    const FORMS: Array<[string, string]> = [
        ['plain words', `before ||${SECRET}|| after`],
        ['formats', `||**${SECRET}** *x* __y__ ~~z~~||`],
        ['inline code', `||\`${SECRET}\`||`],
        ['a fenced block', `||\`\`\`py\n${SECRET}\n\`\`\`||`],
        ['a quote', `||words\n> ${SECRET}\nmore||`],
        ['a link', `||[${SECRET}](https://example.org/x)||`],
        ['a link\'s address', `||[click](https://example.org/${SECRET})||`],
        ['a bare address', `||https://example.org/${SECRET}||`],
        ['a mention', `||@${SECRET}||`],
        ['a channel', `||#${SECRET}||`],
        ['a shortcode', `||:${SECRET}:||`],
        ['everyone', `||@everyone ${SECRET}||`],
        ['a file name', `||${ENC(SECRET + '.png')}||`],
        ['words and a file', `||${SECRET} ${ENC('f.png')}||`],
        ['spaces inside the bars', `x || ${SECRET} || z`],
        ['two spoilers', `||${SECRET}|| and ||${SECRET}2||`],
        ['an underscore before', `my_file ||${SECRET}_two||`],
        ['an asterisk before', `a*b ||c*${SECRET}||`],
        ['an address right before', `https://example.org/a||${SECRET}||`],
        ['pairings that disagree', `my_file ||${SECRET}_a|| and ||${SECRET}_b||`],
        ['a bold that crosses the bars', `**a||${SECRET}** ||${SECRET}2||`],
    ];

    for (const [name, content] of FORMS) {
        it(`${name}: the words are not printed, a spoiler chip stands for them`, () => {
            const printed = text(content);
            expect(printed).not.toContain(SECRET);
            expect(printed).not.toContain('||');
            expect(printed).toMatch(/Spoiler/);
            expect(printed).not.toMatch(/sovereign-enc|k=/);
            expect(messageSearchText(content)).not.toContain(SECRET);
            // The segments say it too: the chip is a segment, not a word in the text.
            expect(messagePreviewSegments(content).some(s => s.type === 'spoiler' || (s.type === 'attachment' && s.spoiler))).toBe(true);
        });
    }

    it('the words around a spoiler are kept, markers and all', () => {
        expect(text('see **this** ||twist|| and `that`')).toBe('see **this** Spoiler and `that`');
        expect(text('a @alice b #general c :fire: ||x|| d')).toBe('a @alice b #general c :fire: Spoiler d');
        expect(text('read https://example.org/p and ||x||')).toBe('read https://example.org/p and Spoiler');
    });

    it('the words around a spoiler are kept byte for byte: an underscore stays an underscore', () => {
        // The message list reads `my_file_name` as text, an emphasis and text, and a preview
        // that wrote the emphasis back out as it likes printed `my*file*name` and made search
        // miss a message by its own words.
        for (const m of WORDS_AROUND) {
            expect(text(m), 'the words alone are the preview they always were').toBe(m);
            expect(text(`${m}\n||x||`), JSON.stringify(m)).toBe(`${m}\nSpoiler`);
            expect(text(`${m} ||x||`), JSON.stringify(m)).toBe(`${m} Spoiler`);
            expect(text(`||x||\n${m}`), JSON.stringify(m)).toBe(`Spoiler\n${m}`);
        }
        expect(text('check my_file_name ||the twist|| ok')).toBe('check my_file_name Spoiler ok');
    });

    it('search finds a message by the words around its spoiler', () => {
        const said = 'check my_file_name ||the twist|| ok';
        expect(messageSearchText(said)).toContain('my_file_name');
        expect(messageSearchText(said)).toBe('check my_file_name   ok');
        expect(messageSearchText('user_id and group_id ||x||')).toContain('group_id');
        // CONTROL: what the spoiler hides is still not found.
        expect(messageSearchText(said)).not.toContain('twist');
    });

    it('a message with no spoiler is the preview it always was, down to the byte', () => {
        for (const c of ['just text', 'line one\nline two', 'a || b', '`||code||` and more', 'a |||| b', '||', '||x', 'x||']) {
            expect(text(c)).toBe(c);
        }
    });

    it('bars the list draws as bars are printed as bars', () => {
        // In code, or with nothing to close them: the list shows them, so does the preview.
        expect(text('use `a||b||c` here')).toBe('use `a||b||c` here');
        expect(text('open ||only')).toBe('open ||only');
        expect(messagePreviewSegments('open ||only').every(s => s.type === 'text')).toBe(true);
    });

    it('a file in a spoiler is still "Spoiler image", name hidden, and words beside it are covered', () => {
        const only = messagePreviewSegments(`||${ENC('secret.png')}||`);
        expect(only).toEqual([{ type: 'attachment', kind: 'image', name: 'secret.png', spoiler: true }]);
        expect(text(`||${ENC('secret.png')}||`)).toBe('Spoiler image');
        const both = messagePreviewSegments(`||the twist ${ENC('end.png')}||`);
        expect(both.map(s => s.type)).toEqual(['spoiler', 'text', 'attachment']);
        expect(text(`||the twist ${ENC('end.png')}||`)).toBe('Spoiler Spoiler image');
        expect(text(`||the twist ${ENC('end.png')}||`)).not.toContain('twist');
    });

    it('a cut never lands inside a spoiler: the words are covered before the count', () => {
        const printed = text(`aaaaaaaaaa ||${SECRET}||`, 12);
        expect(printed).not.toContain('thedemon');
        expect(printed.startsWith('aaaaaaaaaa ')).toBe(true);
        // The chip counts as its own label, so the cut is after it, not in it.
        expect(text(`||${SECRET}|| tail words here`, 9)).toBe('Spoiler t…');
        expect(text(`||${SECRET}||`, 3)).toBe('Spoiler');
    });

    it('Quote keeps the bars, and only when asked: the quote is a spoiler too', () => {
        const content = `a ||b|| ${ENC('c.png')}`;
        expect(messagePreviewText(content, undefined, { spoilers: 'keep' })).toBe('a ||b|| Image: c.png');
        // Default: hidden. (The control: asking for `keep` really does print them.)
        expect(messagePreviewText(content)).toBe('a Spoiler Image: c.png');
        // A spoilered file is "Spoiler image" in both: its name was never copied.
        expect(messagePreviewText(`||${ENC('s.png')}||`, undefined, { spoilers: 'keep' })).toBe('Spoiler image');
    });

    it('search does not match what a spoiler hides, nor the word the chip says', () => {
        const found = (content: string, needle: string) => messageSearchText(content).toLowerCase().includes(needle);
        expect(found(`ending ||${SECRET}||`, 'ending')).toBe(true);
        expect(found(`ending ||${SECRET}||`, 'demon')).toBe(false);
        expect(found(`ending ||${SECRET}||`, 'spoiler')).toBe(false);
        // CONTROL: unspoilered, the same words are found.
        expect(found(`ending ${SECRET}`, 'demon')).toBe(true);
    });

    it('the chip\'s own character cannot be typed in', () => {
        // A private-use character stands for the words while the text is read. One typed in
        // is not a spoiler, and is not left standing for one.
        const typed = String.fromCharCode(0xe000);
        const segs = messagePreviewSegments(`a${typed}b`);
        expect(segs.every(s => s.type === 'text')).toBe(true);
        expect(segs.map(s => (s as { text: string }).text).join('')).not.toContain(typed);
        expect(messagePreviewSegments(`a${typed}b ||c||`).filter(s => s.type === 'spoiler')).toHaveLength(1);
    });

    it('labels: a spoiler segment has a label and a display name, "Spoiler", with no words', () => {
        const seg: Exclude<PreviewSegment, { type: 'text' }> = { type: 'spoiler' };
        expect(segmentLabel(seg)).toBe('Spoiler');
    });
});

// ---- The property, against the parser the list draws with ------------------------------------------

/** mulberry32: a seeded generator, so a failure names a message that can be run again. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TOKEN = /(?:sec|vis)\d+x/g;

/** Every token in a node's own words (what the list prints for it, or hides). */
function wordsOf(n: Node): string {
    switch (n.type) {
        case 'text': case 'code': case 'codeblock': return n.value;
        case 'url': return n.href;
        case 'link': return `${n.label} ${n.href}`;
        case 'image': return n.alt;
        case 'mentionUser': case 'channel': case 'emoji': return n.name;
        default: return '';
    }
}

/** A file's ref has its own rule in the preview (a name is hidden wherever an odd number of
 *  bars come before it, code or not: api/messagePreview.ts insideSpoiler), which only ever
 *  hides more. So what is SHOWN is asked of everything but a file's name. */
const FILE_REF = /!?\[[^\]]*\]\(\s*sovereign-enc:[^)]*\)/g;

function tokensByVisibility(nodes: Node[], under = false, out = { hidden: new Set<string>(), shown: new Set<string>() }) {
    for (const n of nodes) {
        if ('children' in n) tokensByVisibility(n.children, under || n.type === 'spoiler', out);
        else {
            const words = wordsOf(n);
            for (const t of words.match(TOKEN) ?? []) if (under) out.hidden.add(t);
            if (!under) for (const t of words.replace(FILE_REF, ' ').match(TOKEN) ?? []) out.shown.add(t);
            if (!under && n.type === 'image') out.shown.delete(n.alt.match(TOKEN)?.[0] ?? '');
        }
    }
    return out;
}

const WRAPS: Array<(s: string) => string> = [
    s => s, s => `**${s}**`, s => `*${s}*`, s => `_${s}_`, s => `__${s}__`, s => `~~${s}~~`,
    s => `\`${s}\``, s => `[${s}](https://example.org/p)`, s => `[lnk](https://example.org/${s})`,
    s => `https://example.org/${s}`, s => `@${s}`, s => `#${s}`, s => `:${s}:`,
    s => `![${s}](sovereign-enc:abc?k=${KEY}&m=image%2Fpng)`, s => `\`\`\`\n${s}\n\`\`\``, s => `> ${s}`,
    s => `${s} ${s.replace('sec', 'sec9')}`,
];
const GLUE = [' ', ' and ', '_', '__', '*', '**', '~~', '\n', ' (', ') ', ' https://example.org/v_', '`', ' my_file ', ' a*b '];

function generate(next: () => number): string {
    let count = 0;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const secret = () => `sec${++count}x`;
    const visible = () => `vis${++count}x`;
    const parts: string[] = [];
    const n = 2 + Math.floor(next() * 5);
    for (let i = 0; i < n; i++) {
        const roll = next();
        if (roll < 0.45) parts.push(`||${pick(WRAPS)(secret())}||`);
        else if (roll < 0.55) parts.push(`||${pick(WRAPS)(secret())} ${pick(WRAPS)(secret())}||`);
        else if (roll < 0.62) parts.push('||');
        else if (roll < 0.7) parts.push(`\`a||${visible()}\``);
        else parts.push(pick(WRAPS)(visible()));
        parts.push(pick(GLUE));
    }
    return parts.join('');
}

describe('property: whatever the parser hides is not in the preview, whatever it shows is', () => {
    const MESSAGES = 1500;

    function sweep(preview: (c: string) => string) {
        const next = rng(0x5eed);
        let leaks = 0;
        let lost = 0;
        let withSpoiler = 0;
        const firstLeak: string[] = [];
        const firstLost: string[] = [];
        for (let i = 0; i < MESSAGES; i++) {
            const content = generate(next);
            const { hidden, shown } = tokensByVisibility(parseMessage(content));
            if (hidden.size) withSpoiler++;
            const printed = preview(content);
            if ([...hidden].some(t => !shown.has(t) && printed.includes(t))) { leaks++; if (firstLeak.length < 3) firstLeak.push(content); }
            if ([...shown].some(t => !printed.includes(t))) { lost++; if (firstLost.length < 3) firstLost.push(content); }
        }
        return { leaks, lost, withSpoiler, firstLeak, firstLost };
    }

    it('the preview hides every token the list hides and loses none of the ones it shows', () => {
        const r = sweep(c => messagePreviewText(c));
        expect(r.withSpoiler).toBeGreaterThan(MESSAGES / 2); // the generator really makes spoilers
        expect(r.firstLeak).toEqual([]);
        expect(r.leaks).toBe(0);
        expect(r.firstLost).toEqual([]);
        expect(r.lost).toBe(0);
        // The search text is held to the same.
        const s = sweep(c => messageSearchText(c));
        expect(s.leaks).toBe(0);
    });

    it('CONTROL: the preview as it was (the raw words) leaks in the same sweep', () => {
        const r = sweep(c => c);
        expect(r.leaks).toBeGreaterThan(MESSAGES / 3);
    });

    it('CONTROL: a pattern of its own (the nearest pair of bars) still leaks where the list pairs them another way', () => {
        const r = sweep(c => c.replace(/\|\|[\s\S]*?\|\|/g, 'Spoiler'));
        expect(r.leaks).toBeGreaterThan(0);
    });
});

// ---- The property: a spoiler changes nothing but its own place -------------------------------------

/** A message with no spoiler in it, made of the same pieces: marked-up words, words that only
 *  look marked up, and the delimiters between them left open or closed as the dice fall. */
function generatePlain(next: () => number): string {
    let count = 0;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const parts: string[] = [];
    const n = 1 + Math.floor(next() * 5);
    for (let i = 0; i < n; i++) {
        parts.push(next() < 0.35 ? pick(WORDS_AROUND) : pick(WRAPS)(`vis${++count}x`));
        parts.push(pick(GLUE));
    }
    return parts.join('');
}

describe('property: a spoiler added to a message changes nothing but its own place', () => {
    const MESSAGES = 1500;

    function sweep(preview: (c: string) => string, tail: boolean) {
        const next = rng(0xa11e);
        const broken: string[] = [];
        for (let i = 0; i < MESSAGES; i++) {
            const plain = generatePlain(next);
            const spoiled = tail ? `${plain} ||x||` : `||x||\n${plain}`;
            const want = tail ? `${preview(plain)} Spoiler` : `Spoiler\n${preview(plain)}`;
            if (preview(spoiled) !== want && broken.length < 3) broken.push(JSON.stringify([spoiled, preview(spoiled), want]));
        }
        return broken;
    }

    it('after the words: the preview is the words\' own preview and the chip', () => {
        expect(sweep(c => messagePreviewText(c), true)).toEqual([]);
    });

    it('before the words, on a line of its own', () => {
        expect(sweep(c => messagePreviewText(c), false)).toEqual([]);
    });

    it('search text: the same words are there, and the chip says nothing', () => {
        const next = rng(0xbeef);
        for (let i = 0; i < MESSAGES; i++) {
            const plain = generatePlain(next);
            // Search reads the words and a file's name, so compare it with the plain message's own.
            expect(messageSearchText(`${plain} ||x||`).trimEnd(), JSON.stringify(plain)).toBe(messageSearchText(plain).trimEnd());
        }
    });

    it('every spoiler the parse draws was typed between a pair of bars, where the span says', () => {
        const next = rng(0x5eed);
        let spoilers = 0;
        const wrong: string[] = [];
        const walk = (content: string, nodes: Node[]) => {
            for (const n of nodes) {
                if (n.type === 'spoiler') {
                    spoilers++;
                    const span = spoilerSpan(n);
                    const typed = span ? content.slice(span[0], span[1]) : '';
                    if (!(typed.length >= 4 && typed.startsWith('||') && typed.endsWith('||')) && wrong.length < 3) wrong.push(JSON.stringify([content, span]));
                }
                if ('children' in n) walk(content, n.children);
            }
        };
        for (let i = 0; i < MESSAGES; i++) {
            const content = generate(next);
            walk(content, parseMessage(content));
        }
        expect(spoilers).toBeGreaterThan(MESSAGES);
        expect(wrong).toEqual([]);
    });

    it('CONTROL: the message written back out from its parse (what the preview did) fails it', () => {
        // A tree written back out gives `*` for the `_` that made an emphasis: the sweep must see it.
        const asWritten = (c: string) => c.replace(/(\w)_(\w)/g, '$1*$2');
        expect(sweep(c => (c.includes('||') ? asWritten(messagePreviewText(c)) : messagePreviewText(c)), true).length).toBeGreaterThan(0);
    });
});
