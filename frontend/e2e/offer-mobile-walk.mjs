// The CPU-limited offer at 390x844, with a coarse pointer.
//
// New UI must pass this walk (CLAUDE.md), and .voice-load-offer is new CSS with
// TWO buttons inside a note that was previously a single click-anywhere block.
// The failure it is looking for is the ordinary one for a flex row of buttons
// beside a sentence: the sentence squeezes the buttons to a few pixels, or the
// row overflows the panel, and on a phone the person cannot hit either answer.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/components/VoicePanel.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
});

// The panel markup exactly as VoicePanel renders it, at the width a phone gives
// it. The longest real sentence the offer can produce is the Source rung.
await page.setContent(`<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; }
  .voice-panel-compact { width: 390px; overflow-x: hidden; }
  ${css}
</style>
<div class="voice-panel-compact">
  <div class="voice-diag-note voice-load-offer">
    <span>Your screen share is being limited by CPU. Drop to Source at 60 fps?</span>
    <button class="voice-load-offer-btn">Lower it</button>
    <button class="voice-load-offer-btn ghost">Keep it</button>
  </div>
</div>`);

let failed = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failed++;
};

const m = await page.evaluate(() => {
    const panel = document.querySelector('.voice-panel-compact');
    const note = document.querySelector('.voice-load-offer');
    const btns = [...document.querySelectorAll('.voice-load-offer-btn')];
    const r = el => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, right: b.right, left: b.left }; };
    return {
        panelW: panel.getBoundingClientRect().width,
        note: r(note),
        buttons: btns.map(r),
        bodyScrollW: document.body.scrollWidth,
        docClientW: document.documentElement.clientWidth,
    };
});

check('the page does not scroll sideways', m.bodyScrollW <= m.docClientW,
    `scrollWidth ${m.bodyScrollW} vs ${m.docClientW}`);
check('the note stays inside the panel', m.note.right <= m.panelW + 0.5,
    `note right ${m.note.right.toFixed(1)} vs panel ${m.panelW}`);

// 30px is the min-height the stylesheet sets; a coarse pointer wants at least
// that in BOTH axes, and a button squeezed by the sentence fails on width.
for (const [i, b] of m.buttons.entries()) {
    check(`button ${i + 1} is a real touch target`, b.w >= 44 && b.h >= 28,
        `${b.w.toFixed(0)}x${b.h.toFixed(0)}`);
    check(`button ${i + 1} is inside the panel`, b.right <= m.panelW + 0.5,
        `right ${b.right.toFixed(1)}`);
}
check('both answers are present', m.buttons.length === 2);

console.log(`\n${failed === 0 ? 'OFFER PASSES THE 390x844 WALK' : failed + ' FAILURE(S)'}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
