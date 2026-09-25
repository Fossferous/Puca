// Púca Notes — the LABEL PAGER section of the live walk: "All notes" and then
// one page per label, a tab strip above them, swiped (phone) or tabbed and
// flicked (desktop) between (components/NotesPager.tsx). notes-walk.mjs calls
// pagerWalk() in its "Label pager (swipe between lists)" section; it also runs
// on its own, below.
//
// What it proves, against the built bundle and a real backend:
//   desktop — the strip lists All + every label in the RAIL's order; a tab
//     click moves the pager to that page (scrollLeft = index * width) and the
//     route to /label/<name>; the list being LEFT keeps its notes while the
//     pager slides (sampled every frame of the slide); Left/Right on the strip
//     and the rail move it too; a deep link — to a label whose name needs
//     URI-encoding — LANDS on its page, every frame from the first; a search
//     hides the strip and the pager (the negative control: the same selectors
//     that must be absent here are present everywhere else) and clearing it
//     brings them back; Archive is not a page; a trackpad flick while
//     "Take a note…" holds a draft does not throw the draft away; every
//     tab's aria-controls names its own tabpanel, a label with spaces
//     included; a note opened before a swipe settles is still open after the
//     settle; and at a FRACTIONAL pager width whose clientWidth rounds up
//     (125% scaling), resting on any page holds exactly one grid.
//   phone (390 wide, coarse, touch) — the DOCUMENT never scrolls sideways;
//     every tab is a 44px target; scrolling the pager one page along moves
//     the active tab AND the route (with scrollend, and again with scrollend
//     suppressed, the way an older WebView behaves); a list swiped away from
//     and back to opens where it was being read; a REAL touch swipe (CDP
//     touch events, not scrollLeft) moves one list along and the incoming
//     list has its notes while the finger is still down; dragging a card by
//     its grip never moves the pager; a vertical swipe scrolls the page, not
//     the pager and not the main column.
//   Pixel-class phone (411.43 px at DPR 2.625, clientWidth rounds down) —
//     resting on any page holds exactly one grid.
//
// Every check is ck(): a precondition that did not happen is a FAIL line,
// never a silent pass.
//
// Standalone: node e2e/notes-walk-pager.mjs [outdir] [baseURL]
//   (registers its own user; launches a muted, headless browser)
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The route a label page IS — the same encoding the rail and the chips use. */
const labelHash = name => `#/label/${encodeURIComponent(name)}`;

/** Seed: a note with one item, through the inline composer (desktop). */
async function makeNote(page, title, item) {
    await page.click('.notes-quickadd-collapsed');
    await page.waitForFunction(() => document.activeElement?.closest('.notes-quickadd-item') != null, null, { timeout: 5000 }).catch(() => {});
    await page.fill('.notes-quickadd-title', title);
    await page.locator('.notes-quickadd-item input').first().fill(item);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForFunction(t => [...document.querySelectorAll('.notes-card-title')].some(e => e.textContent.trim() === t), title, { timeout: 15000 });
}

/** Seed: give the note titled `title` the label `name` (made if new). */
async function labelNote(page, title, name) {
    // The active page when there is a pager, the one grid when there is not
    // (a fresh account has no labels, so no pages, until the first one).
    await page.locator('.notes-page.active .notes-card, .notes-main:not(.pager) .notes-card', { hasText: title }).first().click();
    await page.waitForSelector('.notes-editor-foot', { timeout: 10000 });
    await page.click('.notes-editor-foot button[aria-label="Labels"]');
    await page.waitForSelector('.notes-labels-new input', { timeout: 5000 });
    await page.fill('.notes-labels-new input', name);
    await page.press('.notes-labels-new input', 'Enter');
    await sleep(250);
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.locator('.notes-editor-foot').getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 });
    await sleep(250);
}

/** Everything a check needs about the pager, in one read. `w` is the TRUE
 *  width (a page is exactly that wide); `cw`, clientWidth, is rounded to a
 *  whole pixel and drifts from the page offsets by the fraction per page. */
const pagerState = pg => pg.evaluate(() => {
    const p = document.querySelector('.notes-pager');
    const tabs = [...document.querySelectorAll('.notes-pages-tabs [role="tab"]')];
    const active = document.querySelector('.notes-page.active');
    return {
        strip: !!document.querySelector('.notes-pages-tabs[role="tablist"]'),
        pager: !!p,
        sl: p ? p.scrollLeft : null,
        w: p ? p.getBoundingClientRect().width : null,
        cw: p ? p.clientWidth : null,
        hash: location.hash,
        tabs: tabs.map(t => t.textContent.trim()),
        selected: tabs.filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.textContent.trim()),
        activeLabel: active?.getAttribute('aria-label') ?? null,
        activeRole: active?.getAttribute('role') ?? null,
        activeCards: active ? [...active.querySelectorAll('.notes-card-title')].map(e => e.textContent.trim()) : [],
        live: document.querySelectorAll('.notes-page.live').length,
    };
});

/** The label names in the rail, in its order: the items between the Labels
 *  heading and the next heading ("More"). */
const railLabels = pg => pg.evaluate(() => {
    const out = [];
    let inLabels = false;
    for (const el of document.querySelectorAll('nav.notes-rail > *')) {
        if (el.classList.contains('notes-rail-section')) { inLabels = /^labels/i.test(el.textContent.trim()); continue; }
        if (inLabels && el.classList.contains('notes-rail-item')) out.push(el.querySelector('.notes-rail-label')?.textContent.trim() ?? '');
    }
    return out;
});

/** Wait until the pager rests on page `i` of `hash` (or time out, and let the
 *  check that follows say what it saw instead). */
const settledOn = (pg, i, hash, timeout = 5000) => pg.waitForFunction(({ i, hash }) => {
    const p = document.querySelector('.notes-pager');
    return !!p && location.hash === hash && Math.abs(p.scrollLeft - i * p.getBoundingClientRect().width) <= 2
        && document.querySelectorAll('.notes-page.live').length === 1;
}, { i, hash }, { timeout }).then(() => true, () => false);

/**
 * Make the pager's width FRACTIONAL, the way a real device does and a
 * Playwright viewport (whole CSS pixels) cannot: a Pixel-class phone is
 * 1080 px at DPR 2.625 = 411.43 CSS px, a desktop at 125% scaling is 1296 px
 * = 1036.8. `margin-right` takes that fraction off the pager and nothing
 * else; the pages (100% of it) follow. `null` puts it back.
 */
const fractionalWidth = (pg, px) => pg.evaluate(px => {
    let st = document.getElementById('walk-fractional-pager');
    if (px === null) { st?.remove(); return; }
    if (!st) { st = document.createElement('style'); st.id = 'walk-fractional-pager'; document.head.appendChild(st); }
    st.textContent = `.notes-pager { margin-right: ${px}px !important; }`;
}, px);

/**
 * Rest on every page after All, reached by its ROUTE (what the rail and a deep
 * link do), and say at each stop which pages hold a grid. At a fractional
 * width a page's offset is index × the TRUE width; measured against the
 * rounded clientWidth the error grows by the fraction on every page, and from
 * the third or fourth page on a neighbour reads as on screen at rest (the
 * first cut: onScreen 4:5 on page 4 at 411.43 px).
 */
async function restOnEveryPage(pg, tabs) {
    const stops = [];
    for (let i = 1; i < tabs.length; i++) {
        const h = labelHash(tabs[i]);
        await pg.evaluate(h => { location.hash = h; }, h);
        const arrived = await pg.waitForFunction(({ i, h }) => {
            const p = document.querySelector('.notes-pager');
            return !!p && location.hash === h && Math.abs(p.scrollLeft - i * p.getBoundingClientRect().width) <= 2;
        }, { i, h }, { timeout: 5000 }).then(() => true, () => false);
        await sleep(800);   // past every settle timer (the longest is 600 ms)
        stops.push({
            i, arrived, ...await pg.evaluate(() => {
                const p = document.querySelector('.notes-pager');
                return {
                    at: document.querySelector('.notes-page.active')?.dataset.page ?? null,
                    live: [...document.querySelectorAll('.notes-page.live')].map(e => e.dataset.page),
                    sl: p.scrollLeft, w: p.getBoundingClientRect().width, cw: p.clientWidth,
                };
            }),
        });
    }
    return stops;
}
/** One grid at rest, and it is the page the route names. */
const oneGridAtRest = x => x.arrived && x.live.length === 1 && x.live[0] === x.at;

/**
 * @param {object} o
 * @param {import('@playwright/test').Browser} o.browser
 * @param {string} o.baseURL
 * @param {object} o.state  storageState of a signed-in context
 * @param {(n: string, ok: boolean, detail?: unknown) => void} o.ck
 * @param {(page: import('@playwright/test').Page) => void} o.watch
 * @param {(page: import('@playwright/test').Page) => (name: string) => Promise<void>} o.shotOf
 * @param {string[]} o.errors
 */
export async function pagerWalk({ browser, baseURL, state, ck, watch, shotOf, errors }) {
    const errorsAtStart = errors.length;
    // Labels of our own, so the section never depends on what earlier
    // sections left behind: one plain, one whose address needs encoding (and
    // whose page key has spaces), and three that sort after L1 — so there is
    // always a list after L1 to move to, and at least six pages, which the
    // fractional-width checks need: the rounding error grows by under half a
    // pixel per page, the 1 px slack absorbs the first two or three, and a
    // neighbour can only be wrongly mounted if it exists.
    const L1 = 'Pager lists';
    const L2 = 'Pager & co';
    const L3 = ['Pager zeta', 'Pager zeta 2', 'Pager zeta 3'];
    const L1_NOTES = ['Pager note 1', 'Pager note 2', 'Pager note 3', 'Pager note 4', 'Pager note 5'];
    // Shared by both halves; a half that throws is ONE FAIL line ("ran to the
    // end"), and the other half still runs.
    let s = null;
    let ok = false;
    let idx1 = -1;
    let idx2 = -1;
    let TABS = [];

    // =========================================================================
    // Desktop
    // =========================================================================
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL, storageState: state });
    const page = await ctx.newPage();
    watch(page);
    const shot = shotOf(page);
    try {
        await page.goto('/notes/');
        await page.waitForSelector('.notes-card', { timeout: 20000 });
        for (const t of L1_NOTES) await makeNote(page, t, `row of ${t}`);
        await makeNote(page, 'Pager extra', 'the & page');
        for (const t of L1_NOTES) await labelNote(page, t, L1);
        await labelNote(page, 'Pager extra', L2);
        for (let i = 0; i < L3.length; i++) await labelNote(page, L1_NOTES[4 - i], L3[i]);

        // ---- the strip ------------------------------------------------------------
        await page.waitForFunction(names => names.every(n => [...document.querySelectorAll('.notes-pages-tab')].some(t => t.textContent.trim() === n)),
            [L1, L2, ...L3], { timeout: 10000 }).catch(() => {});
        const rail = await railLabels(page);
        s = await pagerState(page);
        ck('pager: the rail lists the five new labels (precondition)', [L1, L2, ...L3].every(l => rail.includes(l)), JSON.stringify(rail));
        ck('pager: the strip is All notes, then every label in the rail\'s order',
            s.strip && JSON.stringify(s.tabs) === JSON.stringify(['All notes', ...rail]), JSON.stringify({ tabs: s.tabs, rail }));
        ck('pager: on / the one selected tab is All notes, and only one page holds a grid',
            s.hash === '#/' && JSON.stringify(s.selected) === '["All notes"]' && s.live === 1 && s.activeRole === 'tabpanel',
            JSON.stringify({ hash: s.hash, selected: s.selected, live: s.live }));
        idx1 = s.tabs.indexOf(L1);
        idx2 = s.tabs.indexOf(L2);
        TABS = s.tabs;

        // ---- tab ↔ panel: every aria-controls names ONE panel that exists -----------
        // aria-controls is a space-separated LIST of ids. The first cut built
        // the ids from the page key, which keeps a label's spaces, so the L2
        // tab pointed at 'notes-page-panel-label:pager', '&' and 'co' — none
        // of which exists (and an id may not contain whitespace at all).
        const links = await page.evaluate(() => [...document.querySelectorAll('.notes-pages-tab')].map(t => {
            const ac = t.getAttribute('aria-controls') ?? '';
            const panel = ac ? document.getElementById(ac) : null;
            return { tab: t.textContent.trim(), id: t.id, ac, role: panel?.getAttribute('role') ?? null, panel: panel?.getAttribute('aria-label') ?? null };
        }));
        const badLinks = links.filter(x => !x.id || /\s/.test(x.id) || !x.ac || /\s/.test(x.ac) || x.role !== 'tabpanel' || x.panel !== x.tab);
        ck('pager: every tab\'s aria-controls names its own tabpanel — one id, no whitespace — a label with spaces included',
            links.some(x => x.tab === L2) && links.length === s.tabs.length && badLinks.length === 0
            && new Set(links.map(x => x.id)).size === links.length,
            JSON.stringify(badLinks.length ? badLinks.slice(0, 3) : links.filter(x => x.tab === L2)));

        // ---- a tab click: sampled on EVERY frame of the slide -----------------------
        // The page being left must keep its notes while it slides out. (The first
        // cut emptied it the moment the route moved, so a tap showed a blank page
        // sliding away.) A slide with no frame in between is a FAIL, not a pass.
        const slide = await page.evaluate(async label => {
            const tab = [...document.querySelectorAll('.notes-pages-tab')].find(t => t.textContent.trim() === label);
            const pager = document.querySelector('.notes-pager');
            const from = document.querySelector('.notes-page.active')?.dataset.page;
            if (!tab || !pager || !from) return { from: null, samples: [] };
            tab.click();
            const samples = [];
            const t0 = performance.now();
            await new Promise(done => {
                const step = () => {
                    const leaving = document.querySelector(`.notes-page[data-page="${CSS.escape(from)}"]`);
                    const arriving = document.querySelector('.notes-page.active');
                    samples.push({
                        sl: pager.scrollLeft, w: pager.getBoundingClientRect().width,
                        leaving: leaving ? leaving.querySelectorAll('.notes-card').length : -1,
                        arriving: arriving ? arriving.querySelectorAll('.notes-card').length : -1,
                    });
                    if (performance.now() - t0 > 1500) done(); else requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            });
            return { from, samples };
        }, L1);
        // From All (page 0): the frames where it is still partly on screen are
        // those with 0 < scrollLeft < width. A page further along that scrolls
        // past on the way is mounted as it comes into view, one frame behind at
        // most; the page being LEFT has no such excuse.
        const mid = slide.samples.filter(x => x.sl > 2 && x.sl < idx1 * x.w - 2);
        const leavingShown = mid.filter(x => x.sl < x.w - 1);
        ck('pager: a tab click SLIDES (frames with the page being left still on screen were seen)', leavingShown.length > 0,
            `${leavingShown.length} such frame(s), ${mid.length} mid-slide of ${slide.samples.length}`);
        ck('pager: the list being left keeps its notes for as long as any of it shows — no blank page sliding away',
            leavingShown.length > 0 && leavingShown.every(x => x.leaving > 0), JSON.stringify(leavingShown.slice(0, 4)));
        ck('pager: …and the list arriving has its notes in every frame of the slide',
            mid.length > 0 && mid.every(x => x.arriving > 0), JSON.stringify(mid.filter(x => x.arriving <= 0).slice(0, 3)));
        ok = await settledOn(page, idx1, labelHash(L1));
        s = await pagerState(page);
        ck('pager: a tab click lands the pager on that label (scrollLeft = index × width)',
            ok && Math.abs(s.sl - idx1 * s.w) <= 2, JSON.stringify({ sl: s.sl, w: s.w, idx1 }));
        ck('pager: …and the route is /label/<name>', s.hash === labelHash(L1), s.hash);
        ck('pager: …the tab is selected and the visible page is that label, holding exactly its notes',
            JSON.stringify(s.selected) === JSON.stringify([L1]) && s.activeLabel === L1
            && s.activeCards.length === L1_NOTES.length && L1_NOTES.every(t => s.activeCards.includes(t)) && s.live === 1,
            JSON.stringify({ selected: s.selected, activeLabel: s.activeLabel, cards: s.activeCards, live: s.live }));
        await shot('pager-desktop-label');

        // ---- a settle moves the PAGE, never closes an open note -------------------------
        // A card clicked while a flick is still snapping opens its note
        // (…?note=KEY, pushed) BEFORE the scroll settles, and the settle then
        // replaces the route with the page it landed on. The first cut replaced
        // it with the bare label address: the note param went and the editor
        // closed by itself. Made deterministic, and as tight as it gets: the
        // click and the end of the snap in ONE task, so the settle lands before
        // React has even rendered the navigation (it runs in a transition). A
        // settle that copied the RENDER's query lost the note here too (12 of
        // 12 in a probe); only the history's own query survives it.
        const nTo = idx1 + 1;
        const nHash = nTo < TABS.length ? labelHash(TABS[nTo]) : null;
        // From an IDLE page, which is what a hand gets: measured against the
        // render-query settle, a click 1.5 s after the pager last moved lost
        // the note 3 times of 3, one straight after it kept it 3 times of 3.
        await sleep(1500);
        const opened = await page.evaluate(({ title, i }) => {
            const card = [...document.querySelectorAll('.notes-page.active .notes-card')]
                .find(c => c.querySelector('.notes-card-title')?.textContent.trim() === title);
            const p = document.querySelector('.notes-pager');
            if (!card || !p) return { hash: null };
            card.click();                                   // openNote: pushed now
            const hash = location.hash;
            p.scrollTo({ left: i * p.getBoundingClientRect().width, behavior: 'instant' });   // the snap ends
            return { hash };
        }, { title: L1_NOTES[0], i: nTo });
        const moved = nHash !== null && await page.waitForFunction(h => location.hash.split('?')[0] === h, nHash, { timeout: 5000 }).then(() => true, () => false);
        await page.waitForSelector('.notes-editor-foot', { timeout: 5000 }).catch(() => {});
        await sleep(400);
        const afterSettle = await page.evaluate(() => ({ hash: location.hash, editor: !!document.querySelector('.notes-editor') }));
        const q = opened.hash?.includes('?') ? opened.hash.slice(opened.hash.indexOf('?')) : '';
        ck('pager: a note opened as a swipe settles is still open after it — the settle moves the page, and keeps ?note=',
            opened.hash === `${labelHash(L1)}${q}` && /[?&]note=/.test(q) && moved && afterSettle.editor && afterSettle.hash === `${nHash}${q}`,
            JSON.stringify({ opened, moved, afterSettle }));
        if (afterSettle.editor) {
            await page.locator('.notes-editor-foot').getByRole('button', { name: 'Close', exact: true }).click();
            await page.waitForSelector('.notes-editor', { state: 'detached', timeout: 5000 }).catch(() => {});
        }
        await page.locator('.notes-pages-tab', { hasText: L1 }).first().click();
        ok = await settledOn(page, idx1, labelHash(L1));
        ck('pager: …and a tab click takes it back to the list it came from (precondition for what follows)', ok, (await pagerState(page)).hash);

        // ---- the keyboard on the strip, and the rail ----------------------------------
        await page.locator('.notes-pages-tab[aria-selected="true"]').focus({ timeout: 5000 });
        const kTo = idx1 + 1 < s.tabs.length ? idx1 + 1 : idx1 - 1;
        await page.keyboard.press(kTo > idx1 ? 'ArrowRight' : 'ArrowLeft');
        const kHash = kTo === 0 ? '#/' : labelHash(s.tabs[kTo]);
        ok = await settledOn(page, kTo, kHash);
        s = await pagerState(page);
        ck('pager: Left/Right on the strip moves to the next list (route and pager)', ok && JSON.stringify(s.selected) === JSON.stringify([s.tabs[kTo]]),
            JSON.stringify({ hash: s.hash, want: kHash, selected: s.selected }));
        await page.locator('.notes-rail-item', { hasText: L2 }).click();
        ok = await settledOn(page, idx2, labelHash(L2));
        s = await pagerState(page);
        ck('pager: the rail still navigates, and moves the pager with it', ok && s.activeLabel === L2 && s.activeCards.join() === 'Pager extra',
            JSON.stringify({ hash: s.hash, activeLabel: s.activeLabel, cards: s.activeCards }));

        // ---- a deep link LANDS (every frame from the first shows the page) -----------
        await page.addInitScript(() => {
            const t0 = performance.now();
            window.__pagerFrames = [];
            const step = () => {
                const p = document.querySelector('.notes-pager');
                if (p) window.__pagerFrames.push({ sl: p.scrollLeft, w: p.getBoundingClientRect().width });
                if (performance.now() - t0 < 6000) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
        await page.goto('about:blank');
        await page.goto(`/notes/${labelHash(L2)}`);
        await page.waitForSelector('.notes-pager', { timeout: 20000 }).catch(() => {});
        await sleep(1200);
        const frames = await page.evaluate(() => window.__pagerFrames || []);
        s = await pagerState(page);
        ck('pager: a deep link to /label/<encoded name> lands on that page, with no animation — every frame from the first',
            frames.length > 0 && frames.every(f => Math.abs(f.sl - idx2 * f.w) <= 2) && s.activeLabel === L2,
            JSON.stringify({ first: frames.slice(0, 3), frames: frames.length, idx2, activeLabel: s.activeLabel }));
        ck('pager: …with its tab selected', JSON.stringify(s.selected) === JSON.stringify([L2]), JSON.stringify(s.selected));

        // ---- a search is not a page (the negative control), and clearing it is -------
        await page.fill('.notes-search input', 'Pager');
        await page.waitForSelector('.notes-pages-tabs', { state: 'detached', timeout: 5000 }).catch(() => {});
        s = await pagerState(page);
        const results = await page.locator('h1.notes-section-title', { hasText: 'Results for' }).count();
        ck('pager: typing a search hides the strip and the pager (the search results are not a page)',
            !s.strip && !s.pager && results === 1 && await page.locator('.notes-card').count() >= L1_NOTES.length,
            JSON.stringify({ strip: s.strip, pager: s.pager, results }));
        await page.fill('.notes-search input', '');
        await page.waitForSelector('.notes-pages-tabs', { timeout: 5000 }).catch(() => {});
        ok = await settledOn(page, idx2, labelHash(L2));
        s = await pagerState(page);
        ck('pager: clearing the search brings the strip and the pager back, on the same list', s.strip && s.pager && ok && s.activeLabel === L2,
            JSON.stringify({ strip: s.strip, pager: s.pager, hash: s.hash, activeLabel: s.activeLabel }));
        await page.locator('.notes-rail-item', { hasText: 'Archive' }).click();
        // The hash moves before React renders: wait for the ARCHIVE heading, not
        // just any heading (the label page has one too).
        await page.waitForFunction(() => /archive/i.test(document.querySelector('h1.notes-section-title')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
        s = await pagerState(page);
        ck('pager: Archive is not a page — no strip, no pager', s.hash === '#/archive' && !s.strip && !s.pager, JSON.stringify({ hash: s.hash, strip: s.strip }));
        await page.locator('.notes-rail-item', { hasText: 'Notes' }).first().click();
        ok = await settledOn(page, 0, '#/');
        ck('pager: back on All notes from the rail', ok, (await pagerState(page)).hash);

        // ---- a trackpad flick must not throw a draft away ------------------------------
        // Nothing is clicked, so the composer's save-on-click-outside never runs;
        // unmounting All with it would lose what was typed.
        await page.click('.notes-quickadd-collapsed');
        await page.waitForFunction(() => document.activeElement?.closest('.notes-quickadd-item') != null, null, { timeout: 5000 }).catch(() => {});
        await page.keyboard.type('Pager draft kept');
        const draft = () => page.evaluate(() => [...document.querySelectorAll('.notes-quickadd input')].some(i => i.value === 'Pager draft kept'));
        const typed = await draft();
        const box = await page.locator('.notes-pager').boundingBox({ timeout: 5000 });
        await page.mouse.move(box.x + box.width / 2, box.y + box.height - 60);
        await page.mouse.wheel(box.width, 0);
        const flickedTo = await page.waitForFunction(() => location.hash !== '#/', null, { timeout: 5000 }).then(() => page.evaluate(() => location.hash), () => null);
        await sleep(400);
        const keptAway = await draft();
        await page.mouse.wheel(-box.width, 0);
        await page.waitForFunction(() => location.hash === '#/', null, { timeout: 5000 }).catch(() => {});
        await sleep(400);
        const keptBack = await draft();
        ck('pager: a sideways trackpad flick moves to the next list (precondition: the draft was typed)', typed && flickedTo === labelHash(TABS[1]),
            JSON.stringify({ typed, flickedTo }));
        ck('pager: …and the half-typed note in "Take a note…" survives the flick, there and back', typed && keptAway && keptBack,
            JSON.stringify({ keptAway, keptBack }));
        await page.keyboard.press('Escape');   // the composer saves what it holds
        await page.waitForSelector('.notes-quickadd-collapsed', { timeout: 10000 }).catch(() => {});

        // ---- a fractional width (125% scaling): one grid at rest, on every page --------
        // clientWidth rounding UP (1039.6 reads 1040): the PREVIOUS list then
        // counts as on screen at rest — and it comes before the active page in
        // the DOM, so Tab from the strip walked into a list nobody could see.
        // (Rounding DOWN is the Pixel-class phone below.) Measured on the first
        // cut: page 3 held 'pager lists' AND 'pager zeta'.
        await page.evaluate(() => { location.hash = '#/'; });
        await settledOn(page, 0, '#/');
        await fractionalWidth(page, 0.4);
        await sleep(300);
        const f = await pagerState(page);
        const stops = await restOnEveryPage(page, TABS);
        ck("pager: at a fractional width whose clientWidth rounds UP, resting on any page holds ONE grid — that page's",
            f.w % 1 !== 0 && f.cw > f.w && stops.length >= 3 && stops.every(oneGridAtRest),
            JSON.stringify({ w: f.w, cw: f.cw, pages: stops.length, bad: stops.filter(x => !oneGridAtRest(x)) }));
        await fractionalWidth(page, null);
    } catch (e) {
        ck('pager: the desktop half ran to the end', false, String(e).split('\n')[0]);
    } finally {
        await ctx.close();
    }

    // =========================================================================
    // Phone — 390 wide, coarse pointer, real touch
    // =========================================================================
    // Order matters in ONE way: headless Chromium swallows the click of the
    // first tap after a CDP touch SCROLL (seen: pointerdown/up and touchstart/
    // end arrive, no click; the second tap clicks). So every tab tap comes
    // before the first synthetic swipe, and nothing is tapped after one.
    const mctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined, baseURL, storageState: state });
    const m = await mctx.newPage();
    watch(m);
    const mshot = shotOf(m);
    try {
        await m.goto('/notes/');
        await m.waitForSelector('.notes-pages-tabs', { timeout: 20000 }).catch(() => {});
        await m.waitForSelector('.notes-page.active .notes-card', { timeout: 20000 }).catch(() => {});
        s = await pagerState(m);
        ck('pager (phone): the strip is there (precondition)', s.strip && s.pager && s.tabs.length >= 3, JSON.stringify(s.tabs));
        // Against the SCREEN's width, not innerWidth: under mobile emulation an
        // overflowing page widens the layout viewport to fit (measured with the
        // pages unclipped: scrollWidth 1170, innerWidth 1170 on a 390 screen),
        // so scrollWidth <= innerWidth can never fail there.
        const docFits = pg => pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, vw: screen.width }));
        let d = await docFits(m);
        ck('pager (phone): the DOCUMENT never scrolls sideways (only the pager does)', d.sw <= d.vw + 1 && d.iw <= d.vw + 1, JSON.stringify(d));
        const tabSizes = await m.evaluate(() => [...document.querySelectorAll('.notes-pages-tab')].map(t => {
            const r = t.getBoundingClientRect(); return { h: Math.round(r.height * 10) / 10, w: Math.round(r.width) };
        }));
        ck('pager (phone): every tab is a 44px target', tabSizes.length >= 3 && tabSizes.length === s.tabs.length && tabSizes.every(t => t.h >= 44 && t.w >= 44), JSON.stringify(tabSizes));

        // Where All is being read: some way down. Kept across the move below
        // and checked when All comes back (after the old-WebView page).
        const readAt = await m.evaluate(async () => {
            const a = document.querySelector('.notes-page[data-page="all"]');
            if (!a) return null;
            a.scrollTop = 240;
            await new Promise(r => setTimeout(r, 200));
            return { top: a.scrollTop, sh: a.scrollHeight, ch: a.clientHeight };
        });

        // Scroll the pager one page along, as a swipe would leave it.
        await m.evaluate(() => { const p = document.querySelector('.notes-pager'); p.scrollBy({ left: p.clientWidth, behavior: 'instant' }); });
        ok = await settledOn(m, 1, labelHash(s.tabs[1]));
        let ps = await pagerState(m);
        ck('pager (phone): scrolling the pager one page along moves the route AND the active tab',
            ok && ps.hash === labelHash(s.tabs[1]) && JSON.stringify(ps.selected) === JSON.stringify([s.tabs[1]]),
            JSON.stringify({ hash: ps.hash, selected: ps.selected }));
        await sleep(300);
        const allGone = await m.evaluate(() => {
            const a = document.querySelector('.notes-page[data-page="all"]');
            return !!a && !a.classList.contains('live') && a.querySelector('.notes-card') === null;
        });

        // An older WebView: no scrollend at all (not even the property, which is
        // what the pager asks), so the debounce alone must carry the sync.
        const old = await mctx.newPage();
        watch(old);
        await old.addInitScript(() => {
            for (const o of [window, Window.prototype, Document.prototype, Element.prototype, HTMLElement.prototype, EventTarget.prototype]) {
                try { delete o.onscrollend; } catch { /* not configurable here */ }
            }
            window.addEventListener('scrollend', e => e.stopImmediatePropagation(), true);
        });
        await old.goto('/notes/');
        await old.waitForSelector('.notes-page.active .notes-card', { timeout: 20000 }).catch(() => {});
        const noScrollEnd = await old.evaluate(() => !('onscrollend' in window));
        // ONE page along, as a swipe moves it. This was a two-page scrollBy,
        // which scroll-snap-stop: always (one list per swipe) now stops after
        // one page, as it would any directional scroll: a jump no swipe makes.
        await old.evaluate(() => { const p = document.querySelector('.notes-pager'); p.scrollBy({ left: p.clientWidth, behavior: 'instant' }); });
        ok = await settledOn(old, 1, labelHash(s.tabs[1]));
        ps = await pagerState(old);
        ck('pager (phone): in a WebView with no scrollend, the debounce still moves the route and the tab',
            noScrollEnd && ok && JSON.stringify(ps.selected) === JSON.stringify([s.tabs[1]]),
            JSON.stringify({ noScrollEnd, hash: ps.hash, selected: ps.selected }));
        await old.close();

        // ---- each list keeps its place: back on All, where it was being read ----------
        // All's grid was unmounted while it was off screen; an emptied page is
        // clamped to scrollTop 0 and says so with a scroll event. The first cut
        // saved THAT 0 as the reading position, so a list always came back at
        // its top.
        await m.locator('.notes-pages-tab', { hasText: 'All notes' }).first().tap({ timeout: 5000 });
        ok = await settledOn(m, 0, '#/');
        await sleep(300);
        const backAt = await m.evaluate(() => document.querySelector('.notes-page[data-page="all"]')?.scrollTop ?? null);
        ck('pager (phone): All was being read part-way down, and its grid really went while it was away (precondition)',
            !!readAt && readAt.top >= 200 && allGone, JSON.stringify({ readAt, allGone }));
        ck('pager (phone): …and coming back to All opens it where it was being read, not at the top',
            ok && !!readAt && readAt.top >= 200 && backAt !== null && Math.abs(backAt - readAt.top) <= 2,
            JSON.stringify({ was: readAt?.top, now: backAt, settled: ok }));

        // A tab TAP (before any synthetic swipe — see above).
        await m.locator('.notes-pages-tab', { hasText: L1 }).first().tap({ timeout: 5000 });
        ok = await settledOn(m, idx1, labelHash(L1));
        ps = await pagerState(m);
        ck('pager (phone): tapping a tab moves to that list', ok && ps.activeLabel === L1, JSON.stringify({ hash: ps.hash, activeLabel: ps.activeLabel }));
        const inView = await m.evaluate(() => {
            const strip = document.querySelector('.notes-pages-tabs').getBoundingClientRect();
            const t = document.querySelector('.notes-pages-tab[aria-selected="true"]').getBoundingClientRect();
            return { ok: t.left >= strip.left - 0.5 && t.right <= strip.right + 0.5, t: [Math.round(t.left), Math.round(t.right)], strip: [Math.round(strip.left), Math.round(strip.right)] };
        });
        ck('pager (phone): the selected tab is scrolled into view', inView.ok, JSON.stringify(inView));

        const cdp = await mctx.newCDPSession(m);
        const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
        const drag = async (x0, y0, x1, y1, steps, atStep, at) => {
            await touch('touchStart', x0, y0);
            for (let i = 1; i <= steps; i++) {
                await touch('touchMove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
                await sleep(16);
                if (at && i === atStep) await at();
            }
            await touch('touchEnd');
        };

        // Drag a card by its grip — down AND sideways: a reorder, never a swipe.
        // The grip lives in LIST view: grid view on a phone is two columns
        // (like Keep) and offers none. The rest of this context stays in list
        // view, the one-column layout these gestures were written against; the
        // choice is per device, so it ends with this context.
        await m.tap('button[aria-label="Switch to list view"]');
        await sleep(300);
        await m.evaluate(() => { document.querySelector('.notes-page.active').scrollTop = 0; });
        await sleep(200);
        const grip = await m.locator('.notes-page.active .notes-card-grip').first().boundingBox({ timeout: 5000 }).catch(() => null);
        const before = await pagerState(m);
        let dragLive = false;
        let slMid = null;
        if (grip) {
            const gx = grip.x + grip.width / 2, gy = grip.y + grip.height / 2;
            await drag(gx, gy, gx + 110, gy + 200, 16, 8, async () => {
                dragLive = await m.evaluate(() => document.body.classList.contains('drag-reorder-active'));
                slMid = await m.evaluate(() => document.querySelector('.notes-pager').scrollLeft);
            });
            await sleep(800);
        }
        ps = await pagerState(m);
        ck('pager (phone): a card drag from its grip really started (precondition)', !!grip && dragLive,
            JSON.stringify({ grip: !!grip, dragLive, cards: before.activeCards.length }));
        ck('pager (phone): dragging a card by its grip — down AND sideways — never moves the pager',
            !!grip && dragLive && slMid === before.sl && ps.sl === before.sl && ps.hash === before.hash,
            JSON.stringify({ before: before.sl, mid: slMid, after: ps.sl, hash: ps.hash }));

        // Keep's half: down inside a page scrolls THAT page.
        await m.evaluate(() => { document.querySelector('.notes-page.active').scrollTop = 0; });
        await sleep(200);
        const room = await m.evaluate(() => { const a = document.querySelector('.notes-page.active'); return { sh: a.scrollHeight, ch: a.clientHeight }; });
        await drag(200, 520, 203, 180, 14);
        await sleep(900);
        const v = await m.evaluate(() => ({
            top: document.querySelector('.notes-page.active').scrollTop,
            main: document.querySelector('.notes-main').scrollTop,
            sl: document.querySelector('.notes-pager').scrollLeft,
            hash: location.hash,
        }));
        ck('pager (phone): the list is long enough to scroll (precondition)', room.sh > room.ch + 100, JSON.stringify(room));
        ck('pager (phone): a vertical swipe scrolls the page itself — not the pager, not the main column',
            v.top > 50 && v.main === 0 && v.sl === before.sl && v.hash === labelHash(L1), JSON.stringify(v));

        // Tasks' half: a REAL sideways swipe, through the browser's own gesture
        // handling — with the finger held still for a moment five-sixths of
        // the way across (past the half-way point, so a settle there would pick
        // the OTHER page), the way a hesitant thumb does. Nothing may change
        // while it is down (the first cut "settled" in that pause); the incoming
        // list must already show its notes; and the lift lands one list along.
        const swipeTo = idx1 + 1 < s.tabs.length ? idx1 + 1 : idx1 - 1;
        const swipeHash = swipeTo === 0 ? '#/' : labelHash(s.tabs[swipeTo]);
        // Never from the grip (the left edge, touch-action: none): that is a drag.
        const [x0, x1] = swipeTo > idx1 ? [340, 40] : [100, 380];
        let held = null;
        await drag(x0, 400, x1, 404, 12, 10, async () => {
            const at = () => m.evaluate(want => {
                const p = document.querySelector('.notes-pager');
                const incoming = document.querySelectorAll('.notes-page')[want];
                return { sl: p.scrollLeft, hash: location.hash, incomingLive: !!incoming?.classList.contains('live'), incomingCards: incoming ? incoming.querySelectorAll('.notes-card').length : -1 };
            }, swipeTo);
            const a = await at();
            await sleep(350);
            held = { before: a, after: await at() };
        });
        ok = await settledOn(m, swipeTo, swipeHash);
        ps = await pagerState(m);
        ck('pager (phone): mid-swipe, the pager was held past half-way between two lists (precondition)',
            !!held && Math.abs(held.before.sl - idx1 * ps.w) > ps.w / 2 && Math.abs(held.before.sl - swipeTo * ps.w) > 5, JSON.stringify(held));
        ck('pager (phone): a finger held still mid-swipe changes nothing until it lifts',
            !!held && held.before.hash === labelHash(L1) && held.after.hash === labelHash(L1) && Math.abs(held.after.sl - held.before.sl) <= 1,
            JSON.stringify(held));
        ck('pager (phone): …the incoming list already shows its notes while the finger is down',
            !!held && held.after.incomingLive && held.after.incomingCards > 0, JSON.stringify(held?.after));
        ck('pager (phone): …and the lift lands one list along (route and pager)', ok,
            JSON.stringify({ from: L1, to: s.tabs[swipeTo], hash: ps.hash, sl: ps.sl, w: ps.w }));
        d = await docFits(m);
        ck('pager (phone): still no sideways document scroll after the gestures', d.sw <= d.vw + 1 && d.iw <= d.vw + 1, JSON.stringify(d));
        await mshot('phone-pager');
    } catch (e) {
        ck('pager (phone): the phone half ran to the end', false, String(e).split('\n')[0]);
    } finally {
        await mctx.close();
    }

    // =========================================================================
    // A Pixel-class phone: 1080 px at DPR 2.625 = 411.43 CSS px
    // =========================================================================
    // clientWidth reads 411, so every page is 0.43 px wider than the pager
    // says, and the error adds up: on the first cut, from page 4 on the NEXT
    // list counted as on screen at rest (onScreen 4:5) and held a real grid
    // — every labelled note drawn twice, and a screen reader walking a list
    // nobody can see. Both the DPR (scroll offsets snap to its device pixels)
    // and a page AFTER the one that drifts are needed to see it: an iPhone-13
    // context (DPR 3) or four pages both passed the first cut.
    const pctx = await browser.newContext({
        viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, baseURL, storageState: state,
    });
    const px = await pctx.newPage();
    watch(px);
    try {
        await px.goto('/notes/');
        await px.waitForSelector('.notes-page.active .notes-card', { timeout: 20000 }).catch(() => {});
        await fractionalWidth(px, 0.5714);
        await sleep(300);
        const f = await pagerState(px);
        const stops = await restOnEveryPage(px, f.tabs);
        ck("pager (Pixel-class phone): at 411.43 px, resting on any page holds ONE grid — that page's",
            Math.abs(f.w - 411.43) < 0.05 && f.cw === 411 && stops.length >= 5 && stops.every(oneGridAtRest),
            JSON.stringify({ w: f.w, cw: f.cw, pages: stops.length, bad: stops.filter(x => !oneGridAtRest(x)) }));
    } catch (e) {
        ck('pager (Pixel-class phone): ran to the end', false, String(e).split('\n')[0]);
    } finally {
        await pctx.close();
    }

    ck('pager: no page errors', errors.length === errorsAtStart, errors[errorsAtStart]);
    return { skipped: 0 };
}

// ---- Standalone -------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const outdir = process.argv[2] || 'e2e/shots-notes-pager';
    const baseURL = process.argv[3] || 'http://127.0.0.1:5176';
    fs.mkdirSync(outdir, { recursive: true });
    let fail = 0;
    const ck = (n, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail !== undefined ? '  — ' + detail : ''}`); if (!ok) fail++; };
    const errors = [];
    const watch = page => {
        page.on('dialog', d => { d.accept().catch(() => {}); });
        page.on('pageerror', e => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 300)); });
        page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 200)); });
    };
    let n = 0;
    const shotOf = page => async name => { n++; const f = `${outdir}/${String(n).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: f }); console.log('SHOT', f); };
    const browser = await chromium.launch({ args: ['--mute-audio'] });   // a walk never makes a sound
    const username = 'notespager_' + Math.random().toString(36).slice(2, 8);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL });
    const page = await ctx.newPage();
    watch(page);
    await page.goto('/login');
    await page.waitForSelector('.toggle-mode', { timeout: 15000 });
    await page.click('.toggle-mode');
    await page.fill('#username', username);
    await page.fill('#password', 'Password123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/chat', { timeout: 30000 });
    try { await page.click('.recovery-done-btn', { timeout: 8000 }); } catch { /* no modal */ }
    await page.goto('/notes/');
    await page.waitForSelector('.notes-empty', { timeout: 15000 });
    await makeNote(page, 'Groceries', 'Milk');
    const state = await ctx.storageState();
    await ctx.close();
    await pagerWalk({ browser, baseURL, state, ck, watch, shotOf, errors });
    await browser.close();
    console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
    process.exit(fail === 0 ? 0 : 1);
}
