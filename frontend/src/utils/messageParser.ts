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
 * Where the text a reader has was typed: maps a position in it to the same position in the
 * message `parseMessage` was handed. A quote's lines have their `> ` taken off before they are
 * read, and a delimiter's words are read apart from it, so each stage says how to get back.
 */
type Origin = (index: number) => number;
const atStart: Origin = (index) => index;

/**
 * Where each node of a parse was typed, from its first character to just past its last, in the
 * text `parseMessage` was handed: every spoiler (`spoilerSpan`), every run of words, and every
 * node that is drawn as more than words: a link, a picture, code, a fenced block, an address, a
 * mention, a channel, an emoji (`typedSpan`). Not what only holds others (bold, a quote), nor the
 * label a dangerous link is drawn as. Beside the tree and not in it, so a tree reads and compares
 * as it always did. A reading that disagrees with another is another tree, and each node in it
 * has its own.
 */
const typedSpans = new WeakMap<Node, [number, number] | Untold>();

/** Where a node was typed in the text its reader had, and how that maps back: told when asked
 *  (`spanOf`). Most of a parse's nodes are never asked, and a run of words is most of its nodes. */
interface Untold { at: Origin; from: number; to: number }

/** `node`, typed from `from` to just before `to` in the text a reader has, which `at` maps back. */
function typed<T extends Node>(node: T, at: Origin, from: number, to: number): T {
    typedSpans.set(node, { at, from, to });
    return node;
}

function spanOf(node: Node): readonly [number, number] | undefined {
    const known = typedSpans.get(node);
    if (!known || Array.isArray(known)) return known;
    const span: [number, number] = [known.at(known.from), known.at(known.to - 1) + 1];
    typedSpans.set(node, span);
    return span;
}

/**
 * The part of the message a spoiler was typed in, bars and all, or undefined for a node that is
 * not a spoiler of a parse. This is what lets a surface that is not the message list (the
 * previews) cover a spoiler in the message AS TYPED, rather than write the whole tree back out
 * in its own words. It may overlap the next one's by the two bars they share, where every
 * stretch between two `||` is a spoiler (`everyBar`).
 */
export function spoilerSpan(node: Node): readonly [number, number] | undefined {
    return node.type === 'spoiler' ? spanOf(node) : undefined;
}

/**
 * The part of the message a node of a parse was typed in (see `typedSpans`), or undefined for what
 * only holds other nodes and for a node not of a parse. Edit reads it to take out exactly the files
 * the message draws (api/messagePreview.ts splitEditableContent), and to leave what it draws as code,
 * an address or markup where it is.
 */
export function typedSpan(node: Node): readonly [number, number] | undefined {
    return spanOf(node);
}

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
 * `bracketed` reads a link's label as 0.9.857 did, with a `[` in it (`LINK_HEAD_RE_BEFORE`): the
 * two before it always did. `strays` is where a reading says it turned a label down.
 */
interface Reading { asItWas: boolean; at855: boolean; everyBar: boolean; bracketed: boolean; strays: Strays; walkLeft: number }
/** Whether a reading turned down a link or a picture that 0.9.857 would have read. */
interface Strays { seen: boolean }
const WALK_PER_CHAR = 32;
// A link's target, 2048 long at most, and the `)` after it.
const LINK_TARGET_MOST = 2049;
// Up to the `(` of a link's target and a picture's. Label and target are bounded so a
// non-matching '[' bails after a fixed window instead of scanning to end-of-string:
// otherwise a message of many '[' is O(n^2) and freezes the renderer (client-side DoS).
//
// A label holds no `[`: one left open before a link (`:[`, `[a`) is words, and the link starts at the
// `[` nearest its `](`, as it does in CommonMark. A label that took one in ran from the stray `[`
// through everything up to the real `](`, a spoiler's bars and the file inside them with it:
// `ugh :[ ||![p.png](sovereign-enc:…)||` was one link, no spoiler, and the file drawn in the clear
// with the words before it eaten into its name. The composer writes `_` for `[ ] ( )` in a file's
// name (api/attachments.ts), so a `[` in a label is typed, or a smiley's.
const LINK_HEAD_RE = /^\[([^[\]\n]{1,512})\]\(/;
const IMAGE_HEAD_RE = /^!\[([^[\]\n]{0,512})\]\(/;
// The same two as 0.9.857 read them, `[` in the label and all: the readings `parseMessage` falls back
// on (`asItWas`, `at855`, and 0.9.857's own) are the parsers they were, because what they hid is what a
// message may not print, and a fallback that read a link differently would hide something else.
const LINK_HEAD_RE_BEFORE = /^\[([^\]\n]{1,512})\]\(/;
const IMAGE_HEAD_RE_BEFORE = /^!\[([^\]\n]{0,512})\]\(/;
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

/** The words of each reading already counted: a reading is held to several others, and each counts it. */
const counted = new WeakMap<Node[], Words>();

/** Every word in a reading, under a spoiler or not, each with how many times. */
function wordsIn(nodes: Node[]): Words {
    let words = counted.get(nodes);
    if (!words) {
        words = { hidden: new Map(), shown: new Map() };
        countWords(nodes, false, words);
        counted.set(nodes, words);
    }
    return words;
}

function countWords(nodes: Node[], under: boolean, words: Words): void {
    const into = under ? words.hidden : words.shown;
    for (const n of nodes) {
        if ('children' in n) {
            countWords(n.children, under || n.type === 'spoiler', words);
        } else {
            for (const word of wordsOf(n).match(WORD_RE) ?? []) into.set(word, (into.get(word) ?? 0) + 1);
        }
    }
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
 *
 * 0.9.857 read a `[` in a link's label as part of the label, so `:[ ||![p.png](…)||` was one
 * link and the spoiler was gone. A label takes none now (`LINK_HEAD_RE`), and that moves
 * pairings as any better reading can. Where a reading turned a link down for it (`Strays`),
 * what 0.9.857 read is read too, and this reading may not print a word that one hid. Where none
 * did, the message is read exactly as 0.9.857 read it, and once. The second reading shares what
 * it can with the first (`once`): a message is read at most six times where it was read four.
 *
 * Whatever comes of that is held, last, to what 0.9.855 read (`heldToEarly`). 0.9.857 held every
 * reading to it but one: where each hid what the other printed, every stretch between two `||`
 * was a spoiler, and that was only asked to leave no `||` to see. A quote or a fence next to a bar
 * can end a stretch without one: `||⏎> l||:w8```||⏎```` printed the w8 0.9.855 hid, and so did
 * 0.9.857 and every version after it up to 0.9.862.
 *
 * A text read before is not read again (`kept`): its tree is the one it was, frozen.
 */
export function parseMessage(content: string): Node[] {
    if (!content) return [];
    const known = kept.get(content);
    if (known) {
        // The most recently asked for goes last, so the one asked for longest ago is first to go.
        kept.delete(content);
        kept.set(content, known);
        return known;
    }
    const nodes = frozen(parseMessageUncached(content));
    kept.set(content, nodes);
    if (kept.size > KEPT_MOST) kept.delete(kept.keys().next().value as string);
    return nodes;
}

/**
 * The trees of the texts read last. A message is read when it arrives and again on every render
 * of the chat: by the list, by who it mentions (utils/messageMentions), by the cards under it
 * (api/linkPreview), by every preview and by Edit (api/messagePreview), and a message with two
 * `||` is read up to six times over each time. The same text is the same tree, so it is kept, and
 * it is frozen, since everyone who asks for it holds the same one: nothing may change it for the next.
 */
const KEPT_MOST = 500;
const kept = new Map<string, Node[]>();

function frozen(nodes: Node[]): Node[] {
    for (const n of nodes) {
        if ('children' in n) frozen(n.children);
        Object.freeze(n);
    }
    return Object.freeze(nodes) as Node[];
}

/**
 * `parseMessage` with nothing kept: what reading a message costs the first time. For what measures
 * that (messageParser.test.ts, what a message costs to read); everything else asks `parseMessage`.
 */
export function parseMessageUncached(content: string): Node[] {
    if (!content) return [];
    const bars = content.indexOf('||');
    const spoilers = bars !== -1 && content.indexOf('||', bars + 2) !== -1;
    // Each reading that can turn a label down says so in its own `Strays`. The readings 0.9.855 and the
    // parser before it were made of take a label with a `[`, as they did, and never do.
    const nowStrays: Strays = { seen: false };
    const everyStrays: Strays = { seen: false };
    const read = readerOf(content, false, nowStrays);
    const before = once(() => read({ asItWas: true }));
    const early = once(() => readAt855(content, read, before.get));
    const now = once(() => read({}));
    const nowEvery = once(() => readerOf(content, false, everyStrays)({ everyBar: true }));
    const nodes = readEarlier(spoilers, now.get, early.get, nowEvery.get);
    if (!spoilers) return nodes;
    const held = (tree: Node[], ...others: Node[][]) => heldToEarly(content, tree, [early.get(), before.get()], others, nowEvery.get);
    if (!(nowStrays.seen || everyStrays.seen)) return held(nodes);
    // A label with a `[` in it was turned down: read as 0.9.857 did, and this held to what that hid. A
    // reading that turned none down is the one 0.9.857 read, and is not read again; nor are the readings
    // 0.9.855 was made of.
    const readOld = readerOf(content, true, nowStrays);
    const was = nowStrays.seen ? once(() => readOld({})) : now;
    const wasEvery = nowEvery.made && !everyStrays.seen ? nowEvery : once(() => readOld({ everyBar: true }));
    const asRead = readEarlier(true, was.get, early.get, wasEvery.get);
    const wordsThen = wordsIn(asRead);
    if (!printsWhatItHid(wordsIn(nodes), wordsThen)) return held(nodes, asRead);
    if (!printsWhatItHid(wordsThen, wordsIn(nodes))) return held(asRead, nodes);
    // Neither hides all the other does. Every stretch between `||` is a spoiler, if that hides what
    // 0.9.857 did and leaves no `||` to see: a quote or a fence next to a bar can end a spoiler that way.
    const everyBar = nowEvery.get();
    return showsBars(everyBar) || printsWhatItHid(wordsIn(everyBar), wordsThen) ? held(asRead, nodes) : held(everyBar, asRead, nodes);
}

/**
 * `tree`, if every character of a word 0.9.855 hid is in a spoiler of it (`earlier`: 0.9.855's
 * reading, and the parser's before it, which 0.9.855 fell back on). A word's character is what
 * WORD_RE makes words of: a letter, a digit, an emoji, a symbol, anything but a space and a mark
 * on the keyboard, which can be markup that draws nothing. Asked of where each was typed, not of
 * the words: 0.9.855 read `w0Https://x/w1` as one word and this reads an address in it, and every
 * letter of it hidden is hidden. Counting words could not see it either where the same word is said
 * twice: `a*b,||c d*e||f*g||` with every word `w` hid three `w` and printed the two 0.9.855 hid.
 * If not, 0.9.855's own reading, where that hides every such character `tree`, the parser before it
 * and the readings `tree` was held to (`others`) hid; or every stretch between two `||` a spoiler
 * (`every`), where that does and leaves no `||` to see. If neither does, no one reading keeps all
 * that hidden: from the first `||` any of them opened to the last any of them closed is one
 * spoiler (`coverAll`).
 */
function heldToEarly(content: string, tree: Node[], earlier: [Node[], Node[]], others: Node[][], every: () => Node[]): Node[] {
    if (!printsWordCharacters(content, hiddenStretches(earlier), hiddenStretches([tree]))) return tree;
    const all = hiddenStretches([tree, ...earlier, ...others]);
    if (!printsWordCharacters(content, all, hiddenStretches([earlier[0]]))) return earlier[0];
    const each = every();
    if (!showsBars(each) && !printsWordCharacters(content, all, hiddenStretches([each]))) return each;
    return coverAll(content, all[0][0], all[all.length - 1][1]);
}

/** Where every spoiler in `trees` was typed, bars and all, as stretches in order with none touching. */
function hiddenStretches(trees: Node[][]): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const walk = (nodes: Node[]) => {
        for (const n of nodes) {
            const span = spoilerSpan(n);
            if (span) spans.push([span[0], span[1]]);
            if ('children' in n) walk(n.children);
        }
    };
    for (const nodes of trees) walk(nodes);
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
        else merged.push(span);
    }
    return merged;
}

// WORD_RE's characters of a word. Letters and digits alone missed an emoji: `*||⏎> U+1F98A||```>https://x/a_b||⏎```` (a fox)
// was held to 0.9.855's reading, which hides every letter 0.9.857's did, and printed the fox 0.9.857 hid.
const WORD_CHARACTER = /[^\s!-/:-@[-`{-~]/u;

/** Whether a character of a word typed in one of `wanted` is in none of `has` (both from `hiddenStretches`). */
function printsWordCharacters(content: string, wanted: Array<[number, number]>, has: Array<[number, number]>): boolean {
    let first = 0;
    for (const [from, to] of wanted) {
        while (first < has.length && has[first][1] <= from) first++;
        let at = from;
        for (let k = first; at < to;) {
            if (k < has.length && has[k][0] <= at) {
                at = Math.max(at, has[k][1]);
                k++;
                continue;
            }
            const gap = k < has.length ? Math.min(to, has[k][0]) : to;
            if (WORD_CHARACTER.test(content.slice(at, gap))) return true;
            at = gap;
        }
    }
    return false;
}

/**
 * The message with what was typed from `from` to `to`, a `||` at each end, read as one spoiler, and
 * what is before and after it read as it would be alone: every spoiler any reading drew is inside
 * it, and so is every word one of them hid. It holds a fence or a quote as one.
 */
function coverAll(content: string, from: number, to: number): Node[] {
    const reading: Reading = { asItWas: false, at855: false, everyBar: false, bracketed: false, strays: { seen: false }, walkLeft: WALK_PER_CHAR * content.length };
    const inner = from + 2;
    const hidden = typed<Node>({ type: 'spoiler', children: parseBlocks(content.slice(inner, to - 2), reading, 1, (index) => inner + index) }, atStart, from, to);
    return [
        ...parseBlocks(content.slice(0, from), reading, 0, atStart),
        hidden,
        ...parseBlocks(content.slice(to), reading, 0, (index) => to + index),
    ];
}

/** A reader of `content`: one reading of it, made from what `how` changes in the default. */
function readerOf(content: string, bracketed: boolean, strays: Strays): (how: Partial<Reading>) => Node[] {
    return (how) => parseBlocks(content, { asItWas: false, at855: false, everyBar: false, bracketed, strays, ...how, walkLeft: WALK_PER_CHAR * content.length }, 0, atStart);
}

/** A reading, made the first time it is asked for and kept: `made` says whether it was asked for. */
function once<T>(make: () => T): { get: () => T; readonly made: boolean } {
    let value: T | undefined;
    let made = false;
    return {
        get: () => {
            if (!made) { value = make(); made = true; }
            return value as T;
        },
        get made() { return made; },
    };
}

/**
 * The first reading of a message held to what 0.9.855 and the parser before it hid, given the readings
 * it is made of, each made when asked for: all of `parseMessage` as 0.9.857 had it. `spoilers` is
 * whether two `||` are in the text, without which there is nothing to hold it to.
 */
function readEarlier(spoilers: boolean, first: () => Node[], early: () => Node[], everyBar: () => Node[]): Node[] {
    const nodes = first();
    if (!spoilers) return nodes;
    const asItWas = early();
    const words = wordsIn(nodes);
    const wordsThen = wordsIn(asItWas);
    if (!printsWhatItHid(words, wordsThen)) return nodes;
    if (!printsWhatItHid(wordsThen, words)) return asItWas;
    const every = everyBar();
    return showsBars(every) ? asItWas : every;
}

/**
 * What 0.9.855 read: its own reading, or the one before it where its own hid fewer of a
 * word, which was its rule. With no address and no link in the text the two are one.
 */
function readAt855(content: string, read: (how: Partial<Reading>) => Node[], asItWas: () => Node[]): Node[] {
    const before = asItWas();
    if (!content.includes('://') && !content.includes('](')) return before;
    const own = read({ at855: true });
    const hidden = wordsIn(own).hidden;
    for (const [word, times] of wordsIn(before).hidden) {
        if ((hidden.get(word) ?? 0) < times) return before;
    }
    return own;
}

/** Block level: fenced code blocks and blockquotes, then inline for the rest. */
function parseBlocks(input: string, reading: Reading, depth: number, at: Origin): Node[] {
    const nodes: Node[] = [];
    let rest = input;

    while (rest.length > 0) {
        const base = input.length - rest.length;
        const here: Origin = (index) => at(base + index);
        // Fenced code block: ```lang\n...\n``` (lang optional).
        const fence = matchCodeBlock(rest);
        if (fence) {
            nodes.push(typed(fence.node, here, 0, fence.length));
            rest = rest.slice(fence.length);
            continue;
        }

        // Blockquote: a run of lines each starting with "> " (or ">").
        const quote = matchBlockquote(rest, reading, depth + 1, here);
        if (quote) {
            nodes.push(quote.node);
            rest = rest.slice(quote.length);
            continue;
        }

        // Otherwise consume up to the next block construct and inline-parse it.
        const chunk = rest.slice(0, chunkEnd(rest, reading));
        nodes.push(...parseInline(chunk, depth, reading, here));
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
 * about code, and the code would be gone until pressed. Nor does a pair with a letter or a
 * digit right outside it: `x||y fails:`, some code and `but p||q works`. That holds where
 * the readings disagree too: 0.9.855 hid no block, so one printed is printed as it was.
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
            if ((rest[open - 1] === ' ' && rest[open + 2] === ' ') || isWordChar(rest[open - 1]) || isWordChar(rest[close + 2])) return cut;
            cut = nextBlock(rest, at);
        }
    }
    return cut;
}

function isWordChar(ch: string | undefined): boolean {
    return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
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

function matchBlockquote(s: string, reading: Reading, depth: number, at: Origin): { node: Node; length: number } | null {
    if (!(s.startsWith('> ') || s.startsWith('>\n') || s === '>')) return null;
    // Up to the first line that is not quoted, and no further: a text of very short
    // quotes comes back here for each one, with nearly all of itself still to read.
    const quoted: string[] = [];
    // Where each line's words begin: in the quote as it is read (the lines joined) and in `s`.
    const begins: Array<[number, number]> = [];
    let joined = 0;
    let consumed = 0;
    while (consumed < s.length) {
        const nl = s.indexOf('\n', consumed);
        const line = s.slice(consumed, nl === -1 ? s.length : nl);
        if (line !== '>' && !line.startsWith('> ')) break;
        const words = line === '>' ? '' : line.slice(2);
        begins.push([joined, consumed + line.length - words.length]);
        quoted.push(words);
        joined += words.length + 1;
        consumed += line.length + 1; // + newline
    }
    if (quoted.length === 0) return null;
    const length = Math.min(consumed, s.length);
    const inQuote: Origin = (index) => {
        // The last line that begins at or before `index` (a binary search: a quote of a thousand
        // lines with a spoiler on each asked the lines one by one, from the end, for every spoiler).
        let line = 0;
        let high = begins.length - 1;
        while (line < high) {
            const mid = (line + high + 1) >> 1;
            if (begins[mid][0] > index) high = mid - 1;
            else line = mid;
        }
        return at(begins[line][1] + index - begins[line][0]);
    };
    return { node: { type: 'blockquote', children: parseInline(quoted.join('\n'), depth, reading, inQuote) }, length };
}

/** Find the index of the first line (after start, and at or after `from`) beginning with `>`. */
function findQuoteLine(s: string, from: number): number {
    const nl = s.indexOf('\n>', from);
    return nl === -1 ? -1 : nl + 1;
}

type LinkParts = { label: string; href: string; length: number };

/**
 * The link or picture at the start of `rest` in the reading, or null. A reading whose labels
 * hold no `[` says so when it turns down one that 0.9.857 would have read (`Strays`): that
 * is the only message it can read otherwise than 0.9.857 did.
 */
function readLink(rest: string, image: boolean, reading: Reading): LinkParts | null {
    const old = reading.bracketed || reading.asItWas || reading.at855;
    const m = (old ? (image ? IMAGE_HEAD_RE_BEFORE : LINK_HEAD_RE_BEFORE) : (image ? IMAGE_HEAD_RE : LINK_HEAD_RE)).exec(rest);
    if (m) return linkFrom(m, rest, reading.asItWas);
    if (!old && !reading.strays.seen) {
        const was = (image ? IMAGE_HEAD_RE_BEFORE : LINK_HEAD_RE_BEFORE).exec(rest);
        if (was && linkFrom(was, rest, false)) reading.strays.seen = true;
    }
    return null;
}

/**
 * What a link or a picture holds, at the start of `rest`, with `m` its head: the match up to
 * the `(` of its target. The target takes in the brackets it opens, so
 * `[w](https://x/Foo_(bar))` keeps its own, and it stops at the first `)` that
 * closes none: `[a](b) (c)` does not take in `(c)`. With no such `)`, as in
 * `[a](https://x/(b)`, it stops at the first `)` it passed, as it always used to
 * (`asItWas`). Bounded, like the head.
 */
function linkFrom(m: RegExpExecArray, rest: string, asItWas: boolean): LinkParts | null {
    const start = m[0].length;
    const limit = Math.min(rest.length, start + LINK_TARGET_MOST);
    // With no `)` in reach there is no link, and a text of many `[` need not read its targets to know.
    const closer = rest.indexOf(')', start);
    if (closer === -1 || closer >= limit) return null;
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
        } else if (c <= 32 ? c === 32 || (c >= 9 && c <= 13) : c >= 160 && isWideSpace(c)) break;
    }
    if (first !== -1 && (end === -1 || asItWas)) end = first;
    return end > 0 ? { label: m[1], href: rest.slice(start, start + end), length: start + end + 1 } : null;
}

/** Whether the code unit `c`, 160 or more, is one `\s` matches: the same list, with no
 *  regular expression run on every character of a target in another script. */
function isWideSpace(c: number): boolean {
    return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
        || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Inline parser: emits text runs interleaved with markup nodes. */
function parseInline(input: string, depth: number, reading: Reading, at: Origin): Node[] {
    const { asItWas } = reading;
    const linkIsInReach = linkInReach(input);
    const nodes: Node[] = [];
    let buf = '';
    // Where the words in `buf` begin: they are typed in one run, up to `i`.
    let from = 0;
    let i = 0;

    const say = (words: string) => {
        if (!buf) from = i;
        buf += words;
    };
    const flush = () => {
        if (buf) {
            nodes.push(typed({ type: 'text', value: buf }, at, from, from + buf.length));
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
                nodes.push(typed({ type: 'code', value: input.slice(i + 1, close) }, at, i, close + 1));
                i = close + 1;
                continue;
            }
        }

        // Image: ![alt](url)
        if (ch === '!' && input[i + 1] === '[' && linkIsInReach(i)) {
            const m = readLink(rest, true, reading);
            if (m) {
                flush();
                // Neutralize a dangerous scheme (javascript:, data:, …): keep the
                // alt text, drop the href, so it never renders as an <img src>. (H7)
                if (isSafeUrl(m.href)) nodes.push(typed({ type: 'image', alt: m.label, href: m.href }, at, i, i + m.length));
                else if (m.label) nodes.push({ type: 'text', value: m.label });
                i += m.length;
                continue;
            }
        }

        // Link: [label](url)
        if (ch === '[' && linkIsInReach(i)) {
            const m = readLink(rest, false, reading);
            if (m) {
                flush();
                // Neutralize a dangerous scheme: drop the href and keep the label
                // as plain text so `[x](javascript:…)` is never a clickable link. (H7)
                if (isSafeUrl(m.href)) nodes.push(typed({ type: 'link', label: m.label, href: m.href }, at, i, i + m.length));
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
                nodes.push(typed({ type: 'url', href }, at, i, i + href.length));
                i += href.length;
                continue;
            }
        }

        // Mentions and channels.
        if (ch === '@') {
            if (rest.startsWith('@everyone') && !isNameChar(rest[9])) {
                flush();
                nodes.push(typed({ type: 'mentionEveryone' }, at, i, i + '@everyone'.length));
                i += '@everyone'.length;
                continue;
            }
            if (rest.startsWith('@here') && !isNameChar(rest[5])) {
                flush();
                nodes.push(typed({ type: 'mentionHere' }, at, i, i + '@here'.length));
                i += '@here'.length;
                continue;
            }
            const nm = NAME_RE.exec(rest.slice(1));
            if (nm) {
                flush();
                nodes.push(typed({ type: 'mentionUser', name: nm[0] }, at, i, i + 1 + nm[0].length));
                i += 1 + nm[0].length;
                continue;
            }
        }
        if (ch === '#') {
            const nm = NAME_RE.exec(rest.slice(1));
            if (nm) {
                flush();
                nodes.push(typed({ type: 'channel', name: nm[0] }, at, i, i + 1 + nm[0].length));
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
                    say(':');
                    flush();
                    nodes.push(typed({ type: 'url', href }, at, i + 1, i + 1 + href.length));
                    i += 1 + href.length;
                } else {
                    say(m[0]);
                    i += m[0].length;
                }
                continue;
            }
            if (m) {
                flush();
                nodes.push(typed({ type: 'emoji', name: m[1] }, at, i, i + m[0].length));
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
                        const inner = i + delim.open.length;
                        const within: Origin = (index) => at(inner + index);
                        const children = delim.type === 'spoiler' && !asItWas && !reading.at855 && holdsBlock(innerText)
                            ? parseBlocks(innerText, reading, depth + 1, within)
                            : parseInline(innerText, depth + 1, reading, within);
                        const node = { type: delim.type, children } as Node;
                        nodes.push(node.type === 'spoiler' ? typed(node, at, i, closeIdx + delim.open.length) : node);
                        i = closeIdx + delim.open.length;
                        // This `||` opens the next stretch too, if any `||` is left to close it.
                        if (reading.everyBar && delim.type === 'spoiler' && findClosing(input, i, '||', reading) !== -1) i = closeIdx;
                        continue;
                    }
                }
            }
        }

        say(ch);
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
            const link = readLink(input.slice(i), input[i] !== '[', reading);
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
