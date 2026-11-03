import { describe, it, expect } from 'vitest';
import { parseMessage, extractMentions, isSafeUrl, type Node } from '../utils/messageParser';
import { messageMentionsUser } from '../utils/messageMentions';
import { parseMessage as parsedAsItWas } from './fixtures/messageParserAsItWas';

// Helper: flatten a node tree back to plain text for concise assertions.
function text(nodes: Node[]): string {
    return nodes
        .map((n) => {
            switch (n.type) {
                case 'text': return n.value;
                case 'code': return n.value;
                case 'codeblock': return n.value;
                case 'url': return n.href;
                case 'link': return n.label;
                case 'image': return n.alt;
                case 'mentionUser': return '@' + n.name;
                case 'mentionEveryone': return '@everyone';
                case 'mentionHere': return '@here';
                case 'channel': return '#' + n.name;
                case 'emoji': return ':' + n.name + ':';
                default: return 'children' in n ? text(n.children) : '';
            }
        })
        .join('');
}

describe('markdown', () => {
    it('parses bold, italic, underline, strike, spoiler', () => {
        expect(parseMessage('**b**')[0]).toMatchObject({ type: 'strong' });
        expect(parseMessage('*i*')[0]).toMatchObject({ type: 'em' });
        expect(parseMessage('__u__')[0]).toMatchObject({ type: 'underline' });
        expect(parseMessage('~~s~~')[0]).toMatchObject({ type: 'strike' });
        expect(parseMessage('||spoiler||')[0]).toMatchObject({ type: 'spoiler' });
    });

    it('nests formatting', () => {
        const nodes = parseMessage('**bold _and italic_**');
        expect(nodes[0].type).toBe('strong');
        const inner = (nodes[0] as Extract<Node, { type: 'strong' }>).children;
        expect(inner.some((n: Node) => n.type === 'em')).toBe(true);
        expect(text(nodes)).toBe('bold and italic');
    });

    it('parses inline code without inner formatting', () => {
        const nodes = parseMessage('use `**not bold**` here');
        const code = nodes.find((n) => n.type === 'code') as Extract<Node, { type: 'code' }>;
        expect(code.value).toBe('**not bold**');
    });

    it('parses fenced code blocks with a language tag', () => {
        const nodes = parseMessage('```js\nconst x = 1;\n```');
        expect(nodes[0]).toMatchObject({ type: 'codeblock', lang: 'js', value: 'const x = 1;' });
    });

    it('parses fenced code block without a language', () => {
        const nodes = parseMessage('```\nplain\n```');
        expect(nodes[0]).toMatchObject({ type: 'codeblock', lang: null, value: 'plain' });
    });

    it('parses blockquotes', () => {
        const nodes = parseMessage('> quoted line');
        expect(nodes[0].type).toBe('blockquote');
        expect(text(nodes)).toBe('quoted line');
    });

    it('a quote takes every quoted line after it, and stops at the first that is not', () => {
        expect(parseMessage('> a\n>\n> b\nc\n> d')).toEqual([
            { type: 'blockquote', children: [{ type: 'text', value: 'a\n\nb' }] },
            { type: 'text', value: 'c\n' },
            { type: 'blockquote', children: [{ type: 'text', value: 'd' }] },
        ]);
    });

    it.each(['>', '> ', '>\n', '> a\n', '> a\n> b', '> a\n>\n> b', '> a\n\n> b', '>\n>\n', '>\n\n>\n\n', '> a\n>b', '>a\n> b', 'a\n> b\nc', '> a\r\n> b', '> a\n> b\n\n'])(
        'a quote ends where it always did: %j',
        (content) => {
            expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        },
    );

    it('parses links and bare URLs', () => {
        expect(parseMessage('[site](https://example.com)')[0]).toMatchObject({
            type: 'link', href: 'https://example.com', label: 'site',
        });
        const bare = parseMessage('see https://example.com/x now');
        expect(bare.find((n) => n.type === 'url')).toMatchObject({ href: 'https://example.com/x' });
    });

    it('does not let user text spoof the old placeholder scheme', () => {
        // Previously `__BOLD_0__` could impersonate rendered markup.
        const nodes = parseMessage('literally __BOLD_0__ text');
        // Rendered text must contain the raw string, not a bold node from index 0.
        expect(text(nodes)).toContain('BOLD_0');
    });
});

/** Every address in a message, as the message links it. */
function hrefs(content: string): string[] {
    const out: string[] = [];
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if (n.type === 'url' || n.type === 'link' || n.type === 'image') out.push(n.href);
            else if ('children' in n) walk(n.children);
        }
    };
    walk(parseMessage(content));
    return out;
}

describe('an address ending in a bracket it opened keeps it', () => {
    const RUST = 'https://example.org/wiki/Rust_(programming_language)';

    it.each([
        ['alone', RUST, RUST],
        ['in a sentence', `read ${RUST} today`, RUST],
        ['at the end of a sentence', `read ${RUST}.`, RUST],
        ['before a comma', `${RUST}, and more`, RUST],
        ['in brackets', `(see ${RUST})`, RUST],
        ['in brackets, and a full stop', `(see ${RUST}).`, RUST],
        ['in bold', `**${RUST}**`, RUST],
        ['(v=vs.85)', 'https://example.org/library/ms123(v=vs.85)', 'https://example.org/library/ms123(v=vs.85)'],
        ['one with a full stop in it', 'https://example.org/wiki/Speaker_(U.S.)', 'https://example.org/wiki/Speaker_(U.S.)'],
        ['two in one address', 'https://example.org/a_(b)_(c)', 'https://example.org/a_(b)_(c)'],
        ['one inside another', 'https://example.org/a_(b_(c))', 'https://example.org/a_(b_(c))'],
        ['one after a stray one', 'https://example.org/a)(b)', 'https://example.org/a)(b)'],
    ])('%s', (_, content, href) => {
        expect(hrefs(content)).toEqual([href]);
    });

    it('the bracket after it is still words', () => {
        expect(parseMessage(`(see ${RUST})`)).toEqual([
            { type: 'text', value: '(see ' },
            { type: 'url', href: RUST },
            { type: 'text', value: ')' },
        ]);
    });

    it.each([
        ['closes a bracket before the address', '(https://example.org/a)', 'https://example.org/a'],
        ['and a full stop', '(https://example.org/a).', 'https://example.org/a'],
        ['with a full stop inside', '(https://example.org/a.)', 'https://example.org/a'],
        ['an address with no bracket of its own', 'https://example.org/a)', 'https://example.org/a'],
        ['one opened and never closed', 'https://example.org/a(b, and then c)', 'https://example.org/a(b'],
    ])('CONTROL: a bracket that is not the address\'s: %s', (_, content, href) => {
        expect(hrefs(content)).toEqual([href]);
    });
});

describe('a delimiter in the words before an address does not close inside it', () => {
    it.each([
        ['my_file is at ', 'https://example.org/my_file.txt'],
        ['API_URL=', 'https://example.org/v1_beta'],
        ['my_repo: ', 'https://example.org/me/my_repo'],
        ['a__b at ', 'https://example.org/a__b'],
    ])('%s%s', (words, href) => {
        expect(parseMessage(words + href)).toEqual([{ type: 'text', value: words }, { type: 'url', href }]);
    });

    it('it closes after the address', () => {
        expect(parseMessage('_see https://example.org/a_b now_')).toEqual([
            { type: 'em', children: [{ type: 'text', value: 'see ' }, { type: 'url', href: 'https://example.org/a_b' }, { type: 'text', value: ' now' }] },
        ]);
        expect(parseMessage('__see https://example.org/a__b__ more')).toEqual([
            { type: 'underline', children: [{ type: 'text', value: 'see ' }, { type: 'url', href: 'https://example.org/a__b' }] },
            { type: 'text', value: ' more' },
        ]);
    });

    it('a link\'s target is an address too', () => {
        expect(parseMessage('_a [the link](https://example.org/b_c) d_')).toEqual([
            { type: 'em', children: [{ type: 'text', value: 'a ' }, { type: 'link', label: 'the link', href: 'https://example.org/b_c' }, { type: 'text', value: ' d' }] },
        ]);
    });

    it.each([
        ['**', 'strong'],
        ['*', 'em'],
        ['__', 'underline'],
        ['_', 'em'],
        ['~~', 'strike'],
    ])('it closes inside when the address ends with it: %s', (d, type) => {
        const href = 'https://example.org/a';
        const wrapped = { type, children: [{ type: 'url', href }] };
        expect(parseMessage(`${d}${href}${d}`)).toEqual([wrapped]);
        expect(parseMessage(`${d}${href}${d}, and more`)).toEqual([wrapped, { type: 'text', value: ', and more' }]);
        // URL_RE takes these into the address. They are the sentence's.
        expect(parseMessage(`${d}${href}${d}!`)).toEqual([wrapped, { type: 'text', value: '!' }]);
        expect(parseMessage(`${d}${href}${d}?`)).toEqual([wrapped, { type: 'text', value: '?' }]);
        expect(parseMessage(`${d}${href}${d}-- more`)).toEqual([wrapped, { type: 'text', value: '-- more' }]);
    });

    it('it closes at the end of an address that holds another of it', () => {
        expect(hrefs('_https://example.org/a_b_')).toEqual(['https://example.org/a_b']);
        expect(parseMessage('***https://example.org/a***')).toEqual(parsedAsItWas('***https://example.org/a***'));
    });

    it.each([
        ['**', 'strong'],
        ['*', 'em'],
        ['~~', 'strike'],
    ])('an opener right up against the address closes at the first one, whatever is glued on: %s', (d, type) => {
        const href = 'https://example.org/a';
        const wrapped = { type, children: [{ type: 'url', href }] };
        for (const after of ['\'s page', '-based', '2', '/b', 's', '\u3092\u898b\u3066']) {
            expect(parseMessage(`${d}${href}${d}${after}`)).toEqual([wrapped, { type: 'text', value: after }]);
        }
        expect(extractMentions(`${d}${href}${d}@bob`).users).toEqual(['bob']);
        expect(extractMentions(`${d}${href}${d}/@everyone`).everyone).toBe(true);
    });

    it('CONTROL: `_` and `__` are in real addresses, so more of the address after one is the address\'s', () => {
        expect(hrefs('_https://example.org/a_b')).toEqual(['https://example.org/a_b']);
        expect(hrefs('__https://example.org/a__b')).toEqual(['https://example.org/a__b']);
        expect(hrefs('_https://example.org/a_2')).toEqual(['https://example.org/a_2']);
        expect(hrefs('_https://example.org/a_/')).toEqual(['https://example.org/a_/']);
        expect(hrefs('_https://example.org/a_/b')).toEqual(['https://example.org/a_/b']);
        // A word in any script: this address is the bug this fix is for, not bold around one.
        expect(hrefs('my_file https://example.org/\u6771\u4eac_\u30bf\u30ef\u30fc')).toEqual(['https://example.org/\u6771\u4eac_\u30bf\u30ef\u30fc']);
    });

    // `*` and `~` are next to never in a real address, and stepping over one cost what
    // people do write: bold around an address or a link with something glued on after it.
    it.each([
        ['5*3 is at https://example.org/a*b'],
        ['a**b is at https://example.org/a**b'],
        ['old~~name: https://example.org/old~~name'],
        ['**https://example.org/a**b**'],
        ['~~see https://example.org/a~~b~~ more'],
        ['*see https://example.org/a*@everyone'],
    ])('every delimiter but `_` closes at the first one, as it always did: %s', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each([
        ['**', 'strong'],
        ['*', 'em'],
        ['~~', 'strike'],
    ])('words before the address, or a link, and something glued on after: %s', (d, type) => {
        const href = 'https://example.org/a';
        const link = { type: 'link', label: 'docs', href };
        for (const after of ['\'s page', '-based', 's', '\u3092\u898b\u3066']) {
            expect(parseMessage(`${d}see ${href}${d}${after}`)).toEqual([
                { type, children: [{ type: 'text', value: 'see ' }, { type: 'url', href }] },
                { type: 'text', value: after },
            ]);
            expect(parseMessage(`${d}[docs](${href})${d}${after}`)).toEqual([
                { type, children: [link] },
                { type: 'text', value: after },
            ]);
        }
    });

    it('two with a word between them are two', () => {
        const a = 'https://example.org/a';
        const b = 'https://example.org/b';
        expect(hrefs(`**${a}**\u3068**${b}**`)).toEqual([a, b]);
        expect(hrefs(`**${a}**and**${b}**`)).toEqual([a, b]);
    });

    it.each([
        ['**', 'strong', ','],
        ['**', 'strong', '/'],
        ['**', 'strong', '|'],
        ['*', 'em', ','],
        ['_', 'em', ','],
        ['__', 'underline', ','],
        ['~~', 'strike', ','],
    ])('two in one word, with only a mark between them, are two: %s%s%s', (d, type, mark) => {
        const a = 'https://example.org/a';
        const b = 'https://example.org/b';
        expect(parseMessage(`${d}${a}${d}${mark}${d}${b}${d}`)).toEqual([
            { type, children: [{ type: 'url', href: a }] },
            { type: 'text', value: mark },
            { type, children: [{ type: 'url', href: b }] },
        ]);
    });

    it('CONTROL: an address in an address is one, with no closer and opener in it', () => {
        const href = 'https://example.org/web/2020/https://example.org/a_b';
        expect(parseMessage(`_${href}_`)).toEqual([{ type: 'em', children: [{ type: 'url', href }] }]);
    });
});

describe('a spoiler never stops being one', () => {
    type Parsed = { type: string; href?: string; children?: Parsed[] };
    /** What a parse hides and what it prints, by the words in it. */
    const words = (node: unknown) => JSON.stringify(node).match(/w\d+/g) ?? [];
    const hiddenBy = (nodes: Parsed[], out = new Set<string>()) => {
        for (const n of nodes) {
            if (n.type === 'spoiler') for (const w of words(n)) out.add(w);
            else if (n.children) hiddenBy(n.children, out);
        }
        return out;
    };
    const printedBy = (nodes: Parsed[], out = new Set<string>()) => {
        for (const n of nodes) {
            if (n.type === 'spoiler') continue;
            if (n.children) printedBy(n.children, out);
            else for (const w of words(n)) out.add(w);
        }
        return out;
    };
    /** The words the parser as it was hid in `content` that `nodes` prints. */
    const leaked = (content: string, nodes: Parsed[]) => {
        const printed = printedBy(nodes);
        return [...hiddenBy(parsedAsItWas(content))].filter(w => printed.has(w));
    };
    /** The addresses under a spoiler, and those not. */
    const addresses = (content: string) => {
        const hidden: string[] = [];
        const shown: string[] = [];
        const walk = (nodes: Node[], under: boolean) => {
            for (const n of nodes) {
                if (n.type === 'url') (under ? hidden : shown).push(n.href);
                else if ('children' in n) walk(n.children, under || n.type === 'spoiler');
            }
        };
        walk(parseMessage(content), false);
        return { hidden, shown };
    };

    it.each([
        ['||https://example.org/the-butler||', 'https://example.org/the-butler'],
        ['||https://example.org/the-butler||!', 'https://example.org/the-butler'],
        ['||https://example.org/the-butler||-- more', 'https://example.org/the-butler'],
        ['||https://example.org/the-butler||b', 'https://example.org/the-butler'],
        ['||https://example.org/a_b||', 'https://example.org/a_b'],
        ['**||https://example.org/the-butler||**', 'https://example.org/the-butler'],
        ['**||https://example.org/the-butler||**!', 'https://example.org/the-butler'],
        ['_||https://example.org/a_b||_', 'https://example.org/a_b'],
        ['_||https://example.org/a_b||_!', 'https://example.org/a_b'],
        ['> ||https://example.org/the-butler||!', 'https://example.org/the-butler'],
    ])('%s', (content, href) => {
        expect(addresses(content)).toEqual({ hidden: [href], shown: [] });
    });

    it('it closes at the first `||`, even one in an address with more after it', () => {
        expect(parseMessage('||a https://example.org/b||c d||')).toEqual([
            { type: 'spoiler', children: [{ type: 'text', value: 'a ' }, { type: 'url', href: 'https://example.org/b' }] },
            { type: 'text', value: 'c d||' },
        ]);
    });

    it('two in one line', () => {
        expect(addresses('||https://example.org/a|| and ||https://example.org/b_c||!')).toEqual({
            hidden: ['https://example.org/a', 'https://example.org/b_c'],
            shown: [],
        });
        expect(addresses('||https://example.org/a||!||https://example.org/b||!')).toEqual({
            hidden: ['https://example.org/a', 'https://example.org/b'],
            shown: [],
        });
    });

    it('beside words and an address the delimiter is stepped over for, each is what it should be', () => {
        expect(addresses('my_file at https://example.org/my_file ||https://example.org/hidden||')).toEqual({
            hidden: ['https://example.org/hidden'],
            shown: ['https://example.org/my_file'],
        });
        expect(addresses('||https://example.org/hidden|| my_file at https://example.org/my_file')).toEqual({
            hidden: ['https://example.org/hidden'],
            shown: ['https://example.org/my_file'],
        });
        expect(addresses('my_file ||https://example.org/hidden|| https://example.org/my_file')).toEqual({
            hidden: ['https://example.org/hidden'],
            shown: ['https://example.org/my_file'],
        });
    });

    it('the address gives way before the spoiler does: a `_` in the spoiler, or a `||` in the address', () => {
        // Stepping over the address would close the `_` inside the spoiler.
        expect(hiddenBy(parseMessage('w0_w1 https://example.org/w2_w3 ||w4_w5||'))).toEqual(new Set(['w4', 'w5']));
        expect(hiddenBy(parseMessage('_https://example.org/w0_w1||w2||_'))).toEqual(new Set(['w2']));
    });

    it.each([
        // A `>` or `"` leaves too little of a short address, so a delimiter in it comes alive.
        ['see <https://*> and ||the *butler* did it||'],
        ['<https://*> ||https://example.org/the-butler*||'],
        ['https://_> ||_secret||'],
        ['https://`> ||secret||`'],
        ['https://[> ||secret](x)||'],
        ['https://.>_a ||secret_ c||'],
        ['http://>|| ||secret||'],
        // A closer that moved re-pairs the delimiters in later addresses.
        ['_use https://x.invalid/a_b or _a || b at https://x.invalid/c_d ||the butler did it||'],
        ['*https://x.invalid/a*b *||c https://x.invalid/d* ||secret||'],
        ['~~https://x.invalid/a~~~~ ||https://x.invalid/b~~ ||secret||'],
        // A word shaped like an address and not read as one, with a `[` or a backtick in it.
        ['my_file https://[ ||the butler|| https://x.invalid/d_e](f)'],
        ['_Https://x/[||secret||https://x/a_](b)'],
        ['_https://x.invalid/a_`b Https://x.invalid/`||`secret||'],
        ['_Https://example.org/[||https://example.org/hiddenword||_](y)'],
        // Reads as it was, and each branch of that reading is what keeps its spoiler.
        ['Https://example.org/a||secret||'],
        ['Link:https://example.org/a||secret||'],
        ['[a](https://x/(b)||secret||)'],
        ['my_file at https://example.org/my_file ||secret_word||'],
        ['**my_file at https://example.org/my_file ||secret_word||**'],
        ['> my_file at https://example.org/my_file ||secret_word||'],
        ['_||https://example.org/a|| https://example.org/b_c ||secret_ d||'],
    ])('it is read as it was where the better reading would print it: %s', (content) => {
        expect(JSON.stringify(parsedAsItWas(content))).toContain('"spoiler"');
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it('the better reading is kept where it loses nothing', () => {
        const content = 'a*b Https://example.org/c_d https://example.org/e*f ||https://example.org/g_h|| and ||the butler did it||';
        expect(addresses(content)).toEqual({
            hidden: ['https://example.org/g_h'],
            shown: ['Https://example.org/c_d', 'https://example.org/e'],
        });
        expect(parseMessage(content).filter(n => n.type === 'spoiler').map(n => text([n]))).toEqual(['https://example.org/g_h', 'the butler did it']);
    });

    it.each([
        ['a word', 'secret'],
        ['a word in another script', '\u79d8\u5bc6'],
        ['a mark', ':)'],
        ['code', '`secret`'],
        ['an address', 'https://example.org/secret'],
        ['a link', '[secret](x)'],
        ['a link\'s address', '[x](secret)'],
        ['a picture', '![secret](x)'],
        ['someone mentioned', '@secret'],
        ['everyone', '@everyone'],
        ['here', '@here'],
        ['a channel', '#secret'],
        ['an emoji', ':secret:'],
    ])('whatever it hid counts: %s', (_, hidden) => {
        // Stepped over, the address lets this `_` close inside the spoiler, and it all prints.
        const content = `_https://example.org/a_b ||${hidden} _ ||`;
        expect(parsedAsItWas(content).some(n => n.type === 'spoiler')).toBe(true);
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it('a word it hid twice has to stay hidden twice, wherever else it is said', () => {
        const content = '||a|| _https://example.org/w_w ||a_ a||';
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it('CONTROL: a word it did not hide is free to be read better, and one it would still hide is too', () => {
        // Every word of the spoiler is hidden both ways, and the address is whole.
        expect(addresses('my_file ||https://example.org/hidden|| https://example.org/my_file').shown).toEqual(['https://example.org/my_file']);
        // Nothing was hidden: this was never a spoiler, and now it is.
        expect(parsedAsItWas('_||https://example.org/a_b||_').some(n => n.type === 'spoiler')).toBe(false);
        expect(addresses('_||https://example.org/a_b||_').hidden).toEqual(['https://example.org/a_b']);
    });

    // What goes wrong, in any order. Everything the parser as it was hid must not be printed now.
    const PARTS = ['||', '||', '||', '**', '*', '__', '_', '_', '~~', '`', ' ', ' ', ' ', 'W', 'W', 'W',
        'https://x/W', 'https://x/W_W', 'https://x/W*W', 'https://x/W~~W', 'Https://x/W', 'Https://x/W_W',
        'HTTP://x/W*W', 'https://x/W||W', 'Https://x/W||W', ':', '://', ':https:', '//', ':W_W:', '@W', '#W_W',
        '(', ')', '[W](', ']', '![W](', '!', '.', ',', '>', '"', '<', '\n', '> ', 'W_W', 'W*W', 'W~~W',
        'https://x/(W', 'https://x/W)', 'Link:https://x/W_W', 'Link:Https://x/W', '[W](https://x/(W)', '-', '?',
        'https://*>', 'https://_>', 'https://[', 'https://`>', 'Https://x/[W', 'https://x/W**', 'https://x/W>_W', 'https://x/W"*W',
        '@W_', '@W_.', '#W_'];

    it.each<[number, number, string]>([
        [20261103, 10, ''],
        [8, 10, ''],
        [5, 16, ''],
        [1, 24, ''],
        [2, 40, ''],
        [3, 16, ' '],
        [4, 40, ' '],
    ])('as a property, over text made of what goes wrong: seed %i, up to %i parts, joined by "%s"', (start, parts, between) => {
        let seed = start;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        let spoilers = 0;
        const bad: string[] = [];
        for (let k = 0; k < 30000; k++) {
            let id = 0;
            const pieces: string[] = [];
            for (let j = 1 + next(parts); j > 0; j--) pieces.push(PARTS[next(PARTS.length)].replace(/W/g, () => `w${id++}`));
            const content = pieces.join(between);
            if (hiddenBy(parsedAsItWas(content)).size) spoilers++;
            const out = leaked(content, parseMessage(content));
            if (out.length) bad.push(`${JSON.stringify(content)} prints ${out.join(', ')}`);
        }
        expect(bad).toEqual([]);
        // Over nothing it would prove nothing.
        expect(spoilers).toBeGreaterThan(500);
    });

    it('CONTROL: the check finds words that are printed, and leaves alone words that are not', () => {
        expect(leaked('||w0||', parseMessage('w0'))).toEqual(['w0']);
        expect(leaked('||w0|| w1', parseMessage('||w0|| w1'))).toEqual([]);
        // What stepping over this address with no care would give: the address takes the spoiler in.
        expect(leaked('w0_https://x/w1_w2||w3||', [{ type: 'url', href: 'https://x/w1_w2||w3||' }])).toEqual(['w3']);
    });
});

describe('an address straight after a colon', () => {
    it.each([
        ['Link:', 'https://example.org/page'],
        ['Download here:', 'https://example.org/file'],
        ['Source:', 'http://example.org/a_b_c'],
        ['(see:', 'https://example.org/page'],
    ])('%s%s', (words, href) => {
        expect(parseMessage(words + href)).toEqual([{ type: 'text', value: words }, { type: 'url', href }]);
    });

    it('in a sentence, in bold, and with a delimiter in it', () => {
        expect(hrefs('the Link:https://example.org/page is here')).toEqual(['https://example.org/page']);
        expect(hrefs('**Link:https://example.org/a_b**')).toEqual(['https://example.org/a_b']);
        expect(hrefs('my_file Link:https://example.org/my_file')).toEqual(['https://example.org/my_file']);
    });

    it(':name: with // after it is not a shortcode, and stays as typed', () => {
        expect(parseMessage(':smile://x')).toEqual([{ type: 'text', value: ':smile://x' }]);
        expect(parseMessage('see :smile://x/y now')).toEqual([{ type: 'text', value: 'see :smile://x/y now' }]);
        // Words, whole: its `_` opens nothing, as a shortcode's never did.
        expect(parseMessage(':a_b://x _c_')).toEqual([
            { type: 'text', value: ':a_b://x ' },
            { type: 'em', children: [{ type: 'text', value: 'c' }] },
        ]);
    });

    it('CONTROL: a shortcode is still one, right up against an address or with a slash after a space', () => {
        expect(parseMessage(':smile:')).toEqual([{ type: 'emoji', name: 'smile' }]);
        expect(parseMessage(':https:')).toEqual([{ type: 'emoji', name: 'https' }]);
        expect(parseMessage(':smile: //x')).toEqual([{ type: 'emoji', name: 'smile' }, { type: 'text', value: ' //x' }]);
        expect(parseMessage(':smile:https://example.org/a')).toEqual([
            { type: 'emoji', name: 'smile' },
            { type: 'url', href: 'https://example.org/a' },
        ]);
    });

    it('@ in it is no mention, and one beside it still is', () => {
        expect(extractMentions('Link:https://example.org/@alice/1')).toEqual({ users: [], everyone: false });
        expect(extractMentions('@bob Link:https://example.org/@alice/1 @carol')).toEqual({ users: ['bob', 'carol'], everyone: false });
    });

    it('a spoiler stays one beside it, or in its word', () => {
        const spoiler = (value: string) => ({ type: 'spoiler', children: [{ type: 'text', value }] });
        expect(parseMessage('Link:https://example.org/a ||hidden||')).toEqual([
            { type: 'text', value: 'Link:' },
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: ' ' },
            spoiler('hidden'),
        ]);
        // The address would take the spoiler in, so this message reads as it did.
        expect(parseMessage('Link:https://example.org/a||hidden||')).toEqual(parsedAsItWas('Link:https://example.org/a||hidden||'));
        expect(parseMessage('Link:https://example.org/a||hidden||').at(-1)).toEqual(spoiler('hidden'));
    });
});

describe('a raw > or " is never part of an address', () => {
    it.each([
        ['<https://example.org>', '<', 'https://example.org', '>'],
        ['<https://example.org/page>', '<', 'https://example.org/page', '>'],
        ['{"url":"https://example.org/x"}', '{"url":"', 'https://example.org/x', '"}'],
        ['<a href="https://example.org/x">link</a>', '<a href="', 'https://example.org/x', '">link</a>'],
        ['"https://example.org/x"', '"', 'https://example.org/x', '"'],
        ['https://example.org/x"y', '', 'https://example.org/x', '"y'],
        ['https://example.org/x>y', '', 'https://example.org/x', '>y'],
    ])('%s', (content, before, href, after) => {
        const expected: Node[] = [{ type: 'url', href }, { type: 'text', value: after }];
        if (before) expected.unshift({ type: 'text', value: before });
        expect(parseMessage(content)).toEqual(expected);
    });

    it('two in one word, and markup around them', () => {
        expect(hrefs('{"a":"https://example.org/a","b":"https://example.org/b"}')).toEqual(['https://example.org/a', 'https://example.org/b']);
        expect(parseMessage('**<https://example.org/a>**')).toEqual([
            { type: 'strong', children: [{ type: 'text', value: '<' }, { type: 'url', href: 'https://example.org/a' }, { type: 'text', value: '>' }] },
        ]);
        // It stops the delimiter's reading of the address too.
        expect(hrefs('my_file <https://example.org/my_file>')).toEqual(['https://example.org/my_file']);
    });

    it('a real mention right after one is a mention, and an @ in one is not', () => {
        expect(extractMentions('<https://example.org/@alice> @bob')).toEqual({ users: ['bob'], everyone: false });
    });

    it('what comes after one is read as anything else is', () => {
        expect(parseMessage('<https://example.org/a>_b c_d')).toEqual([
            { type: 'text', value: '<' },
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: '>' },
            { type: 'em', children: [{ type: 'text', value: 'b c' }] },
            { type: 'text', value: 'd' },
        ]);
        expect(parseMessage('https://example.org/a>`b`')).toEqual([
            { type: 'url', href: 'https://example.org/a' },
            { type: 'text', value: '>' },
            { type: 'code', value: 'b' },
        ]);
    });

    it('but where that would take a spoiler apart, the message reads as it did', () => {
        expect(parseMessage('<https://example.org/a>_b ||c_d||')).toEqual(parsedAsItWas('<https://example.org/a>_b ||c_d||'));
        expect(parseMessage('<https://example.org/a>_b ||c_d||').at(-1)).toEqual({ type: 'spoiler', children: [{ type: 'text', value: 'c_d' }] });
    });
});

describe('a capital scheme, which a phone keyboard makes', () => {
    it.each([
        ['Https://example.org/wiki/Foo_Bar_Baz'],
        ['Https://example.org/page#top'],
        ['Https://mastodon.example.org/@alice/123'],
        ['HTTP://example.org/a_b'],
        ['HTTPS://EXAMPLE.ORG/A_B_C'],
    ])('%s is one address, as typed', (href) => {
        expect(parseMessage(href)).toEqual([{ type: 'url', href }]);
        expect(hrefs(`see ${href} now`)).toEqual([href]);
        expect(isSafeUrl(href)).toBe(true);
    });

    it('@ in it is no mention, and one beside it still is', () => {
        expect(extractMentions('Https://mastodon.example.org/@alice/123')).toEqual({ users: [], everyone: false });
        expect(extractMentions('@bob Https://mastodon.example.org/@alice/123 @carol')).toEqual({ users: ['bob', 'carol'], everyone: false });
    });

    it('as any other address in markup, after a colon, in brackets, and in a delimiter\'s way', () => {
        expect(parseMessage('**Https://example.org/a**')).toEqual([{ type: 'strong', children: [{ type: 'url', href: 'Https://example.org/a' }] }]);
        expect(hrefs('Link:Https://example.org/a')).toEqual(['Https://example.org/a']);
        expect(hrefs('(see Https://example.org/Foo_(bar))')).toEqual(['Https://example.org/Foo_(bar)']);
        expect(hrefs('my_file Https://example.org/my_file')).toEqual(['Https://example.org/my_file']);
        expect(hrefs('<Https://example.org/a>')).toEqual(['Https://example.org/a']);
    });

    it('CONTROL: a word that starts the same is a word', () => {
        for (const words of ['Hello there', 'Https', 'Https:', 'Https://', 'HTTP/1.1', 'Http: the protocol']) {
            expect(parseMessage(words)).toEqual([{ type: 'text', value: words }]);
        }
    });

    it('a spoiler stays one beside it, or in its word', () => {
        const spoiler = (value: string) => ({ type: 'spoiler', children: [{ type: 'text', value }] });
        expect(parseMessage('Https://example.org/a_b ||hidden||')).toEqual([
            { type: 'url', href: 'Https://example.org/a_b' },
            { type: 'text', value: ' ' },
            spoiler('hidden'),
        ]);
        expect(parseMessage('Https://example.org/a||hidden||')).toEqual([{ type: 'text', value: 'Https://example.org/a' }, spoiler('hidden')]);
        // Read as an address, the `_` after it would close inside the spoiler.
        expect(parseMessage('Https://example.org/a_b c_d ||e_f||').find(n => n.type === 'spoiler')).toEqual(spoiler('e_f'));
    });
});

describe('brackets in a link\'s target', () => {
    const link = (label: string, href: string) => ({ type: 'link', label, href });

    it('it keeps the ones it opens', () => {
        expect(parseMessage('[w](https://example.org/wiki/Foo_(bar))')).toEqual([link('w', 'https://example.org/wiki/Foo_(bar)')]);
        expect(parseMessage('[w](https://example.org/wiki/Foo_(bar)_baz) after')).toEqual([
            link('w', 'https://example.org/wiki/Foo_(bar)_baz'),
            { type: 'text', value: ' after' },
        ]);
        expect(parseMessage('[w](https://example.org/a_(b)_(c))')).toEqual([link('w', 'https://example.org/a_(b)_(c)')]);
        expect(parseMessage('[w](https://example.org/a_(b_(c)))')).toEqual([link('w', 'https://example.org/a_(b_(c))')]);
        expect(parseMessage('(see [w](https://example.org/Foo_(bar)))')).toEqual([
            { type: 'text', value: '(see ' },
            link('w', 'https://example.org/Foo_(bar)'),
            { type: 'text', value: ')' },
        ]);
    });

    it('a picture\'s too', () => {
        expect(parseMessage('![p](https://example.org/a_(1).png)')).toEqual([{ type: 'image', alt: 'p', href: 'https://example.org/a_(1).png' }]);
    });

    it('CONTROL: a bracket it opens and never closes is as it was', () => {
        expect(parseMessage('[a](https://x/(b)')).toEqual([link('a', 'https://x/(b')]);
        expect(parseMessage('[a](x(y) z)')).toEqual([link('a', 'x(y'), { type: 'text', value: ' z)' }]);
    });

    it('CONTROL: it stops at the first ) that closes nothing', () => {
        expect(parseMessage('[a](b) (c)')).toEqual([link('a', 'b'), { type: 'text', value: ' (c)' }]);
        expect(parseMessage('[a](b))')).toEqual([link('a', 'b'), { type: 'text', value: ')' }]);
        expect(parseMessage('[a](b)(c)')).toEqual([link('a', 'b'), { type: 'text', value: '(c)' }]);
    });

    it('CONTROL: no target and no closing are no link', () => {
        expect(parseMessage('[a]()')).toEqual([{ type: 'text', value: '[a]()' }]);
        expect(parseMessage('[a](b')).toEqual([{ type: 'text', value: '[a](b' }]);
        expect(parseMessage('[a](b c)')).toEqual([{ type: 'text', value: '[a](b c)' }]);
    });

    it.each([
        ['javascript:alert(1)'],
        ['JavaScript:alert((1))'],
        ['data:text/html,(a)'],
        ['vbscript:msgbox(1)'],
        ['//example.org/(a)'],
    ])('a dangerous target stays neutralised, whole: %s', (target) => {
        expect(parseMessage(`[x](${target})`)).toEqual([{ type: 'text', value: 'x' }]);
        expect(parseMessage(`![x](${target})`)).toEqual([{ type: 'text', value: 'x' }]);
    });

    it('a spoiler after the first ) is still one', () => {
        expect(parseMessage('[a](https://x/(b)||c||)')).toEqual([
            link('a', 'https://x/(b'),
            { type: 'spoiler', children: [{ type: 'text', value: 'c' }] },
            { type: 'text', value: ')' },
        ]);
        expect(parseMessage('[w](https://example.org/Foo_(bar)) ||c||')).toEqual([
            link('w', 'https://example.org/Foo_(bar)'),
            { type: 'text', value: ' ' },
            { type: 'spoiler', children: [{ type: 'text', value: 'c' }] },
        ]);
    });

    it('it stays bounded: a target past the limit is no link, and a message of openers takes no time', () => {
        const target = `https://example.org/${'a'.repeat(2028)}`;
        expect(target).toHaveLength(2048);
        expect(parseMessage(`[a](${target})`)).toEqual([{ type: 'link', label: 'a', href: target }]);
        expect(parseMessage(`[a](${target}b)`).some(n => n.type === 'link')).toBe(false);
        // Past the limit, a first `)` further back is what it stops at, as before it stopped there.
        expect(hrefs(`[a](x(y)${'a'.repeat(3000)})`)).toEqual(['x(y']);
        const started = performance.now();
        parseMessage('[a]('.repeat(5000));
        parseMessage('[a](('.repeat(4000));
        parseMessage(`[a](${'('.repeat(20000)}`);
        expect(performance.now() - started).toBeLessThan(5000);
    });
});

describe('mentions & channels', () => {
    it('parses user, everyone, here mentions and channels', () => {
        const nodes = parseMessage('hey @alice and @everyone in #general');
        expect(nodes.some((n) => n.type === 'mentionUser' && n.name === 'alice')).toBe(true);
        expect(nodes.some((n) => n.type === 'mentionEveryone')).toBe(true);
        expect(nodes.some((n) => n.type === 'channel' && n.name === 'general')).toBe(true);
    });

    it('parses @here distinctly from @herevariant', () => {
        expect(parseMessage('@here')[0].type).toBe('mentionHere');
        // @heretic should be a user mention "heretic", not @here + tic
        const m = parseMessage('@heretic');
        expect(m[0]).toMatchObject({ type: 'mentionUser', name: 'heretic' });
    });

    it('extractMentions collects names and everyone flag', () => {
        const res = extractMentions('@alice **@bob** hi @everyone');
        expect(res.users.sort()).toEqual(['alice', 'bob']);
        expect(res.everyone).toBe(true);
    });

    it('parses shortcode emoji', () => {
        expect(parseMessage(':smile:')[0]).toMatchObject({ type: 'emoji', name: 'smile' });
    });
});

// messageMentionsUser is what decides who gets highlighted and hears the mention sound.
describe('who an address mentions: nobody', () => {
    const alice = { username: 'alice' };

    it.each([
        ['https://example.org/@alice/1'],
        ['Https://example.org/@alice/1'],
        ['HTTP://example.org/@alice/1'],
        ['Link:https://example.org/@alice/1'],
        ['<https://example.org/@alice>'],
        ['{"url":"https://example.org/@alice"}'],
        ['https://example.org/(@alice)'],
        ['[the post](https://example.org/@alice/1)'],
        ['[the post](https://example.org/(@alice))'],
        ['my_file https://example.org/@alice_file'],
    ])('%s', (content) => {
        expect(messageMentionsUser(content, alice)).toBe(false);
        expect(extractMentions(content).users).toEqual([]);
    });

    it.each([
        ['@alice https://example.org/@bob/1'],
        ['https://example.org/@bob/1 @alice'],
        ['Https://example.org/@bob/1 @alice'],
        ['Link:https://example.org/@bob/1 @alice'],
        ['<https://example.org/@bob> @alice'],
        ['(https://example.org/Foo_(bar)) @alice'],
        ['[the post](https://example.org/Foo_(bar)) @alice'],
        ['**@alice** https://example.org/a_b'],
    ])('CONTROL: a real mention beside one still is: %s', (content) => {
        expect(messageMentionsUser(content, alice)).toBe(true);
        expect(extractMentions(content).users).toEqual(['alice']);
    });
});

describe('a delimiter past an address does not close inside a name', () => {
    it.each<[string, string[]]>([
        ['see my_file at https://example.org/a_b cc @alice_c', ['alice_c']],
        ['test_case failed: https://ci.example.org/job_1 @bob_smith please look', ['bob_smith']],
        ['the build_log is at https://ci.example.org/run_7, ping @carol_d and @erin', ['carol_d', 'erin']],
        ['my__file at https://example.org/a__b @alice__c', ['alice__c']],
    ])('%s', (content, users) => {
        expect(extractMentions(content).users).toEqual(users);
        expect(messageMentionsUser(content, { username: users[0] })).toBe(true);
        // and the name's first half is nobody
        expect(messageMentionsUser(content, { username: users[0].split('_')[0] })).toBe(false);
    });

    it('a channel and an emoji are the same', () => {
        expect(parseMessage('my_file https://example.org/a_b #my_channel').at(-1)).toEqual({ type: 'channel', name: 'my_channel' });
        expect(parseMessage('my_file https://example.org/a_b :thumbs_up:').at(-1)).toEqual({ type: 'emoji', name: 'thumbs_up' });
    });

    it('nor does it stop there: it closes after the name', () => {
        expect(parseMessage('_see https://example.org/a_b @alice_c now_')).toEqual([{
            type: 'em',
            children: [
                { type: 'text', value: 'see ' },
                { type: 'url', href: 'https://example.org/a_b' },
                { type: 'text', value: ' ' },
                { type: 'mentionUser', name: 'alice_c' },
                { type: 'text', value: ' now' },
            ],
        }]);
    });

    // A name takes in the `_` that closes, and the `.` after it, so an address earlier in the
    // sentence used to change who it pinged: to `bob_`, or from everyone to nobody.
    it('a `_` at the end of a name closes there, and the name is the one meant', () => {
        const content = '_see https://example.org/a @bob_';
        expect(parseMessage(content)).toEqual([{
            type: 'em',
            children: [
                { type: 'text', value: 'see ' },
                { type: 'url', href: 'https://example.org/a' },
                { type: 'text', value: ' ' },
                { type: 'mentionUser', name: 'bob' },
            ],
        }]);
        expect(extractMentions(content).users).toEqual(['bob']);
        expect(messageMentionsUser(content, { username: 'bob' })).toBe(true);
        expect(messageMentionsUser(content, { username: 'bob_' })).toBe(false);
    });

    it.each(['_see https://example.org/a @everyone_', '_see https://example.org/a @here_', '_see https://example.org/a @everyone_.'])(
        '%s pings everyone',
        (content) => {
            expect(extractMentions(content)).toEqual({ users: [], everyone: true });
            expect(messageMentionsUser(content, { username: 'carol' })).toBe(true);
        },
    );

    it.each([
        '__see https://example.org/a @bob__',
        '_see https://example.org/a @bob_.',
        '_see https://example.org/a @bob_, thanks',
        '_see https://example.org/a @bob__',
        '__see https://example.org/a @bob___',
        '__see https://example.org/a @bob_',
        '_cc @alice https://example.org/a @bob_',
        '_see https://example.org/a #general_',
        '_see https://example.org/a #general_.',
        '_see https://example.org/a @_',
        '_see https://example.org/a @bob_ and @carol_',
        'my_file at https://example.org/a cc @alice_',
        '*see https://example.org/a @bob_*',
        '**see https://example.org/a @bob_**',
    ])('%s reads as it does with no address in it', (content) => {
        expect(parseMessage(content)).toEqual(parsedAsItWas(content));
    });

    it.each<[string, string]>([
        ['_see https://example.org/a @alice_c_', 'alice_c'],
        ['_see https://example.org/a_b @alice_c_.', 'alice_c'],
        ['__see https://example.org/a @alice__c__', 'alice__c'],
        ['my_file at https://example.org/a_b cc @alice_c.', 'alice_c.'],
    ])('CONTROL: a `_` with more of the name after it is the name\'s: %s', (content, name) => {
        expect(extractMentions(content).users).toEqual([name]);
    });

    it('an address straight after a colon is still an address there, not a shortcode to step over', () => {
        expect(hrefs('my_file https://example.org/a_b :https://example.org/c_d')).toEqual(['https://example.org/a_b', 'https://example.org/c_d']);
    });

    it(':name:// with no address in it is words, as the parser reads it', () => {
        expect(parseMessage('my_file https://example.org/a_b :c_d://x e_f')).toEqual([
            { type: 'text', value: 'my' },
            { type: 'em', children: [{ type: 'text', value: 'file ' }, { type: 'url', href: 'https://example.org/a_b' }, { type: 'text', value: ' :c_d://x e' }] },
            { type: 'text', value: 'f' },
        ]);
    });

    it('CONTROL: with no address before it, a name is what it always was', () => {
        for (const content of ['my_file cc @alice_c', 'my_file #my_channel', 'my_file :thumbs_up:', 'my_file @alice_c https://example.org/a_b']) {
            expect(parseMessage(content)).toEqual(parsedAsItWas(content));
        }
    });
});

describe('text with no address in it', () => {
    const PARTS = ['||', '**', '*', '__', '_', '~~', '`', ' ', '\n', '> ', 'w', 'w_w', 'w*w', 'w~~w', '@w', '@w_w', '#w_w', ':w:', ':w_w:', ':w', '[w](w)', '![w](w)',
        '[', ']', '(', ')', '!', '.', ',', 'h', 'H', 'http', 'Http', '<', '>', '"'];

    it('reads as it always did', () => {
        let seed = 20261103;
        const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % n; };
        const bad: string[] = [];
        for (let k = 0; k < 30000; k++) {
            let content = '';
            for (let j = 1 + next(14); j > 0; j--) content += PARTS[next(PARTS.length)];
            if (JSON.stringify(parseMessage(content)) !== JSON.stringify(parsedAsItWas(content))) bad.push(JSON.stringify(content));
        }
        expect(bad).toEqual([]);
    });

    it('but for two things asked for: the brackets a link\'s target opens, and :name:// being no shortcode', () => {
        expect(parseMessage('[a](b(c))')).toEqual([{ type: 'link', label: 'a', href: 'b(c)' }]);
        expect(parsedAsItWas('[a](b(c))')).toEqual([{ type: 'link', label: 'a', href: 'b(c' }, { type: 'text', value: ')' }]);
        expect(parseMessage(':a://x')).toEqual([{ type: 'text', value: ':a://x' }]);
        expect(parsedAsItWas(':a://x')).toEqual([{ type: 'emoji', name: 'a' }, { type: 'text', value: '//x' }]);
    });
});

describe('what a message costs to read', () => {
    /** The fastest of a few runs: anything else on the machine only ever adds to it. */
    const fastest = (content: string) => {
        let best = Infinity;
        for (let k = 0; k < 5; k++) {
            const started = performance.now();
            parseMessage(content);
            best = Math.min(best, performance.now() - started);
        }
        return best;
    };

    // A message is at most 8000 long, and is read on the UI thread, on receipt and on
    // every render of the chat. The first three took 1100, 500 and 60 ms with guards for
    // spoilers that walked the text at every address and sent the next opener back into
    // it. The next three still take 190, 35 and 65 ms if each failed walk is free.
    it.each([
        ['nested openers, an address and a `||` over and over, and a spoiler', `**__~~*_${'>http://a_b_c||'.repeat(532)}_ ||s||`],
        ['one `_`, and an address and a `||` over and over', `_${'http://a_b_c ||'.repeat(532)}* ||s||`],
        ['one word of addresses', `*${'http://a**b>#'.repeat(615)}_`],
        ['words of a shortcode with an address in them', `**${'~~)"~~@:Hbhttp://****b__H)('.repeat(295)}_ ||s||`],
        ['a delimiter only the end of a link opens', `${'[x](http://a)_b '.repeat(490)}`],
        ['every delimiter, and an address that takes them in', `\`${'_***http://:**b~~~~____'.repeat(347)} ||s||`],
        ['a list of addresses with a spoiler', `my_list:\n${'https://example.org/some_long_path_name\n'.repeat(199)}||s|| *`],
    ])('%s', (_, content) => {
        expect(content.length).toBeGreaterThan(7500);
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content)).toBeLessThan(30);
    });

    it('a walk that closes in an address pays for it: 3 ms, or 40 if only a walk that finds nothing does', () => {
        const content = `||s|| ${'_http://_'.repeat(488)}${'('.repeat(1800)}${')'.repeat(1800)}`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content)).toBeLessThan(20);
    });

    it('a run of one delimiter in an address: 1 ms, or 25 with no bound on what stands between a closer and an opener', () => {
        const content = `_https://example.org/${'_'.repeat(7900)}a ||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content)).toBeLessThan(10);
    });

    it('very short quotes and one small spoiler: 2 ms, or 116 if each quote reads all that is left of the text', () => {
        const content = `${'>\n\n'.repeat(2665)}||s||`;
        expect(content.length).toBeLessThanOrEqual(8000);
        expect(fastest(content)).toBeLessThan(30);
    });

    it('CONTROL: what is cheap is still read in full: a list of addresses, all whole, and every name', () => {
        const line = 'https://example.org/some_long_path @alice_c\n';
        const content = `my_list:\n${line.repeat(179)}`;
        expect(content.length).toBeGreaterThan(7500);
        expect(hrefs(content)).toEqual(Array(179).fill('https://example.org/some_long_path'));
        expect(extractMentions(content).users).toEqual(['alice_c']);
    });
});

describe('robustness', () => {
    it('returns empty for empty input', () => {
        expect(parseMessage('')).toEqual([]);
    });

    it('treats unclosed delimiters as literal text', () => {
        expect(text(parseMessage('**unclosed'))).toBe('**unclosed');
        expect(text(parseMessage('a * b * c')).replace(/\s+/g, ' ')).toBe('a b c'.replace('b', 'b'));
    });

    it('handles plain text unchanged', () => {
        expect(text(parseMessage('just a normal sentence.'))).toBe('just a normal sentence.');
    });

    it('does not crash on adversarial nesting', () => {
        const evil = '*'.repeat(500) + 'x' + '*'.repeat(500);
        expect(() => parseMessage(evil)).not.toThrow();
    });
});

// Link/image scheme allowlist — the javascript: (and data:/vbscript:) link XSS
// that would run attacker JS in the app origin, reading the JWT + E2EE seed from
// localStorage. A dangerous scheme must NEVER become a clickable href. (audit H7)
describe('link scheme safety (H7)', () => {
    it('does NOT produce an executable href for [x](javascript:alert(1))', () => {
        const nodes = parseMessage('[x](javascript:alert(1))');
        // No link node at all — the label survives as plain text, no href emitted.
        expect(nodes.some((n) => n.type === 'link')).toBe(false);
        const anyHref = JSON.stringify(nodes).toLowerCase();
        expect(anyHref).not.toContain('javascript:');
        expect(text(nodes)).toContain('x'); // label survives as plain text
    });

    it('neutralizes a javascript: image to plain alt text', () => {
        const nodes = parseMessage('![pwn](javascript:alert(1))');
        expect(nodes.some((n) => n.type === 'image')).toBe(false);
        expect(JSON.stringify(nodes).toLowerCase()).not.toContain('javascript:');
    });

    it('blocks data: and vbscript: too, and ignores leading whitespace/control tricks', () => {
        expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
        expect(isSafeUrl('JavaScript:alert(1)')).toBe(false); // case-insensitive
        expect(isSafeUrl('\t\n javascript:alert(1)')).toBe(false); // leading controls stripped
    });

    it('still allows http/https/mailto and the sovereign-enc attachment scheme', () => {
        const nodes = parseMessage('[ok](https://example.com/page)');
        expect(nodes[0]).toMatchObject({ type: 'link', href: 'https://example.com/page' });
        expect(isSafeUrl('http://example.com')).toBe(true);
        expect(isSafeUrl('https://example.com')).toBe(true);
        expect(isSafeUrl('mailto:a@b.com')).toBe(true);
        expect(isSafeUrl('sovereign-enc:abc?k=key&m=image%2Fpng')).toBe(true);
        expect(isSafeUrl('/relative/path')).toBe(true); // scheme-less → same-origin
    });

    /**
     * `//evil.com/x` has NO scheme, so the scheme allowlist never sees it — but
     * the browser resolves it against the page's own scheme and loads it
     * cross-origin. The old comment on that branch claimed scheme-less meant
     * same-origin; for a protocol-relative authority that is simply false, and
     * it made `[x](//evil.com)` a live target=_blank anchor and
     * `![x](//evil.com/a.png)` a remote image request.
     */
    it('refuses a protocol-relative authority, which is NOT same-origin', () => {
        expect(isSafeUrl('//evil.com')).toBe(false);
        expect(isSafeUrl('//evil.com/a.png')).toBe(false);
        // The control-character skip must not smuggle one past either.
        expect(isSafeUrl('\t//evil.com')).toBe(false);
        expect(isSafeUrl('\n\r  //evil.com')).toBe(false);
        // A scheme-relative URL is still refused when it carries credentials.
        expect(isSafeUrl('//user:pw@evil.com/x')).toBe(false);
    });

    it('still allows genuinely relative hrefs (the regression this must not cause)', () => {
        expect(isSafeUrl('/x')).toBe(true);
        expect(isSafeUrl('x.png')).toBe(true);
        expect(isSafeUrl('./a/b')).toBe(true);
        expect(isSafeUrl('../up')).toBe(true);
        expect(isSafeUrl('#anchor')).toBe(true);
        expect(isSafeUrl('?q=1')).toBe(true);
        expect(isSafeUrl('')).toBe(true);
    });

    it('a protocol-relative link or image degrades to plain text', () => {
        const link = parseMessage('[x](//evil.com)');
        expect(link.some((n) => n.type === 'link')).toBe(false);
        expect(link).toEqual([{ type: 'text', value: 'x' }]);
        const img = parseMessage('![x](//evil.com/a.png)');
        expect(img.some((n) => n.type === 'image')).toBe(false);
        expect(JSON.stringify(img)).not.toContain('evil.com');
    });
});
