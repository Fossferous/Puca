// Geometry check for the screen-share stage layout (StreamStage.css).
//
// The layout contract is enforced in two places, deliberately:
//   - src/tests/streamStageLayout.test.tsx proves the DOM never changes shape
//     across a layout switch (element identity + order) — jsdom, no layout;
//   - THIS proves the CSS actually lays those classes out correctly, which
//     jsdom cannot do because it computes no geometry at all.
//
// It renders e2e/stage-harness.html (which links the REAL stylesheet, not a
// copy) at desktop and phone sizes and asserts the stage/filmstrip geometry.
//
// Usage: node e2e/stage-layout-check.mjs
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = pathToFileURL(path.resolve('e2e/stage-harness.html')).href;

let fail = 0;
const ck = (n, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`);
    if (!ok) fail++;
};

const browser = await chromium.launch();

/** Measure one .stream-grid: container, stage, thumbs, overflow. */
const measure = (page, id) => page.evaluate((gid) => {
    const g = document.getElementById(gid);
    const box = g.getBoundingClientRect();
    const cs = getComputedStyle(g);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const stage = g.querySelector('.is-stage');
    const thumbs = [...g.querySelectorAll('.is-thumb')];
    const r = (el) => el.getBoundingClientRect();
    return {
        // `inner` is the CONTENT box — tiles are sized against this, not against
        // the border box, because the grid keeps a 4px gutter on every side.
        container: { w: box.width, h: box.height, inner: box.height - padY },
        stage: stage ? { w: r(stage).width, h: r(stage).height, top: r(stage).top - box.top } : null,
        thumbs: thumbs.map(t => ({ w: r(t).width, h: r(t).height, top: Math.round(r(t).top) })),
        thumbRows: new Set(thumbs.map(t => Math.round(r(t).top))).size,
        // The container scrolls, so "overflow" means content taller than the
        // box — i.e. the stage got pushed out of view — not merely a tile whose
        // rect extends past the padding edge.
        overflowing: g.scrollHeight > g.clientHeight + 1 ? 1 : 0,
        // The stage must be readable WITHOUT scrolling even when the strip
        // wraps — on a narrow phone, seven legible thumbs simply do not fit one
        // row, and scrolling for the extras is the acceptable degradation.
        stageFitsWithoutScroll: stage
            ? r(stage).top - box.top + r(stage).height <= g.clientHeight + 2
            : null,
        // Everything in the strip, thumbs AND "Watch" cards — the cards are
        // sized by the same rules, so they must share the row, not start a
        // second one.
        stripRows: new Set(
            [...g.querySelectorAll('.stream-tile:not(.is-stage)')].map(t => Math.round(r(t).top))
        ).size,
        cardHeights: [...g.querySelectorAll('.watch-card')].map(c => Math.round(r(c).height)),
        thumbHeight: thumbs.length ? Math.round(r(thumbs[0]).height) : null,
        stageAboveStrip: stage && thumbs.length
            ? r(stage).top < Math.min(...thumbs.map(t => r(t).top))
            : null,
    };
}, id);

for (const [label, width, height, stripBudget] of [
    ['desktop 1280x800', 1280, 800, 112],
    ['phone 390x844', 390, 844, 76],
]) {
    console.log(`\n=== ${label} ===`);
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url);
    await page.waitForTimeout(150); // let fonts/layout settle

    const grid = await measure(page, 'g1');
    ck('grid mode: no tile overflows the container', grid.overflowing === 0);

    const focus = await measure(page, 'g2');
    ck('focus: the stage is ABOVE the filmstrip (CSS order, not DOM order)',
        focus.stageAboveStrip === true);
    ck('focus: stage leaves room for exactly one strip row',
        Math.abs(focus.container.inner - focus.stage.h - stripBudget) <= 10,
        `inner ${Math.round(focus.container.inner)} stage ${Math.round(focus.stage.h)}`);
    ck('focus: the filmstrip is a single row', focus.thumbRows === 1);
    ck('focus: nothing overflows the container', focus.overflowing === 0);
    ck('focus: the stage is much larger than a thumb',
        focus.stage.h > focus.thumbs[0].h * 2,
        `stage ${Math.round(focus.stage.h)} vs thumb ${Math.round(focus.thumbs[0].h)}`);

    const solo = await measure(page, 'g3');
    ck('focus with ONE stream: stage fills the container (no reserved strip)',
        Math.abs(solo.stage.h - solo.container.inner) <= 2,
        `stage ${Math.round(solo.stage.h)} inner ${Math.round(solo.container.inner)}`);

    const eight = await measure(page, 'g4');
    ck('focus with 8 streams: the stage is fully visible without scrolling',
        eight.stageFitsWithoutScroll === true);
    ck('focus with 8 streams: stage still dominates',
        eight.stage.h > eight.container.h * 0.5,
        `stage ${Math.round(eight.stage.h)} of ${Math.round(eight.container.h)}`);
    // A phone is narrow; wrapping to a second strip row (and scrolling for the
    // extras) is the accepted degradation there, because seven legible thumbs
    // do not fit 390px. On a desktop the strip must stay one row.
    if (width >= 1280) {
        ck('focus with 8 streams: filmstrip stays one row on desktop', eight.thumbRows === 1,
            `rows=${eight.thumbRows}, thumb w=${Math.round(eight.thumbs[0].w)}`);
        ck('focus with 8 streams: nothing is pushed out of view', eight.overflowing === 0);
    } else {
        console.log(`INFO  phone strip rows with 8 streams: ${eight.thumbRows} (thumb ${Math.round(eight.thumbs[0].w)}px wide, strip scrolls)`);
    }

    const cards = await measure(page, 'g5');
    ck('watch cards: share the strip row with the thumbnails', cards.stripRows === 1,
        `rows=${cards.stripRows}`);
    ck('watch cards: are the same height as a thumbnail',
        cards.cardHeights.every(h => h === cards.thumbHeight),
        `cards ${cards.cardHeights.join('/')} vs thumb ${cards.thumbHeight}`);
    ck('watch cards: stage still fully visible', cards.stageFitsWithoutScroll === true);

    await page.close();
}

await browser.close();
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
