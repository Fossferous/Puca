/**
 * A checklist copied as RENDERED text reads from the clipboard's HTML
 * (notes/model/pastedHtml.ts, through noteContent.ts readPastedItems).
 *
 * The owner's paste: an assistant's answer selected on the page instead of
 * taken with its Copy button. Its plain text has no "#" and no "- [ ]" left,
 * so it pasted as one item per line — the chatty intro, the title and every
 * section heading each one more box to tick. The HTML beside it still had
 * the <h1>, the <h2>s, the <li>s and the checkboxes.
 *
 * The inertness is pinned here as far as jsdom can see it (the markup never
 * reaches the page, a handler never runs, the parse is DOMParser's); jsdom
 * fetches no image whatever the code does, so e2e/paste-html-real-browser.mjs
 * proves the rest in a real Chromium.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_OPEN, MAX_PASTE_HTML, htmlToMarkdown, tooCostlyToParse } from '../notes/model/pastedHtml';
import { readChecklist, readPaste, readPastedItems, type TransferLike } from '../notes/model/noteContent';
import { ASSISTANT_ANSWER, ASSISTANT_HTML, ASSISTANT_ITEMS, ASSISTANT_RENDERED_LINES, ASSISTANT_RENDERED_TEXT, ASSISTANT_TITLE } from './fixtures/assistantChecklist';

/** The Markdown the owner's checklist was written in (tests/notesHeadings). */
const OWNER_MARKDOWN = `Here's your 0.9.826 test checklist:

# Púca 0.9.826 test checklist

## Before you start
- [ ] Update the desktop app to 0.9.826 (the updater should offer it)
- [ ] Let Púca and Púca Notes on your phone pick up the update (open each once)

## Paste this checklist (the tests themselves)
- [ ] On the PC, copy this message with the Copy button under it
- [ ] Click the rail's Tasks & notes: Púca Notes opens inside Púca, not in a browser

## Calendar
- [ ] Snooze an item from the Notes calendar: it moves once, to your morning time

That's everything new in 0.9.826, so tick as you go!`;

/** What the owner's clipboard held as plain text: a real Chromium's
 *  selection of that message rendered (measured; the space before each step
 *  is the checkbox's). */
const OWNER_TEXT = "Here's your 0.9.826 test checklist:\n\nPúca 0.9.826 test checklist\nBefore you start\n Update the desktop app to 0.9.826 (the updater should offer it)\n Let Púca and Púca Notes on your phone pick up the update (open each once)\nPaste this checklist (the tests themselves)\n On the PC, copy this message with the Copy button under it\n Click the rail's Tasks & notes: Púca Notes opens inside Púca, not in a browser\nCalendar\n Snooze an item from the Notes calendar: it moves once, to your morning time\nThat's everything new in 0.9.826, so tick as you go!";

/** ...and the HTML beside it, as Chromium writes a copied selection. */
const box = '<input type="checkbox" disabled="" style="margin: 0px 6px 0px 0px;">';
const OWNER_HTML = "<meta charset='utf-8'><!--StartFragment-->"
    + '<p style="white-space: normal;">Here\'s your 0.9.826 test checklist:</p>'
    + '<h1 style="font-size: 24px;">Púca 0.9.826 test checklist</h1>'
    + '<h2 style="font-size: 20px;">Before you start</h2>'
    + `<ul class="contains-task-list"><li class="task-list-item">${box} Update the desktop app to 0.9.826 (the updater should offer it)</li>`
    + `<li class="task-list-item">${box} Let Púca and Púca Notes on your phone pick up the update (open each once)</li></ul>`
    + '<h2>Paste this checklist (the tests themselves)</h2>'
    + `<ul class="contains-task-list"><li class="task-list-item">${box} On the PC, copy this message with the Copy button under it</li>`
    + `<li class="task-list-item">${box} Click the rail's Tasks &amp; notes: Púca Notes opens inside Púca, not in a browser</li></ul>`
    + '<h2>Calendar</h2>'
    + `<ul class="contains-task-list"><li class="task-list-item">${box} Snooze an item from the Notes calendar: it moves once, to your morning time</li></ul>`
    + "<p>That's everything new in 0.9.826, so tick as you go!</p><!--EndFragment-->";

const OWNER_TITLE = 'Púca 0.9.826 test checklist';
const OWNER_ITEMS = [
    '## Before you start',
    'Update the desktop app to 0.9.826 (the updater should offer it)',
    'Let Púca and Púca Notes on your phone pick up the update (open each once)',
    '## Paste this checklist (the tests themselves)',
    'On the PC, copy this message with the Copy button under it',
    "Click the rail's Tasks & notes: Púca Notes opens inside Púca, not in a browser",
    '## Calendar',
    'Snooze an item from the Notes calendar: it moves once, to your morning time',
];

/** A clipboard as a paste event hands it over: each format asked for by
 *  name, '' for one it does not carry. */
const clipboard = (formats: Record<string, string>): TransferLike =>
    ({ files: [], items: [], getData: (f: string) => formats[f === 'text' ? 'text/plain' : f] ?? '' });

afterEach(() => { vi.restoreAllMocks(); });

describe('a checklist copied as rendered text', () => {
    it("the owner's clipboard: the title is the note's, each section a HEADING, each step an item", () => {
        const read = readPastedItems(OWNER_TEXT, { html: OWNER_HTML });
        expect(read).toEqual({ items: OWNER_ITEMS, total: OWNER_ITEMS.length, title: OWNER_TITLE });
        // Exactly what the Markdown it was written in reads as.
        expect(read).toEqual(readPastedItems(OWNER_MARKDOWN));
        // THE DEFECT, as it was: the plain text alone is one item per line,
        // the intro, the title and every heading among them.
        const before = readPastedItems(OWNER_TEXT);
        expect(before?.title).toBeNull();
        expect(before?.items.slice(0, 3)).toEqual(["Here's your 0.9.826 test checklist:", OWNER_TITLE, 'Before you start']);
    });

    it("an assistant's answer selected on the page reads as the one taken with its Copy button", () => {
        const read = readPastedItems(ASSISTANT_RENDERED_TEXT, { html: ASSISTANT_HTML });
        expect(read).toEqual({ items: ASSISTANT_ITEMS, total: ASSISTANT_ITEMS.length, title: ASSISTANT_TITLE });
        expect(read).toEqual(readPastedItems(ASSISTANT_ANSWER));
        // POSITIVE CONTROL: the same plain text without its HTML.
        expect(readPastedItems(ASSISTANT_RENDERED_TEXT)?.items).toEqual(ASSISTANT_RENDERED_LINES);
    });

    it('a TITLE field takes it too (only a real checklist is taken there)', () => {
        expect(readPastedItems(OWNER_TEXT, { html: OWNER_HTML, checklistOnly: true })?.title).toBe(OWNER_TITLE);
        // POSITIVE CONTROL: without the HTML, the lines are no checklist, so
        // they paste as the title would take them.
        expect(readPastedItems(OWNER_TEXT, { checklistOnly: true })).toBeNull();
    });

    it("readPaste reads both formats of a paste; 'Add as one item' keeps the plain text", () => {
        const { text, read } = readPaste(clipboard({ 'text/plain': ASSISTANT_RENDERED_TEXT, 'text/html': ASSISTANT_HTML }));
        expect(read?.items).toEqual(ASSISTANT_ITEMS);
        expect(read?.title).toBe(ASSISTANT_TITLE);
        expect(text).toBe(ASSISTANT_RENDERED_TEXT);
        // A clipboard with only HTML: its items, as the one line.
        const only = readPaste(clipboard({ 'text/html': ASSISTANT_HTML }));
        expect(only.read?.items).toEqual(ASSISTANT_ITEMS);
        expect(only.text).toBe(ASSISTANT_ITEMS.map(i => i.replace(/^## /, '')).join('\n'));
        // No transfer, or one that throws when asked: nothing.
        expect(readPaste(null)).toEqual({ text: '', read: null });
        expect(readPaste({ getData: () => { throw new Error('denied'); } })).toEqual({ text: '', read: null });
    });
});

describe('the HTML, as Markdown', () => {
    const md = (html: string) => htmlToMarkdown(html);

    it('headings keep their level; one inside a list item is only its text', () => {
        expect(md('<h1>A</h1><h3>B</h3><h6>C</h6>')).toBe('# A\n### B\n###### C');
        expect(md('<ul><li><h3>Step</h3><p>more</p></li></ul>')).toBe('- Step\n  more');
    });

    it('list items are "- " and "1. ", nested lists indented under their item', () => {
        expect(md('<ol start="3"><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li><li>d</li></ol>'))
            .toBe('3. a\n   - b\n     1. c\n4. d');
        expect(readChecklist(md('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')!)?.items).toEqual(['a', 'b', 'c']);
    });

    it('a second paragraph, or a line break, in an item joins that item', () => {
        expect(md('<ul><li><p>Plug it in</p><p>the grey cable</p></li><li>Turn it on<br>and wait</li></ul>'))
            .toBe('- Plug it in\n  the grey cable\n- Turn it on\n  and wait');
        expect(readChecklist(md('<ul><li><p>Plug it in</p><p>the grey cable</p></li><li>Turn it on</li></ul>')!)?.items)
            .toEqual(['Plug it in — the grey cable', 'Turn it on']);
    });

    it('a checkbox is "[ ]", a checked one "[x]" — an input, or anything with role="checkbox"', () => {
        expect(md('<ul><li><input type="checkbox"> a</li><li><input type="checkbox" checked> b</li></ul>'))
            .toBe('- [ ] a\n- [x] b');
        expect(md('<div><span role="checkbox" aria-checked="true"></span><span>Milk</span></div><div><div role="checkbox" aria-checked="false"></div><div>Bread</div></div>'))
            .toBe('[x] Milk\n[ ] Bread');
        // A task-list item in a loose list: the box inside its paragraph.
        expect(md('<ul><li><p><input type="checkbox" disabled> Pack</p></li></ul>')).toBe('- [ ] Pack');
        // Any other input is not text.
        expect(md('<p><input type="text" value="secret"> Name</p>')).toBe('Name');
    });

    it('a code block is fenced, and joins the step it is under', () => {
        const html = '<ol><li>Update</li><li>Run this:<pre><code>sudo apt update\nsudo apt upgrade</code></pre></li></ol>';
        expect(md(html)).toBe('1. Update\n2. Run this:\n   ```\n   sudo apt update\n   sudo apt upgrade\n   ```');
        expect(readChecklist(md(html)!)?.items).toEqual(['Update', 'Run this: — sudo apt update — sudo apt upgrade']);
        // A fence INSIDE the code cannot end the block early.
        expect(md('<pre>```md\n- [ ] not a step\n```</pre>')).toBe('```\n- [ ] not a step\n```');
    });

    it('inline marks are dropped the way plainInline drops them; a link keeps its address', () => {
        expect(md('<p><strong>Bold</strong>, <em>it</em>, <code>code</code>, <del>gone</del>, <kbd>Ctrl</kbd></p>'))
            .toBe('Bold, it, code, gone, Ctrl');
        expect(md('<p>See <a href="https://example.com/docs">the docs</a></p>')).toBe('See the docs (https://example.com/docs)');
        // A link that reads as its address is said once; a bare host loses the
        // "/" a browser adds; a page-relative or script link is only its text.
        expect(md('<p><a href="https://example.com/">https://example.com</a></p>')).toBe('https://example.com');
        expect(md('<p><a href="http://192.168.1.1/">admin</a></p>')).toBe('admin (http://192.168.1.1)');
        expect(md('<p><a href="#setup">Setup</a> <a href="javascript:alert(1)">run</a> <a href="/x">x</a></p>')).toBe('Setup run x');
        expect(md('<p><img alt="Warning:" src="x.png"> hot</p>')).toBe('Warning: hot');
        // A link whose text a box splits over two lines gives its address to neither.
        expect(md('<p><a href="https://example.com/a">see <input type="checkbox"> this</a></p>')).toBe('see\n[ ] this');
    });

    it('a table row is one line, its cells apart', () => {
        expect(md('<table><tr><th>Day</th><th>Task</th></tr><tr><td>Mon</td><td>Bins</td></tr></table>'))
            .toBe('Day | Task\nMon | Bins');
    });

    it('white-space: pre-wrap keeps its lines; the default does not', () => {
        expect(md('<div style="white-space: pre-wrap;">- a\n- b</div>')).toBe('- a\n- b');
        expect(md('<div>- a\n- b</div>')).toBe('- a - b');
    });

    it('what was not on the page is not read: head, style, script, comments, hidden elements, buttons', () => {
        const html = '<head><title>Page</title><style>li::before { content: "- x" }</style></head><body>'
            + '<!-- - [ ] a comment --><script>document.title = "- [ ] ran"</script><noscript>- no</noscript>'
            + '<ul><li>a<button>Copy</button></li><li hidden>b</li><li style="display: none">c</li><li>d</li></ul>'
            + '<template><li>e</li></template><svg><text>f</text></svg></body>';
        expect(md(html)).toBe('- a\n- d');
    });
});

describe('the plain text, when the HTML is not a checklist', () => {
    it('HTML with no list falls back to the text EXACTLY as before', () => {
        const text = 'Milk\nBread\nEggs';
        for (const html of [
            '<p>Milk<br>Bread<br>Eggs</p>',
            '<p>A paragraph that is not a list at all, only prose.</p>',
            // A spreadsheet range: a table beside tab-separated text.
            '<table><tr><td>Milk</td><td>2</td></tr><tr><td>Bread</td><td>1</td></tr></table>',
            '',
        ]) {
            expect(readPastedItems(text, { html }), html).toEqual(readPastedItems(text));
            expect(readPastedItems(text, { html, checklistOnly: true }), html).toBeNull();
        }
        // POSITIVE CONTROL: the same lines as a list in the HTML are read from it.
        expect(readPastedItems('Milk\nBread', { html: '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>' })?.title).toBe('Shop');
    });

    it('a checklist in the plain text is still read when its HTML is none', () => {
        expect(readPastedItems(ASSISTANT_ANSWER, { html: `<pre>${ASSISTANT_ANSWER}</pre>` })).toEqual(readPastedItems(ASSISTANT_ANSWER));
    });
});

describe('hostile markup does nothing and runs nothing', () => {
    const HOSTILE = '<ul><li>a</li><li>b</li></ul>'
        + '<script>window.__pasteRan = "script"</script>'
        + '<img src="x:nothing" onerror="window.__pasteRan = \'img\'">'
        + '<svg onload="window.__pasteRan = \'svg\'"></svg>'
        + '<iframe src="about:blank" onload="window.__pasteRan = \'iframe\'"></iframe>'
        + '<details open ontoggle="window.__pasteRan = \'details\'"></details>'
        + '<link rel="stylesheet" href="x:sheet"><style>@import "x:import";</style>'
        + '<meta http-equiv="refresh" content="0; url=x:away">'
        + '<body onload="window.__pasteRan = \'body\'">';
    const ran = () => (window as unknown as { __pasteRan?: string }).__pasteRan;

    it('parsed only by DOMParser, into a document with no window, and never into the page', async () => {
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const seen: MutationRecord[] = [];
        const watch = new MutationObserver(r => { seen.push(...r); });
        watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        const before = document.documentElement.outerHTML;

        expect(readPastedItems('a\nb', { html: HOSTILE })?.items).toEqual(['a', 'b']);
        await new Promise(r => { setTimeout(r, 50); });   // any handler would have fired by now
        watch.disconnect();

        expect(parse).toHaveBeenCalledWith(HOSTILE, 'text/html');
        const parsed = parse.mock.results[0].value as Document;
        expect(parsed).not.toBe(document);
        expect(parsed.defaultView, 'a detached document: no browsing context').toBeNull();
        expect(seen, 'nothing was added to the page').toEqual([]);
        expect(document.documentElement.outerHTML).toBe(before);
        expect(ran()).toBeUndefined();
    });

    it(`more than ${MAX_PASTE_HTML} characters of markup is not parsed: the plain text is read`, () => {
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const list = '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>';
        const huge = list + `<p>${'x'.repeat(MAX_PASTE_HTML)}</p>`;
        expect(readPastedItems('Milk\nBread', { html: huge })).toEqual(readPastedItems('Milk\nBread'));
        expect(parse).not.toHaveBeenCalled();
        // POSITIVE CONTROL: the same list just under the cap IS read.
        const under = list + `<p>${'x'.repeat(MAX_PASTE_HTML - list.length - 7)}</p>`;
        expect(under.length).toBe(MAX_PASTE_HTML);
        expect(readPastedItems('Milk\nBread', { html: under })?.title).toBe('Shop');
    });

    it('markup nested past reading is not even parsed: the plain text is read, and nothing throws', () => {
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        const deep = '<div>'.repeat(2_000) + '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>';
        expect(htmlToMarkdown(deep)).toBeNull();
        expect(readPastedItems('Milk\nBread', { html: deep })).toEqual(readPastedItems('Milk\nBread'));
        expect(parse).not.toHaveBeenCalled();
        // POSITIVE CONTROL: a sane depth is read.
        const sane = '<div>'.repeat(50) + '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>';
        expect(readPastedItems('Milk\nBread', { html: sane })?.title).toBe('Shop');
    });
});

describe('the scan before the parse (what a browser is slow on)', () => {
    const LIST = '<h2>Shop</h2><ul><li>Milk</li><li>Bread</li></ul>';
    const nest = (open: string, n: number) => open.repeat(n) + LIST;

    it(`refuses more than ${MAX_OPEN} elements open at once, and not ${MAX_OPEN}`, () => {
        expect(tooCostlyToParse('<div>'.repeat(MAX_OPEN))).toBe(false);
        expect(tooCostlyToParse('<div>'.repeat(MAX_OPEN + 1))).toBe(true);
        // A list under them is two more (<ul>, <li>).
        expect(tooCostlyToParse(nest('<div>', MAX_OPEN - 2))).toBe(false);
        expect(tooCostlyToParse(nest('<div>', MAX_OPEN - 1))).toBe(true);
        expect(tooCostlyToParse(nest('<span>', 5_000))).toBe(true);
        expect(tooCostlyToParse(nest('<template>', 5_000))).toBe(true);       // crashed Chromium's renderer
    });

    it('closed elements are closed: any number of them in a row is shallow', () => {
        expect(tooCostlyToParse('<div><p>x</p></div>'.repeat(10_000))).toBe(false);
        expect(tooCostlyToParse(`<ul>${'<li><b>step</b> <a href="https://x.example/">link</a></li>'.repeat(5_000)}</ul>`)).toBe(false);
        // What the parser closes by itself: an <li> the next one ends, a <p> a
        // block ends, a cell the next cell or row ends, an <option> the next.
        expect(tooCostlyToParse(`<ul>${'<li>a<p>b'.repeat(5_000)}</ul>`)).toBe(false);
        expect(tooCostlyToParse(`<table>${'<tr><td>a<td>b'.repeat(5_000)}</table>`)).toBe(false);
        expect(tooCostlyToParse(`<dl>${'<dt>a<dd>b'.repeat(5_000)}</dl>`)).toBe(false);
        expect(tooCostlyToParse('<p>a'.repeat(5_000))).toBe(false);
    });

    it('an end tag it cannot match closes nothing, however it is dressed up', () => {
        // Stray, misnested, or the parser keeps the element open: each of
        // these nests, and each was seconds in Chromium.
        for (const unit of ['<div></span>', '<div><table><td></div>', '<b><div>x</b>', '<a><div>x</a>', '<b><i><u><s>x</b>', '<table><caption>', '<svg><title>']) {
            expect(tooCostlyToParse(unit.repeat(1_000)), unit).toBe(true);
        }
    });

    it('text that hides tags from a naive reader hides nothing from this one', () => {
        const divs = '<div>'.repeat(MAX_OPEN + 10);
        // A quote inside an UNQUOTED value opens nothing.
        expect(tooCostlyToParse(`<p a=b'c>${divs}'`)).toBe(true);
        // A comment ends at "--!>" as well as "-->"; "<!-->" is a whole comment.
        expect(tooCostlyToParse(`<!-- x --!>${divs}-->`)).toBe(true);
        expect(tooCostlyToParse(`<!-->${divs}-->`)).toBe(true);
        // <script> text is skipped only where the parser skips it: not in
        // <svg>, and <plaintext> ends nothing inside a <select>.
        expect(tooCostlyToParse(`<svg><script>${divs}</script></svg>`)).toBe(true);
        expect(tooCostlyToParse(`<select><plaintext></select>${divs}`)).toBe(true);
        // POSITIVE CONTROLS: the same tags in real script text, a quoted
        // value, or a comment are not markup.
        expect(tooCostlyToParse(`<script>${divs}</script>${LIST}`)).toBe(false);
        expect(tooCostlyToParse(`<p a="${divs}">x</p>`)).toBe(false);
        expect(tooCostlyToParse(`<!-- ${divs} -->${LIST}`)).toBe(false);
    });

    it('a thousand comments at the top of the document, or after </html>, is too many; inside the body, any number', () => {
        const c = '<!---->';
        expect(tooCostlyToParse(c.repeat(1_000) + LIST)).toBe(false);
        expect(tooCostlyToParse(c.repeat(1_001) + LIST)).toBe(true);
        expect(tooCostlyToParse(`<html>${'<?x>'.repeat(1_001)}`)).toBe(true);
        expect(tooCostlyToParse(`x${'</html><!---->'.repeat(1_001)}`)).toBe(true);
        expect(tooCostlyToParse(`<p>x</p>${c.repeat(50_000)}`)).toBe(false);
        expect(tooCostlyToParse(`<meta charset='utf-8'>${c.repeat(50_000)}`)).toBe(false);
    });

    it('a third <html> or <body> with attributes is refused; the clipboard\'s own two are not', () => {
        expect(tooCostlyToParse(`<html lang="en"><body class="x">${LIST}`)).toBe(false);
        expect(tooCostlyToParse(`<html a><body b><body c>${LIST}`)).toBe(true);
        expect(tooCostlyToParse(`${'<body>'.repeat(5_000)}${LIST}`)).toBe(false);    // nothing to merge
    });

    it("the clipboard markup browsers and editors write passes", () => {
        expect(tooCostlyToParse(OWNER_HTML)).toBe(false);
        expect(tooCostlyToParse(ASSISTANT_HTML)).toBe(false);
        // Word's: a head of conditional comments and styles, "o:p" elements.
        const word = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8">'
            + '<style><!-- p.MsoNormal { margin: 0 } --></style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--></head>'
            + '<body lang=EN-US><!--StartFragment--><p class=MsoNormal>Milk<o:p></o:p></p><!--EndFragment--></body></html>';
        expect(tooCostlyToParse(word)).toBe(false);
    });
});
