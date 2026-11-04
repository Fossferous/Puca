/**
 * Message content parser.
 *
 * Produces a tree of typed nodes from a raw message string, supporting the
 * familiar chat-app markdown subset plus mentions, channel links and emoji. Unlike
 * the previous placeholder-substitution approach, this is a real tokenizer:
 * user text like `__BOLD_0__` can't spoof formatting, styles nest correctly,
 * and it degrades to plain text when nothing matches.
 *
 * The parser is pure and knows nothing about members/channels — the renderer
 * resolves `mentionUser`/`channel` names against the current context.
 */

export type Node =
    | { type: 'text'; value: string }
    | { type: 'strong'; children: Node[] }
    | { type: 'em'; children: Node[] }
    | { type: 'underline'; children: Node[] }
    | { type: 'strike'; children: Node[] }
    | { type: 'spoiler'; children: Node[] }
    | { type: 'code'; value: string }
    | { type: 'codeblock'; value: string; lang: string | null }
    | { type: 'blockquote'; children: Node[] }
    | { type: 'link'; href: string; label: string }
    | { type: 'url'; href: string }
    | { type: 'image'; alt: string; href: string }
    | { type: 'mentionUser'; name: string }
    | { type: 'mentionEveryone' }
    | { type: 'mentionHere' }
    | { type: 'channel'; name: string }
    | { type: 'emoji'; name: string };

const MAX_DEPTH = 12;

/**
 * One reading of a message: `asItWas` (see `parseMessage`) or not, and how much it
 * may still spend on walks for a closer: the whole walk when it finds none, and every
 * address, link and spoiler it reads when it does. Such a walk can be repeated from
 * the next opener, since what it stepped over is not always what gets read: a run of
 * code that pairs up differently, or a `||` in an address, can leave `_` that only the
 * reader opens, over and over. A real message spends a few lengths of itself. Past
 * that a delimiter closes at the first one, as it used to, which always moves on, so
 * a message of 8000 cannot cost more than this however it was made. `everyBar` is the
 * reading of a message whose `||` the others disagree on, and `at855` 0.9.855's own (see
 * `parseMessage`): it steps over addresses for `_` and `__`, and over nothing else.
 */
interface Reading { asItWas: boolean; at855: boolean; everyBar: boolean; walkLeft: number }
const WALK_PER_CHAR = 32;
// A link's target, 2048 long at most, and the `)` after it.
const LINK_TARGET_MOST = 2049;
// Up to the `(` of a link's target and a picture's. Label and target are bounded so a
// non-matching '[' bails after a fixed window instead of scanning to end-of-string:
// otherwise a message of many '[' is O(n^2) and freezes the renderer (client-side DoS).
const LINK_HEAD_RE = /^\[([^\]\n]{1,512})\]\(/;
const IMAGE_HEAD_RE = /^!\[([^\]\n]{0,512})\]\(/;
// How far ahead of one its `](` can be, and the most a try at one can read.
const LINK_LABEL_REACH = 514;
const LINK_READ_MOST = LINK_LABEL_REACH + LINK_TARGET_MOST;

// Inline delimiters, longest-first so `**` wins over `*` and `__` over `_`.
const INLINE_DELIMS: { open: string; type: 'strong' | 'em' | 'underline' | 'strike' | 'spoiler' }[] = [
    { open: '**', type: 'strong' },
    { open: '__', type: 'underline' },
    { open: '~~', type: 'strike' },
    { open: '||', type: 'spoiler' },
    { open: '*', type: 'em' },
    { open: '_', type: 'em' },
];

/** A bare URL at the START of the input: http(s) only, and the tail class
 *  keeps trailing punctuation out of the href. A raw `>` or `"` is in neither:
 *  they are only ever what is put around an address (`<https://…>`,
 *  `{"url":"https://…"}`). */
const URL_RE = /^https?:\/\/[^\s<>"]+[^\s<>".,:;')\]]/i;
/** The address as it was read before (see `parseMessage`). */
const URL_RE_AS_IT_WAS = /^https?:\/\/[^\s<]+[^\s<.,:;"')\]]/i;

/** Wikipedia-shaped URLs end in `)`. URL_RE's tail class already dropped it,
 *  so put it back only when the URL has an unmatched `(` that wants it, along
 *  with what the class dropped before it: `Foo_(U.S.)`. `rest` is what follows
 *  the URL. */
function withBalancedTail(url: string, rest: string): string {
    if (!url.includes('(')) return url;
    let unmatched = 0;
    for (const ch of url) {
        if (ch === '(') unmatched++;
        else if (ch === ')' && unmatched > 0) unmatched--;
    }
    let taken = 0;
    while (unmatched > 0) {
        const tail = /^[.,:;'\]]*\)/.exec(rest.slice(taken));
        if (!tail) break;
        taken += tail[0].length;
        unmatched--;
    }
    return url + rest.slice(0, taken);
}

/**
 * Whether a link or a picture can start at `at`, for positions in order: it has a `](`
 * in reach. A text of many `[` then costs one look ahead, not 512 characters each.
 */
function linkInReach(input: string): (at: number) => boolean {
    let middle = -1;
    return (at) => {
        if (middle !== Infinity && middle < at) {
            const next = input.indexOf('](', at);
            middle = next === -1 ? Infinity : next;
        }
        return middle - at <= LINK_LABEL_REACH;
    };
}

/** The address at the START of `rest`, or null. Exported so notes' own
 *  linkifier (utils/linkSegments.ts) reads an address THIS way rather than
 *  with a second copy that would drift away from it. */
export function urlAt(rest: string): string | null {
    const m = URL_RE.exec(rest);
    return m && withBalancedTail(m[0], rest.slice(m[0].length));
}

// Allow letters, numbers, underscore, dot, hyphen in mention/channel names.
const NAME_RE = /^[a-z0-9_.-]+/i;
const SHORTCODE_RE = /^:([a-z0-9_+-]+):/i;

// Schemes we will emit as a real href/src. http/https/mailto are the safe
// external set; `sovereign-enc` is our own attachment scheme (the renderer
// routes it through a decrypt-and-render path, never a raw navigable href).
// Everything else — javascript:, data:, vbscript:, file:, … — can execute
// script or exfiltrate in the app origin (stealing the JWT + E2EE seed from
// localStorage in the Tauri webview), so a link/image carrying such a scheme is
// neutralized to plain text rather than becoming clickable. (audit H7)
// `sovereign-clip` (docs/CLIPS.md) is allow-listed ONLY because MessageContent
// dispatches it to ClipAttachment before any <a href> is emitted — the href
// carries the clip key, so it must never become a navigable link.
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'sovereign-enc', 'sovereign-clip']);

/**
 * True if `href` is safe to render as a link href or image src. A scheme-less /
 * relative href resolves within our own origin and can't run script, so it's
 * allowed. Any explicit scheme must be in the allowlist. Leading control/space
 * characters (which a browser ignores when resolving the scheme, e.g.
 * "\tjavascript:") are stripped before the scheme is read, so they can't smuggle
 * a dangerous scheme past the check.
 */
export function isSafeUrl(href: string): boolean {
    // Skip leading chars a browser ignores when resolving the scheme
    // (spaces, tabs, newlines and other C0 controls) with a charCode scan
    // rather than a control-char regex literal. Interior controls can't form
    // a valid scheme, so the scheme regex below won't match them (treated as
    // a safe relative URL), mirroring how a browser fails to parse it.
    let start = 0;
    while (start < href.length && href.charCodeAt(start) <= 0x20) start++;
    const rest = href.slice(start);
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(rest);
    if (!m) {
        // Scheme-less is NOT automatically same-origin: `//evil.com/x` is a
        // protocol-relative URL, which the browser resolves against the page's
        // scheme and loads cross-origin. Only a true relative path is safe.
        if (rest.startsWith('//')) return false;
        return true;
    }
    return SAFE_URL_SCHEMES.has(m[1].toLowerCase());
}

function isNameChar(ch: string | undefined): boolean {
    return ch !== undefined && /[a-z0-9_.-]/i.test(ch);
}

// A word, or one mark that is not a delimiter: `||:)||` is a spoiler too.
const WORD_RE = /[^\s!-/:-@[-`{-~]+|[^\s*_~`|]/g;

function wordsOf(n: Exclude<Node, { children: Node[] }>): string {
    switch (n.type) {
        case 'text':
        case 'code':
        case 'codeblock':
            return n.value;
        case 'url':
            return n.href;
        case 'link':
            return `${n.label} ${n.href}`;
        case 'image':
            return `${n.alt} ${n.href}`;
        case 'mentionUser':
        case 'channel':
        case 'emoji':
            return n.name;
        case 'mentionEveryone':
            return 'everyone';
        case 'mentionHere':
            return 'here';
    }
}

interface Words { hidden: Map<string, number>; shown: Map<string, number> }

/** Every word in `nodes`, under a spoiler or not, each with how many times. */
function wordsIn(nodes: Node[], under = false, words: Words = { hidden: new Map(), shown: new Map() }): Words {
    const into = under ? words.hidden : words.shown;
    for (const n of nodes) {
        if ('children' in n) {
            wordsIn(n.children, under || n.type === 'spoiler', words);
        } else {
            for (const word of wordsOf(n).match(WORD_RE) ?? []) into.set(word, (into.get(word) ?? 0) + 1);
        }
    }
    return words;
}

/**
 * Whether `read` gives away a word `other` hid: it does not hide it as many times. A
 * word can be printed glued to another, so hiding it is the only proof it is not. A mark
 * cannot, and can be nowhere at all: the `[` of what is words in one and a link in the
 * other. Hiding fewer of one only counts if there is more of it to see.
 */
function printsWhatItHid(read: Words, other: Words): boolean {
    for (const [word, times] of other.hidden) {
        if ((read.hidden.get(word) ?? 0) >= times) continue;
        if (!/^[!-/:-@[-`{-~]$/.test(word) || (read.shown.get(word) ?? 0) > (other.shown.get(word) ?? 0)) return true;
    }
    return false;
}

/** Whether any `||` is left to see, not read as a spoiler's and not in one. */
function showsBars(nodes: Node[]): boolean {
    return nodes.some(n => (n.type === 'spoiler' ? false : 'children' in n ? showsBars(n.children) : wordsOf(n).includes('||')));
}

/**
 * Parse a full message into a node tree.
 *
 * A spoiler must never stop being one, and reading a message better can cost one.
 * The `||` of a text pair up in order, so one that a delimiter used to take and now
 * does not moves every pairing after it: `**a||b** ||c||` now pairs up around `b`,
 * and prints the c it used to hide. Which texts do that cannot be listed: rules for
 * the ones found kept missing others, and one message could cost them a second to
 * read. So what 0.9.855 read stays (`readAt855`), and this reading may not print a
 * word that one hid. messageParser.test.ts holds this as a property against that
 * parser, frozen, and against the one before it.
 *
 * Where it would, the one that hides everything the other does is used, for the whole
 * message, and an address in it is read as it was too; the spoiler is what matters.
 * Where each hides what the other prints, there is no telling which `||` pairs with
 * which: `my_file ||a_b|| and ||c_d||` used to hide ` and ` and print the rest. So
 * every stretch between two `||` is a spoiler of its own (`everyBar`), and nothing
 * either of them hid is printed. If a `||` is left to see, a link or code took it, and
 * then what it hid may be there too.
 */
export function parseMessage(content: string): Node[] {
    if (!content) return [];
    const read = (how: Partial<Reading>) => parseBlocks(content, { asItWas: false, at855: false, everyBar: false, ...how, walkLeft: WALK_PER_CHAR * content.length });
    const nodes = read({});
    const bars = content.indexOf('||');
    if (bars === -1 || content.indexOf('||', bars + 2) === -1) return nodes;
    const asItWas = readAt855(content, read);
    const words = wordsIn(nodes);
    const wordsThen = wordsIn(asItWas);
    if (!printsWhatItHid(words, wordsThen)) return nodes;
    if (!printsWhatItHid(wordsThen, words)) return asItWas;
    const everyBar = read({ everyBar: true });
    return showsBars(everyBar) ? asItWas : everyBar;
}

/**
 * What 0.9.855 read: its own reading, or the one before it where its own hid fewer of a
 * word, which was its rule. With no address and no link in the text the two are one.
 */
function readAt855(content: string, read: (how: Partial<Reading>) => Node[]): Node[] {
    const before = read({ asItWas: true });
    if (!content.includes('://') && !content.includes('](')) return before;
    const own = read({ at855: true });
    const hidden = wordsIn(own).hidden;
    for (const [word, times] of wordsIn(before).hidden) {
        if ((hidden.get(word) ?? 0) < times) return before;
    }
    return own;
}

/** Block level: fenced code blocks and blockquotes, then inline for the rest. */
function parseBlocks(input: string, reading: Reading, depth = 0): Node[] {
    const nodes: Node[] = [];
    let rest = input;

    while (rest.length > 0) {
        // Fenced code block: ```lang\n...\n``` (lang optional).
        const fence = matchCodeBlock(rest);
        if (fence) {
            nodes.push(fence.node);
            rest = rest.slice(fence.length);
            continue;
        }

        // Blockquote: a run of lines each starting with "> " (or ">").
        const quote = matchBlockquote(rest, reading, depth + 1);
        if (quote) {
            nodes.push(quote.node);
            rest = rest.slice(quote.length);
            continue;
        }

        // Otherwise consume up to the next block construct and inline-parse it.
        const chunk = rest.slice(0, chunkEnd(rest, reading));
        nodes.push(...parseInline(chunk, depth, reading));
        rest = rest.slice(chunk.length);
    }

    return nodes;
}

/** Where the next fence or line starting with `>` at or after `from` is, or the end of `s`. */
function nextBlock(s: string, from: number): number {
    const stop = [s.indexOf('```', from), findQuoteLine(s, from)].filter((i) => i > 0);
    return stop.length ? Math.min(...stop) : s.length;
}

/**
 * How far of `rest`, which starts with no block, reads as one run of inline text: up to
 * the next block, and past it if a spoiler is open there. Blocks are split off before
 * anything reads a `||`, so `||```py\nthe answer\n```||` was a `||`, code for all to see
 * and a `||`. A spoiler pairs as it does for the reader, code stepped over, and it is
 * only a question for a run with a `||` in it, which keeps a text of very short quotes
 * from reading all that is left of it at each one. A `||` with a space either side of it
 * opens nothing over a block: `if a || b:`, some code and `or c || d:` is someone talking
 * about code, and the code would be gone until pressed. Where the readings disagree, what
 * matters is what either hid, so there it does.
 */
function chunkEnd(rest: string, reading: Reading): number {
    let cut = nextBlock(rest, 0);
    if (reading.asItWas || reading.at855 || cut === rest.length || !rest.slice(0, cut).includes('||')) return cut;
    let at = 0;
    while (at < cut && reading.walkLeft > 0) {
        const open = findClosing(rest, at, '||', reading);
        if (open === -1 || open >= cut) break;
        const close = spoilerEnd(rest, open, reading);
        if (close === -1) break;
        if (close === open + 2) {
            at = open + 1;
            continue;
        }
        at = close + 2;
        if (at > cut) {
            if (!reading.everyBar && rest[open - 1] === ' ' && rest[open + 2] === ' ') return cut;
            cut = nextBlock(rest, at);
        }
    }
    return cut;
}

function matchCodeBlock(s: string): { node: Node; length: number } | null {
    if (!s.startsWith('```')) return null;
    const end = s.indexOf('```', 3);
    if (end === -1) return null;
    const inner = s.slice(3, end);
    const nl = inner.indexOf('\n');
    let lang: string | null = null;
    let code = inner;
    if (nl !== -1) {
        const firstLine = inner.slice(0, nl).trim();
        // A language tag is a single non-empty token with no spaces; either way
        // the first line is not part of the code body.
        if (firstLine.length > 0 && !/\s/.test(firstLine)) {
            lang = firstLine;
        }
        code = inner.slice(nl + 1);
    }
    code = code.replace(/\n$/, '');
    return { node: { type: 'codeblock', value: code, lang }, length: end + 3 };
}

function matchBlockquote(s: string, reading: Reading, depth: number): { node: Node; length: number } | null {
    if (!(s.startsWith('> ') || s.startsWith('>\n') || s === '>')) return null;
    // Up to the first line that is not quoted, and no further: a text of very short
    // quotes comes back here for each one, with nearly all of itself still to read.
    const quoted: string[] = [];
    let consumed = 0;
    while (consumed < s.length) {
        const nl = s.indexOf('\n', consumed);
        const line = s.slice(consumed, nl === -1 ? s.length : nl);
        if (line !== '>' && !line.startsWith('> ')) break;
        quoted.push(line === '>' ? '' : line.slice(2));
        consumed += line.length + 1; // + newline
    }
    if (quoted.length === 0) return null;
    const length = Math.min(consumed, s.length);
    return { node: { type: 'blockquote', children: parseInline(quoted.join('\n'), depth, reading) }, length };
}

/** Find the index of the first line (after start, and at or after `from`) beginning with `>`. */
function findQuoteLine(s: string, from: number): number {
    const nl = s.indexOf('\n>', from);
    return nl === -1 ? -1 : nl + 1;
}

/**
 * What a link or a picture holds, at the start of `rest`, with `head` matching up to
 * the `(` of its target. The target takes in the brackets it opens, so
 * `[w](https://x/Foo_(bar))` keeps its own, and it stops at the first `)` that
 * closes none: `[a](b) (c)` does not take in `(c)`. With no such `)`, as in
 * `[a](https://x/(b)`, it stops at the first `)` it passed, as it always used to
 * (`asItWas`). Bounded, like `head`.
 */
function matchLinkParts(head: RegExp, rest: string, asItWas: boolean): { label: string; href: string; length: number } | null {
    const m = head.exec(rest);
    if (!m) return null;
    const start = m[0].length;
    const limit = Math.min(rest.length, start + LINK_TARGET_MOST);
    let depth = 0;
    let first = -1;
    let end = -1;
    // No further than it has to: a walk for a closer reads every link it goes past.
    for (let i = start; i < limit && end === -1; i++) {
        const c = rest.charCodeAt(i);
        if (c === 40) depth++;
        else if (c === 41) {
            if (depth === 0) end = i - start;
            else if (first === -1) first = i - start;
            depth--;
        } else if (c <= 32 ? c === 32 || (c >= 9 && c <= 13) : c >= 160 && /\s/.test(rest[i])) break;
    }
    if (first !== -1 && (end === -1 || asItWas)) end = first;
    return end > 0 ? { label: m[1], href: rest.slice(start, start + end), length: start + end + 1 } : null;
}

/** Inline parser: emits text runs interleaved with markup nodes. */
function parseInline(input: string, depth: number, reading: Reading): Node[] {
    const { asItWas } = reading;
    const linkIsInReach = linkInReach(input);
    const nodes: Node[] = [];
    let buf = '';
    let i = 0;

    const flush = () => {
        if (buf) {
            nodes.push({ type: 'text', value: buf });
            buf = '';
        }
    };

    while (i < input.length) {
        const rest = input.slice(i);
        const ch = input[i];

        // Inline code: `code` (no formatting inside).
        if (ch === '`') {
            const close = input.indexOf('`', i + 1);
            if (close !== -1 && close > i + 1) {
                flush();
                nodes.push({ type: 'code', value: input.slice(i + 1, close) });
                i = close + 1;
                continue;
            }
        }

        // Image: ![alt](url)
        if (ch === '!' && input[i + 1] === '[' && linkIsInReach(i)) {
            const m = matchLinkParts(IMAGE_HEAD_RE, rest, asItWas);
            if (m) {
                flush();
                // Neutralize a dangerous scheme (javascript:, data:, …): keep the
                // alt text, drop the href, so it never renders as an <img src>. (H7)
                if (isSafeUrl(m.href)) nodes.push({ type: 'image', alt: m.label, href: m.href });
                else if (m.label) nodes.push({ type: 'text', value: m.label });
                i += m.length;
                continue;
            }
        }

        // Link: [label](url)
        if (ch === '[' && linkIsInReach(i)) {
            const m = matchLinkParts(LINK_HEAD_RE, rest, asItWas);
            if (m) {
                flush();
                // Neutralize a dangerous scheme: drop the href and keep the label
                // as plain text so `[x](javascript:…)` is never a clickable link. (H7)
                if (isSafeUrl(m.href)) nodes.push({ type: 'link', label: m.label, href: m.href });
                else nodes.push({ type: 'text', value: m.label });
                i += m.length;
                continue;
            }
        }

        // Bare URL, in either case: a phone's keyboard makes `Https://`.
        if (ch === 'h' || (ch === 'H' && !asItWas)) {
            const href = asItWas ? URL_RE_AS_IT_WAS.exec(rest)?.[0] : reading.at855 ? urlAt(rest) : addressAt(rest, reading);
            if (href) {
                flush();
                nodes.push({ type: 'url', href });
                i += href.length;
                continue;
            }
        }

        // Mentions and channels.
        if (ch === '@') {
            if (rest.startsWith('@everyone') && !isNameChar(rest[9])) {
                flush();
                nodes.push({ type: 'mentionEveryone' });
                i += '@everyone'.length;
                continue;
            }
            if (rest.startsWith('@here') && !isNameChar(rest[5])) {
                flush();
                nodes.push({ type: 'mentionHere' });
                i += '@here'.length;
                continue;
            }
            const nm = NAME_RE.exec(rest.slice(1));
            if (nm) {
                flush();
                nodes.push({ type: 'mentionUser', name: nm[0] });
                i += 1 + nm[0].length;
                continue;
            }
        }
        if (ch === '#') {
            const nm = NAME_RE.exec(rest.slice(1));
            if (nm) {
                flush();
                nodes.push({ type: 'channel', name: nm[0] });
                i += 1 + nm[0].length;
                continue;
            }
        }

        // Shortcode emoji: :smile: Not with // after it: `Link:https://…` is an
        // address straight after a colon, and `:smile://x` is words.
        if (ch === ':') {
            const m = SHORTCODE_RE.exec(rest);
            if (m && !asItWas && rest.startsWith('//', m[0].length)) {
                const href = reading.at855 ? urlAt(rest.slice(1)) : addressAt(rest.slice(1), reading);
                if (href) {
                    buf += ':';
                    flush();
                    nodes.push({ type: 'url', href });
                    i += 1 + href.length;
                } else {
                    buf += m[0];
                    i += m[0].length;
                }
                continue;
            }
            if (m) {
                flush();
                nodes.push({ type: 'emoji', name: m[1] });
                i += m[0].length;
                continue;
            }
        }

        // Emphasis delimiters (recursive), only if not too deep.
        if (depth < MAX_DEPTH) {
            const delim = INLINE_DELIMS.find((d) => rest.startsWith(d.open));
            if (delim) {
                const closeIdx = findClosing(input, i + delim.open.length, delim.open, reading);
                if (closeIdx !== -1) {
                    const innerText = input.slice(i + delim.open.length, closeIdx);
                    if (innerText.length > 0) {
                        flush();
                        const children = delim.type === 'spoiler' && !asItWas && !reading.at855 && holdsBlock(innerText)
                            ? parseBlocks(innerText, reading, depth + 1)
                            : parseInline(innerText, depth + 1, reading);
                        nodes.push({ type: delim.type, children } as Node);
                        i = closeIdx + delim.open.length;
                        // This `||` opens the next stretch too, if any `||` is left to close it.
                        if (reading.everyBar && delim.type === 'spoiler' && findClosing(input, i, '||', reading) !== -1) i = closeIdx;
                        continue;
                    }
                }
            }
        }

        buf += ch;
        i += 1;
    }

    flush();
    return nodes;
}

/**
 * Where what opens at the `||` at `at` ends for anything reading past it, or -1 if it does
 * not open. Its closer, or the last `||` of all where every stretch between two is a spoiler.
 */
function spoilerEnd(input: string, at: number, reading: Reading): number {
    let close = findClosing(input, at + 2, '||', reading);
    if (reading.everyBar) {
        for (let next = close; next !== -1; next = findClosing(input, next + 2, '||', reading)) close = next;
    }
    return close;
}

/** Whether a spoiler holds a fence or a quote, which it reads as one: `chunkEnd` kept it there. */
function holdsBlock(inner: string): boolean {
    const fence = inner.indexOf('```');
    return (fence !== -1 && inner.includes('```', fence + 3)) || /\n>( |\n|$)/.test(inner);
}

/**
 * The address at the start of `rest`, as a message reads it: up to a `||` that opens a
 * spoiler, however well the characters after it would do in an address. `https://x/a||b`
 * is one address, since nothing closes that `||`, and `see https://x/a||b||` is an address
 * and a spoiler, or the words in it go out on the link and in the card under it. Notes has
 * no spoilers and reads `urlAt`.
 */
function addressAt(rest: string, reading: Reading): string | null {
    const href = urlAt(rest);
    // Past the budget the whole word is one address, and nothing goes back over it.
    if (!href || reading.walkLeft <= 0) return href;
    for (let bars = href.indexOf('||'); bars !== -1; bars = href.indexOf('||', bars + 1)) {
        if (findClosing(rest, bars + 2, '||', reading) > bars + 2) {
            // Read to the end of the word, and only this much of that is walked past.
            reading.walkLeft -= href.length - bars;
            return urlAt(rest.slice(0, bars));
        }
    }
    return href;
}

/** For `_` or `__`, the closer of one address and the opener of the next, with no
 *  space between them: `_https://x/a_,_https://x/b_`. Bounded, so a run of them in
 *  one address costs no more than its length. */
const NEXT_IN_A_LIST = new Map(['_', '__'].map((d): [string, RegExp] => [d, new RegExp(`${d}[^\\p{L}\\p{N}]{0,3}?${d}https?://`, 'iu')]));

/**
 * Where `_` or `__` closes inside the address `href`, or -1 if every one in there is
 * the address's own. It closes before the next address of a list. It closes at the
 * last one if the address ends with it (`_https://x/a_`), give or take what a sentence
 * puts after it (`_https://x/a_!`, where URL_RE takes the `!` in).
 */
function closeInAddress(href: string, open: string): number {
    const listed = NEXT_IN_A_LIST.get(open)!.exec(href);
    if (listed) return listed.index;
    const last = href.lastIndexOf(open);
    return last !== -1 && !/[\p{L}\p{N}/]/u.test(href.slice(last + open.length)) ? last : -1;
}

/** How long the @name, #name or :name: at `at` is, or 0. */
function nameLengthAt(input: string, at: number): number {
    if (input[at] === '@' || input[at] === '#') {
        const name = NAME_RE.exec(input.slice(at + 1));
        return name ? 1 + name[0].length : 0;
    }
    if (input[at] === ':') {
        const name = SHORTCODE_RE.exec(input.slice(at));
        if (!name) return 0;
        // `:https://…` is an address straight after a colon, and `:a://x` is words, whole.
        return input.startsWith('//', at + name[0].length) && urlAt(input.slice(at + 1)) ? 0 : name[0].length;
    }
    return 0;
}

/**
 * Where the delimiter `open` closes in the @name or #name `length` long at `at`, or
 * -1. NAME_RE takes in the `_` that closes and the `.` that ends the sentence after
 * it: `_see https://x/a @bob_.` is bob, in italics, as it is with no address in the
 * text. So a delimiter closes in what follows the name's last letter or digit. A
 * `:name:` has an end of its own.
 */
function closeInName(input: string, at: number, length: number, open: string): number {
    if (input[at] === ':') return -1;
    let tail = at + length;
    while (tail > at + 1 && '_.-'.includes(input[tail - 1])) tail--;
    const close = input.slice(tail, at + length).indexOf(open);
    return close === -1 ? -1 : tail + close;
}

/**
 * Find the matching closing delimiter for `open` starting at `from`. What the reader will
 * read as one thing, a delimiter opened before it does not close inside:
 *
 * - A spoiler, for every delimiter: in `my_file ||secret_word||` the `_` closing inside
 *   the bars makes them words and prints the secret, and the same for `a*b ||c*d||`.
 * - A link or a picture, for `_` and `__`: `my_file ![p.png](sovereign-enc:abc?k=AA_BB)`
 *   loses the picture and prints its key, and nearly any key has a `_` in it.
 * - An address, for `_` and `__`: `my_file is at https://x/my_file.txt` is not a link to
 *   https://x/my. `*` and `~` are next to never in a real address, and `**https://x/a**'s
 *   page` is bold, so every other delimiter closes at the first one, in an address or not.
 *   A spoiler closes at the first `||` for a better reason: URL_RE reads all of
 *   `https://x/a||!` as one address, and it is still a spoiler.
 * - Past any of those, a name, for `_` and `__`: it closes after it, not inside. In
 *   `my_file at https://x/a_b cc @alice_c` that is alice_c's mention, which it was before
 *   the address was stepped over. With nothing stepped over, a name is what it always was.
 */
function findClosing(input: string, from: number, open: string, reading: Reading): number {
    const stepsOver = !reading.asItWas && open.includes('_') && reading.walkLeft > 0;
    const stepsOverLinks = stepsOver && !reading.at855;
    const stepsOverSpoilers = !reading.asItWas && !reading.at855 && open !== '||' && reading.walkLeft > 0;
    const linkIsInReach = linkInReach(input);
    let steppedOver = false;
    let i = from;
    while (i < input.length) {
        // Don't let a closing delimiter be found inside inline code.
        if (input[i] === '`') {
            const close = input.indexOf('`', i + 1);
            if (close !== -1) {
                i = close + 1;
                continue;
            }
        }
        if (stepsOverLinks && (input[i] === '[' || (input[i] === '!' && input[i + 1] === '[')) && reading.walkLeft > 0 && linkIsInReach(i)) {
            const link = matchLinkParts(input[i] === '[' ? LINK_HEAD_RE : IMAGE_HEAD_RE, input.slice(i), false);
            reading.walkLeft -= link ? link.length : Math.min(LINK_READ_MOST, input.length - i);
            if (link) {
                i += link.length;
                steppedOver = true;
                continue;
            }
        }
        if (stepsOver && (input[i] === 'h' || input[i] === 'H')) {
            const href = reading.at855 ? urlAt(input.slice(i)) : addressAt(input.slice(i), reading);
            if (href) {
                reading.walkLeft -= href.length;
                const inside = closeInAddress(href, open);
                if (inside !== -1) return i + inside;
                i += href.length;
                steppedOver = true;
                continue;
            }
        }
        if (stepsOver && steppedOver) {
            const name = nameLengthAt(input, i);
            if (name) {
                const close = closeInName(input, i, name, open);
                if (close !== -1) return close;
                i += name;
                continue;
            }
        }
        if (stepsOverSpoilers && input[i] === '|' && input[i + 1] === '|') {
            const close = spoilerEnd(input, i, reading);
            if (close > i + 2) {
                reading.walkLeft -= close - i;
                i = close + 2;
                steppedOver = true;
                continue;
            }
        }
        if (input.startsWith(open, i)) return i;
        i += 1;
    }
    reading.walkLeft -= input.length - from;
    return -1;
}

/** Collect the plain-text names of all users mentioned in a message. */
export function extractMentions(content: string): { users: string[]; everyone: boolean } {
    const users = new Set<string>();
    let everyone = false;
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            if (n.type === 'mentionUser') users.add(n.name.toLowerCase());
            else if (n.type === 'mentionEveryone' || n.type === 'mentionHere') everyone = true;
            else if ('children' in n) walk(n.children);
        }
    };
    walk(parseMessage(content));
    return { users: [...users], everyone };
}
