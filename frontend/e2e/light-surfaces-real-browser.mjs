// What is painted on the Light theme's surfaces, in a real browser, on all eight themes.
//
// WHY THIS EXISTS. :root in styles/theme.css is the dark palette, and a theme only has an answer for
// what it redefines. Light had none for --bg-floating, so every popover, sheet and bar painted with
// it stayed near black under Light's dark words: 1.53:1, and 1.09:1 with High Contrast. A handful had
// been fixed one surface at a time, each leaving a comment warning about the token. Nothing in jsdom
// has colours, and the theme walks open few of these. A review listed thirteen of them; measuring
// everything found the same bug on many more, down to 1.00:1. docs/DESIGN_PHILOSOPHY.md section 6 says
// what to do about a surface of your own.
//
// It reads colours back from the real stylesheet, the one main.tsx's own imports build:
//
//   1. every surface in SURFACES, wherever the source puts it (e2e/theme-surfaces/skeleton.mjs turns
//      the real JSX into markup, so there is no fixture to go stale), on all eight themes with and
//      without High Contrast, at 1280x800 and at 390x844 on a touchscreen: every run of words at
//      4.5:1 over what is painted behind it, every icon-only control at 3:1;
//   2. real components mounted on their props, to the same bar, and painted the same as the skeleton
//      says, so the skeleton cannot quietly measure something the app does not draw;
//   3. the screen itself: a screenshot's paper must be the colour computed and its ink readable, so
//      nothing lying over a surface is missed;
//   4. every component in the app on Light: nothing under 3:1 that the dark theme holds, past the
//      short list in NOT_AS_DRAWN, each entry with its reason;
//   5. NEGATIVE CONTROLS. OLD_LIGHT is Light's colours as they were: every surface must fail on it,
//      or the checks above prove nothing, and the whole-app sweep must report it. OLD_SHARED does the
//      same for the words that were below the bar on every theme. A colour this cannot read fails
//      the run rather than being skipped (color-mix() once went unread that way, and passed).
//
// With an outdir: a screenshot of every real mount on Light, as it is and with OLD_LIGHT, and on the
// worst look of the seven other themes. No server, no build. Headless and silent.

import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsx, toHtml } from './theme-surfaces/skeleton.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const outDir = process.argv[2] || null;
if (outDir) mkdirSync(outDir, { recursive: true });
const workDir = join(here, '..', 'node_modules', '.tmp', 'light-surfaces');
mkdirSync(workDir, { recursive: true });

const THEMES = ['light', 'dark', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const CONTRASTS = ['normal', 'high'];
const LOOKS = THEMES.flatMap(theme => CONTRASTS.map(contrast => [theme, contrast]));

// A class, or a component (all its call sites, so a popover is measured with what is really in it).
const SURFACES = [
    // What the review of 0.9.855 listed.
    '.cal-menu', '.nick-edit-modal', '.notes-draw', '.ni-tool', '.notes-snooze-menu', '<Popover', '.notes-undo',
    '.notes-selectbar', '.notes-update-strip', '.games-sheet', '.games-disclosure', '.sched-dialog', '.e2ee-tooltip',
    '.link-preview-card',
    // The sweep's: the same token, and the same bug through a token no theme defined.
    '.notes-card-select', '.device-stage-typetext', '.clip-approval', '.clip-composer', '.host-consent', '.ua-prompt',
    '.role-modal', '.safety-modal', '.device-stage-bar', '.dsb-menu', '.stream-context-menu',
];

// Light as it was, on top of the real stylesheet. Must fail, surface by surface.
const OLD_LIGHT = `
[data-theme="light"] {
    --bg-floating: #0d0e10; --bg-hover: #1e1f22;
    --background-primary: initial; --background-secondary: initial; --background-tertiary: initial;
    --background-floating: initial; --background-modifier-accent: initial;
    --background-modifier-hover: initial; --background-modifier-selected: initial;
    --text-primary: initial; --text-secondary: initial; --danger-color: initial; --warning: initial; --danger: initial;
    --bg-modifier-accent: rgba(79, 84, 92, 0.48);
    --text-faint: #80848e; --text-link: #00a8fc; --text-warning: #f0b232; --text-danger: #f23f43; --text-positive: #23a55a;
    --brand-text: var(--brand-primary);
}
.link-preview-description { color: #a6adc8 !important; }
[data-theme="light"] .form-group:not(.login-card .form-group) label { color: rgba(255, 255, 255, 0.7) !important; }
[data-theme="light"] .form-group:not(.login-card .form-group) input { color: #fff !important; background: rgba(255, 255, 255, 0.08) !important; }
`;
// And the words on what is drawn dark on every theme, which were the theme's, dark on dark.
const darkSurfaces = readFileSync(join(srcDir, 'styles', 'theme.css'), 'utf8').match(/:where\(\[data-theme="light"\]\) :is\(([^)]+)\)/)[1];
const OLD_DARK_SURFACES = `[data-theme="light"] :is(${darkSurfaces}) {
    --text-normal: #313338; --text-muted: #5c5e66; --text-faint: #80848e;
    --header-primary: #060607; --header-secondary: #4e5058;
    color: #313338;
}`;
// What was below the bar on every theme, as it was. Must fail, on the themes named.
const OLD_SHARED = `
.notes-undo .notes-textbtn, .notes-draw-btn.active, .link-preview-title { color: var(--brand-primary) !important; }
.notes-popover h4, .notes-labels-hint, .nick-edit-modal .settings-hint { color: var(--text-faint) !important; }
.link-preview-site { color: #6c7086 !important; }
.sched-btn.primary, .sched-seg button.on, .notes-update-strip-btn { background: var(--brand-primary) !important; }
.nick-edit-actions .save-btn { background: var(--brand-primary) !important; color: var(--bg-primary) !important; }
`;
// In the whole-app sweep, what is not drawn as the skeleton has it. Each one read and reasoned, in
// place of a filter that could hide the next real one. file:line is not used, as it would rot.
const NOT_AS_DRAWN = [
    ['member-role-badge', 'its background is the role\'s colour, set inline'],
    ['loading-spinner', 'on the page body or a sign-in card, both dark on every theme'],
    ['App.tsx', 'the connection error is on the page body, which is dark on every theme'],
    ['RoleSettingsModal.tsx', 'a sub-component of .role-modal, which is drawn dark: the skeleton has it apart from it'],
    ['device-stage-btn', 'inside .device-stage, which is drawn dark'],
    ['dsb-item', 'inside .dsb-menu, which is drawn dark'],
    ['scm-', 'inside .stream-context-menu, which is drawn dark'],
    ['notes-editor-backdrop', 'its words are the note editor inside it, which has its own surface'],
];

// ---- the real stylesheet ------------------------------------------------------------------------
const define = {
    'process.env.NODE_ENV': '"development"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","VITE_API_URL":""}',
    __APP_VERSION__: '"0.0.0"',
    __RC_ENABLED__: 'true',
};
const quiet = { '.png': 'empty', '.svg': 'empty', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.mp3': 'empty', '.wasm': 'empty', '.gif': 'empty', '.jpg': 'empty', '.webp': 'empty' };
// Vite's ?url, ?worker and ?inline imports: nothing of them runs or loads here, as in the app, where
// notes.css?inline is added only while Notes is open.
const viteSuffixes = {
    name: 'vite-suffixes',
    setup(on) {
        on.onResolve({ filter: /\?(url|worker|raw|inline)/ }, args => ({ path: args.path, namespace: 'nothing' }));
        on.onLoad({ filter: /.*/, namespace: 'nothing' }, () => ({ contents: 'export default ""', loader: 'js' }));
    },
};
const stylesheetOf = async (entry) => {
    const bundled = await build({
        entryPoints: [join(srcDir, entry)],
        bundle: true, write: false, outdir: workDir, format: 'esm', platform: 'browser', jsx: 'automatic',
        loader: quiet, define, logLevel: 'silent', plugins: [viteSuffixes],
    });
    return bundled.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
};
const appCss = await stylesheetOf('main.tsx');
const notesCss = await stylesheetOf('notes/main.tsx');
// The three a surface can be under: Púca, the Notes page, and Púca with Notes open in it
// (NotesDesktopView adds notes.css after the app's own).
const inlineNotes = (await build({
    entryPoints: [join(srcDir, 'notes', 'notes.css')], bundle: true, write: false, outdir: workDir, loader: quiet, logLevel: 'silent',
})).outputFiles.find(file => file.path.endsWith('.css')).text;
const STYLESHEETS = [['Púca', appCss], ['the Notes page', notesCss], ['Púca with Notes open', `${appCss}\n${inlineNotes}`]];
for (const needle of ['.cal-menu', '.nick-edit-modal', '.games-sheet', '.link-preview-card', '.device-stage-typetext']) {
    if (!appCss.includes(needle)) throw new Error(`the stylesheet has no ${needle}: main.tsx's imports did not reach it`);
}
for (const needle of ['.notes-selectbar', '.notes-undo', '.notes-popover', '.notes-update-strip']) {
    if (!notesCss.includes(needle)) throw new Error(`the Notes stylesheet has no ${needle}`);
}
const mounts = await build({
    entryPoints: [join(here, 'theme-surfaces', 'mounts.tsx')],
    bundle: true, write: false, outdir: workDir, format: 'iife', platform: 'browser', jsx: 'automatic',
    loader: quiet, define, logLevel: 'silent', plugins: [viteSuffixes],
});
const mountsJs = mounts.outputFiles.find(file => file.path.endsWith('.js')).text;
const mountsCss = mounts.outputFiles.find(file => file.path.endsWith('.css')).text;

// ---- what is on the page ------------------------------------------------------------------------
const { components, all } = readJsx(srcDir);
const instancesOf = (surface) => {
    if (surface.startsWith('<')) return all.filter(node => node.tag === surface.slice(1));
    return all.filter(node => node.intrinsic && node.classes.includes(surface.slice(1)));
};
const paintedBy = surface => (surface === '<Popover' ? '.notes-popover' : surface);
// Only ever on screen with Notes' own stylesheet, so Púca's alone says nothing about them.
const NOTES_ONLY = new Set(['.notes-selectbar', '.notes-undo', '.notes-card-select', '.notes-update-strip']);
// A rule of its own: naming it is not enough, as theme.css's list of dark surfaces does.
const hasRule = (sheet, cls) => new RegExp(`(^|\\n)\\s*\\${cls}\\s*[{,]`).test(sheet);
const drawnBy = (surface, name, sheet) => hasRule(sheet, paintedBy(surface)) && !(name === 'Púca' && NOTES_ONLY.has(surface));
const sectionsFor = (name, sheet) => {
    const sections = [];
    for (const surface of SURFACES) {
        const found = instancesOf(surface);
        if (!found.length) throw new Error(`${surface} is no longer in the source: a rename? This list has to follow it.`);
        if (!drawnBy(surface, name, sheet)) continue;
        for (const node of found) {
            for (const steady of [false, true]) {
                const html = toHtml(node, components, { steady });
                if (html) sections.push(`<section data-surface="${surface}" data-from="${node.at}" data-steady="${steady ? 1 : 0}">${html}</section>`);
            }
        }
    }
    return sections;
};
// Every component's own JSX, unnested: what a new surface would be caught by.
const sweep = [];
for (const node of Object.values(components).flat()) {
    // With its fixed classes, and with every class a branch can give it: .active is where a colour moves.
    for (const steady of [true, false]) {
        const html = toHtml(node, {}, { steady });
        if (html) sweep.push(`<section data-sweep="1" data-from="${node.at}">${html}</section>`);
    }
}
const stillness = '*,*::before,*::after{transition:none!important;animation:none!important}';
const pageWith = (name, body, sheet, script = '') => {
    const path = join(workDir, name);
    writeFileSync(path, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${sheet}</style><style id="old"></style><style>${stillness}</style></head><body>${body}<script>${script.replace(/<\/script>/g, '<\\/script>')}</script></body></html>`);
    return pathToFileURL(path).href;
};
// The chat's own container around them, whose words and paper they inherit in the app.
const inApp = inner => `<div id="root" class="chat-container" style="display:block;height:auto;min-height:0;color:var(--text-normal);background:var(--bg-primary)">${inner}</div>`;
const surfacesUrls = STYLESHEETS.map(([name, sheet], i) => [name, pageWith(`surfaces-${i}.html`, inApp(sectionsFor(name, sheet).join('\n')), sheet)]);
const sweepUrl = pageWith('sweep.html', inApp(sweep.join('\n')), STYLESHEETS[2][1]);
const mountsUrl = pageWith('mounts.html', '<div id="root"></div>', mountsCss, mountsJs);

// ---- reading it ---------------------------------------------------------------------------------
const pageReader = () => {
    const parts = (colour) => {
        let match = colour.match(/^rgba?\(([^)]+)\)$/);
        if (match) {
            const [r, g, b, a = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
            return [r, g, b, a];
        }
        match = colour.match(/^color\(srgb ([^)]+)\)$/);
        if (match) {
            const [r, g, b, a = 1] = match[1].split(/[ /]+/).filter(Boolean).map(Number);
            return [r * 255, g * 255, b * 255, a];
        }
        throw new Error(`a colour this cannot read: ${colour}`);
    };
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3]));
    const lum = ([r, g, b]) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const pageColour = () => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--bg-primary)';
        document.body.append(probe);
        const colour = parts(getComputedStyle(probe).backgroundColor);
        probe.remove();
        return colour;
    };
    const stopsOf = (image) => {
        if (!image.includes('gradient(')) return [];
        return (image.match(/rgba?\([^)]+\)|color\(srgb [^)]+\)/g) ?? []).map(parts);
    };
    // Translucent layers composited down to the first opaque one, or the theme's page behind it. A
    // gradient has no one colour behind the words, so each of its stops is an answer: this returns
    // them all, and the reading takes the worst. Skipping gradients once hid the card table's tile.
    const paints = (el, page) => {
        let stacks = [[]];
        for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
            const style = getComputedStyle(e);
            const stops = stopsOf(style.backgroundImage);
            if (stops.length) stacks = stacks.flatMap(stack => stops.map(stop => [...stack, stop]));
            const colour = parts(style.backgroundColor);
            if (colour[3] > 0) stacks = stacks.map(stack => [...stack, colour]);
            if (colour[3] >= 1 || (stops.length && stops.every(stop => stop[3] >= 1))) break;
        }
        return stacks.map((stack) => {
            let under = page.slice(0, 3);
            for (const layer of [...stack].reverse()) under = over(layer, under);
            return under;
        });
    };
    const paint = (el, page) => paints(el, page)[0];
    const hasWords = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    window.__measure = (root) => {
        const page = pageColour();
        const rows = [];
        const add = (el, kind, need) => {
            const colour = parts(getComputedStyle(el).color);
            const worst = paints(el, page)
                .map((under) => { const ink = over(colour, under); return { under, ink, value: ratio(ink, under) }; })
                .sort((a, b) => a.value - b.value)[0];
            rows.push({
                kind, need, at: el.getAttribute('data-at') || el.tagName, cls: String(el.className || '').slice(0, 60),
                ratio: Math.round(worst.value * 100) / 100,
                ink: worst.ink.map(Math.round).join(','), under: worst.under.map(Math.round).join(','),
            });
        };
        for (const el of [root, ...root.querySelectorAll('*')]) {
            if (el.hasAttribute('data-icon')) continue;
            if (el.tagName === 'OPTION' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
            if (el.matches(':disabled')) continue; // 1.4.3 and 1.4.11 exempt a control that cannot be used
            if (hasWords(el) || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) add(el, 'text', 4.5);
            else if (el.tagName === 'BUTTON' && el.querySelector(':scope > [data-icon], :scope > svg')) add(el, 'mark', 3);
        }
        return rows;
    };
    window.__look = ([theme, contrast]) => {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-contrast', contrast);
    };
    window.__old = (sheet) => { document.getElementById('old').textContent = sheet; };
    window.__measureSections = (attr) => [...document.querySelectorAll(`section[${attr}]`)].flatMap(section => (
        window.__measure(section).map(row => ({
            ...row, surface: section.getAttribute(attr), from: section.getAttribute('data-from'),
        }))
    ));
    window.__paper = el => paint(el, pageColour()).map(Math.round).join(',');
    // The text fields of a form with nothing to tell them from what they are on: neither their fill
    // nor a border of theirs is at `edge` against it. Words in them read fine all the same. The
    // skeleton keeps no `type`, and the app's checkboxes are the ones in a toggle row or a checkbox
    // label.
    window.__flatFields = (edge) => {
        const page = pageColour();
        const fields = [...document.querySelectorAll('.form-group input')]
            .filter(el => !el.closest('.login-card, .toggle-row, .checkbox-label') && !/^(checkbox|radio|file|hidden|range|color)$/.test(el.type));
        const flat = [];
        for (const el of fields) {
            const on = paint(el.parentElement, page);
            const fill = paint(el, page);
            const style = getComputedStyle(el);
            const border = parseFloat(style.borderTopWidth) > 0 ? over(parts(style.borderTopColor), on) : on;
            const value = Math.max(ratio(fill, on), ratio(border, on));
            if (value < edge) flat.push({ at: el.getAttribute('data-at') || el.tagName, fill: fill.map(Math.round).join(','), on: on.map(Math.round).join(','), ratio: Math.round(value * 100) / 100 });
        }
        return { fields: new Set(fields.map(el => el.getAttribute('data-at'))).size, flat };
    };
};

// ---- checks -------------------------------------------------------------------------------------
let pass = 0, fail = 0;
const check = (ok, label, extra = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`); };
const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const open = async (url, options = { viewport: { width: 1280, height: 800 } }) => {
    const context = await browser.newContext(options);
    await context.route(/^https?:/, route => route.abort()); // nothing here reaches out
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(pageReader);
    return { page, errors, close: () => context.close() };
};
const below = rows => rows.filter(row => row.ratio < row.need);
const describe = (row, looks) => `  ${row.ratio}:1 (needs ${row.need}) ${row.surface ?? ''} ${row.at} .${row.cls}  ink ${row.ink} on ${row.under}  [${looks.length} looks: ${[...new Set(looks)].slice(0, 4).join(' ')}]`;
const collect = (byLook) => {
    const lines = new Map();
    for (const [look, rows] of byLook) {
        for (const row of below(rows)) {
            const key = `${row.surface} ${row.at} .${row.cls}`;
            const line = lines.get(key) ?? { worst: row, looks: [] };
            line.looks.push(look);
            if (row.ratio < line.worst.ratio) line.worst = row;
            lines.set(key, line);
        }
    }
    return [...lines.values()].sort((a, b) => a.worst.ratio - b.worst.ratio);
};

// 1. Every surface, every look, both sizes, under each stylesheet.
for (const [name, options, sheetName, url] of [
    ['1280x800', { viewport: { width: 1280, height: 800 } }],
    ['390x844 touch', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
].flatMap(size => surfacesUrls.map(([sheetName, url]) => [...size, sheetName, url]))) {
    console.log(`\n${sheetName}, ${name}, all eight themes, with and without high contrast`);
    const { page, close } = await open(url, options);
    if (name.startsWith('390')) check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'CONTROL: this is a coarse pointer');
    const byLook = [];
    for (const look of LOOKS) {
        await page.evaluate(l => window.__look(l), look);
        byLook.push([look.join('/'), await page.evaluate(() => window.__measureSections('data-surface'))]);
    }
    const counted = byLook.reduce((sum, [, rows]) => sum + rows.length, 0);
    const seen = new Set(byLook[0][1].map(row => row.surface));
    const expected = SURFACES.filter(surface => drawnBy(surface, sheetName, STYLESHEETS.find(([n]) => n === sheetName)[1]));
    check(expected.every(surface => seen.has(surface)), `CONTROL: each of the ${expected.length} surfaces it draws has words or a control to read`, expected.filter(surface => !seen.has(surface)).join(' '));
    const poor = collect(byLook);
    for (const { worst, looks } of poor) console.log(describe(worst, looks));
    check(poor.length === 0, `every run of words 4.5:1 and every icon-only control 3:1, in ${counted} readings`, `${poor.length} below`);

    // 5. The controls, on the same page.
    if (name.startsWith('1280') && sheetName === 'Púca with Notes open') {
        await page.evaluate(sheet => window.__old(sheet), OLD_LIGHT + OLD_DARK_SURFACES);
        for (const contrast of CONTRASTS) {
            await page.evaluate(l => window.__look(l), ['light', contrast]);
            const rows = await page.evaluate(() => window.__measureSections('data-surface'));
            const failing = new Set(below(rows).map(row => row.surface));
            const held = SURFACES.filter(surface => !failing.has(surface));
            const worst = Math.min(...rows.map(row => row.ratio));
            check(held.length === 0, `CONTROL: Light's colours as they were fail on every surface (${contrast}), down to ${worst}:1`, held.length ? `these still pass: ${held.join(' ')}` : '');
        }
        await page.evaluate(sheet => window.__old(sheet), OLD_SHARED);
        for (const [theme, should] of [['dark', ['.notes-undo', '<Popover', '.link-preview-card', '.nick-edit-modal']], ['yellow', ['.sched-dialog', '.notes-update-strip']]]) {
            await page.evaluate(l => window.__look(l), [theme, 'normal']);
            const rows = await page.evaluate(() => window.__measureSections('data-surface'));
            const failing = new Set(below(rows).map(row => row.surface));
            const held = should.filter(surface => !failing.has(surface));
            check(held.length === 0, `CONTROL: the words raised on every theme, as they were, fail on ${theme}`, held.length ? `these still pass: ${held.join(' ')}` : `(${should.join(' ')})`);
        }
        await page.evaluate(() => window.__old(''));
    }
    await close();
}

// 2 and 3. Real components, and the screen.
{
    console.log('\nreal components, and what is on the screen');
    const { page, errors, close } = await open(mountsUrl);
    const names = await page.evaluate(() => window.__mountNames);
    const paperOf = async (name) => {
        const words = await page.evaluateHandle((surface) => {
            const root = document.querySelector(surface);
            const hasWords = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            for (const el of [root, ...root.querySelectorAll('*')]) {
                if (!hasWords(el)) continue;
                const box = el.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + 4, box.y + box.height / 2);
                if (box.width >= 8 && box.height >= 8 && hit && (hit === el || el.contains(hit))) return el;
            }
            return null;
        }, name);
        const el = words.asElement();
        if (!el) return null;
        const box = await el.boundingBox();
        const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.min(box.width, 240), height: box.height } });
        return page.evaluate(async (data) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0);
            const { data: px } = context.getImageData(0, 0, bitmap.width, bitmap.height);
            const counts = new Map();
            for (let i = 0; i < px.length; i += 4) {
                const key = `${px[i]},${px[i + 1]},${px[i + 2]}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            const paper = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            const lum = ([r, g, b]) => {
                const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
                return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
            };
            const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
            const on = paper.split(',').map(Number);
            let best = 1;
            for (const key of counts.keys()) best = Math.max(best, ratio(key.split(',').map(Number), on));
            return { paper, ink: Math.round(best * 100) / 100 };
        }, shot.toString('base64'));
    };
    const SCREEN_FLOOR = 3; // Antialiasing keeps small words' ink off their full colour; this catches
    // something lying over them, and the control below shows it does.
    const byLook = [];
    const screen = [];
    let unseen = [];
    const open_ = async (name) => {
        await page.mouse.move(0, 0); // nothing under the pointer: a hover has its own reading below
        await page.evaluate(n => window.__mount(n), name);
        if (name === '.notes-snooze-menu') {
            await page.locator('.notes-snooze button').first().click();
            await page.mouse.move(0, 0);
        }
        await page.waitForSelector(name, { timeout: 5000 });
    };
    for (const name of names) {
        await open_(name);
        for (const look of LOOKS) {
            await page.evaluate(l => window.__look(l), look);
            const rows = await page.evaluate(n => window.__measure(document.querySelector(n)).map(row => ({ ...row, surface: n })), name);
            byLook.push([look.join('/'), rows]);
            const read = await paperOf(name);
            if (!read) { unseen.push(`${name} ${look.join('/')}`); continue; }
            screen.push({ name, look: look.join('/'), ...read });
        }
        if (outDir) {
            await page.evaluate(l => window.__look(l), ['light', 'normal']);
            await page.screenshot({ path: join(outDir, `after-light${name.replace(/[^a-z-]/g, '-')}.png`) });
            await page.evaluate(sheet => window.__old(sheet), OLD_LIGHT + OLD_DARK_SURFACES);
            await page.screenshot({ path: join(outDir, `before-light${name.replace(/[^a-z-]/g, '-')}.png`) });
            await page.evaluate(() => window.__old(''));
            await page.evaluate(l => window.__look(l), ['yellow', 'normal']);
            await page.screenshot({ path: join(outDir, `after-yellow${name.replace(/[^a-z-]/g, '-')}.png`) });
        }
    }
    // The lowest reading on each, on Light as it was and as it is, and on any look: what a report quotes.
    if (outDir) {
        const figures = {};
        for (const name of names) {
            await open_(name);
            await page.evaluate(l => window.__look(l), ['light', 'normal']);
            const low = () => page.evaluate(n => Math.min(...window.__measure(document.querySelector(n)).filter(row => row.kind === 'text').map(row => row.ratio)), name);
            const now = await low();
            await page.evaluate(sheet => window.__old(sheet), OLD_LIGHT + OLD_DARK_SURFACES);
            const was = await low();
            await page.evaluate(() => window.__old(''));
            const any = Math.min(...byLook.flatMap(([, rows]) => rows).filter(row => row.surface === name && row.kind === 'text').map(row => row.ratio));
            figures[name] = { lightBefore: was, lightAfter: now, lowestOnAnyLook: any };
        }
        writeFileSync(join(outDir, 'figures.json'), JSON.stringify(figures, null, 2));
    }
    const poor = collect(byLook);
    for (const { worst, looks } of poor) console.log(describe(worst, looks));
    check(poor.length === 0, `the real ${names.length} (${names.join(' ')}) hold the same bar on every look, in ${byLook.reduce((sum, [, rows]) => sum + rows.length, 0)} readings`, `${poor.length} below`);
    check(unseen.length === 0, 'each real surface\'s words are on the screen and what is hit there', unseen.slice(0, 6).join('; '));
    const dim = screen.filter(read => read.ink < SCREEN_FLOOR);
    check(dim.length === 0, `on the screen, ink against paper at ${SCREEN_FLOOR}:1 or better, in ${screen.length} screenshots`, dim.slice(0, 6).map(read => `${read.name} ${read.look} ${read.ink}:1 on ${read.paper}`).join('; '));

    // A card under the pointer is a colour of its own, and the words stay on it.
    await open_('.link-preview-card');
    await page.hover('.link-preview-card');
    const hovered = [];
    for (const look of LOOKS) {
        await page.evaluate(l => window.__look(l), look);
        hovered.push([look.join('/'), await page.evaluate(() => window.__measure(document.querySelector('.link-preview-card')).map(row => ({ ...row, surface: 'hovered card' })))]);
    }
    const poorHover = collect(hovered);
    for (const { worst, looks } of poorHover) console.log(describe(worst, looks));
    check(poorHover.length === 0, 'a link card under the pointer holds the bar on every look', `${poorHover.length} below`);
    await page.mouse.move(0, 0);

    // The same screen with the old colours has to read as unreadable.
    await page.evaluate(sheet => window.__old(sheet), OLD_LIGHT);
    await page.evaluate(l => window.__look(l), ['light', 'normal']);
    await open_('.notes-undo');
    const before = await paperOf('.notes-undo');
    check(before && before.ink < SCREEN_FLOOR, 'CONTROL: on the screen, Light as it was reads as unreadable', before ? `${before.ink}:1 on ${before.paper}` : 'nothing read');
    await page.evaluate(() => window.__old(''));

    // The skeleton and the real thing paint the same surface, or (1) measured something else.
    const skeleton = await open(surfacesUrls[2][1]);
    const differ = [];
    for (const look of LOOKS) {
        await skeleton.page.evaluate(l => window.__look(l), look);
        await page.evaluate(l => window.__look(l), look);
        for (const name of names) {
            if (name === '.device-stage-typetext') continue; // the real one sits in .device-stage below
            await open_(name);
            const real = await page.evaluate(n => window.__paper(document.querySelector(n)), name);
            const drawn = await skeleton.page.evaluate(n => window.__paper(document.querySelector(`section ${n}`)), name);
            if (real !== drawn) differ.push(`${name} ${look.join('/')} real ${real} skeleton ${drawn}`);
        }
    }
    check(differ.length === 0, 'the skeleton paints each surface as the real component does, on every look', differ.slice(0, 6).join('; '));
    await skeleton.close();
    check(errors.length === 0, 'and no page error', errors.slice(0, 3).join('; '));
    await close();
}

// 4. Every component, on Light.
{
    console.log('\nevery component in the app, on Light');
    const { page, close } = await open(sweepUrl);
    const read = async (theme) => {
        await page.evaluate(l => window.__look(l), [theme, 'normal']);
        return page.evaluate(() => window.__measureSections('data-sweep'));
    };
    const dark = await read('dark');
    const light = await read('light');
    const worse = (rows) => rows.filter((row, i) => row.ratio < 3 && dark[i].ratio >= dark[i].need);
    const used = new Set();
    const explained = (row) => {
        const entry = NOT_AS_DRAWN.find(([name]) => `${row.at} ${row.cls}`.includes(name));
        if (entry) used.add(entry[0]);
        return !!entry;
    };
    const found = worse(light).filter(row => !explained(row));
    const stale = NOT_AS_DRAWN.filter(([name]) => !used.has(name)).map(([name]) => name);
    check(stale.length === 0, 'and every entry of that list still explains something', stale.join(' '));
    const distinct = new Map(found.map(row => [`${row.at} .${row.cls}`, row]));
    for (const row of distinct.values()) console.log(describe(row, ['light/normal']));
    check(distinct.size === 0, `no word on Light under 3:1 that the dark theme holds, in ${light.length} readings of ${sweep.length} blocks of the app's JSX (past ${NOT_AS_DRAWN.length} explained)`, `${distinct.size} found`);
    await page.evaluate(sheet => window.__old(sheet), OLD_LIGHT + OLD_DARK_SURFACES);
    const old = worse(await read('light')).filter(row => !explained(row));
    check(new Set(old.map(row => row.at)).size >= 40, 'CONTROL: the sweep finds Light as it was', `${new Set(old.map(row => row.at)).size} places, down to ${Math.min(...old.map(row => row.ratio))}:1`);
    await close();
}

// 6. What a reading of words cannot see.
{
    console.log('\nfields in a form');
    // A field the colour of the pane it is on has no edge at all, and its words read fine on the
    // pane: Server Settings' Server Name was plain words on Light until it was pressed.
    const EDGE = 1.05;
    const { page, close } = await open(sweepUrl);
    const fieldsOn = async (look) => {
        await page.evaluate(l => window.__look(l), look);
        return page.evaluate(edge => window.__flatFields(edge), EDGE);
    };
    for (const contrast of CONTRASTS) {
        const { fields, flat } = await fieldsOn(['light', contrast]);
        check(fields >= 5 && flat.length === 0, `on Light (${contrast}) each of the ${fields} text fields in a form stands apart from what it is on, at ${EDGE}:1 or more`,
            flat.slice(0, 6).map(f => `${f.at} ${f.fill} on ${f.on} ${f.ratio}:1`).join('; '));
    }
    // The field colour this sheet first gave them: the pane's own in Server Settings.
    await page.evaluate(sheet => window.__old(sheet), '[data-theme="light"] .form-group:not(.login-card .form-group) input { background: var(--input-bg) !important; }');
    const flatThen = (await fieldsOn(['light', 'normal'])).flat;
    check(flatThen.some(f => f.at.startsWith('components/ServerSettingsModal.tsx')), 'CONTROL: with --input-bg, Server Settings\' fields are flat on their pane', flatThen.slice(0, 3).map(f => `${f.at} ${f.ratio}:1`).join('; '));
    await page.evaluate(() => window.__old(''));
    await close();
}

// The file of Light's rules cannot reach another theme.
{
    const lightSheet = readFileSync(join(srcDir, 'styles', 'lightTheme.css'), 'utf8');
    const strays = lightSheet.replace(/\/\*[\s\S]*?\*\//g, '').split('}').flatMap(rule => rule.split('{')[0].split(','))
        .map(selector => selector.trim()).filter(Boolean).filter(selector => !selector.startsWith('[data-theme="light"]'));
    check(strays.length === 0, 'every selector in styles/lightTheme.css starts at [data-theme="light"]', strays.join(' | '));
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
