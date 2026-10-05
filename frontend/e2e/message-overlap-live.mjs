// LIVE: no message in the chat list may paint over another one.
//
// The owner's report (2026-10-04, "Images stretch over text"): a run of quick
// same-author messages, then a grouped image — and the image's top edge sat
// over the line above it. Grouped rows were pulled up by a fixed
// `margin-top: -7px` meant to cancel the PREVIOUS row's 0.5rem bottom padding;
// after a grouped row (1px bottom padding) it pulled the next row ~5 px INTO
// the line above. Text over text only looked cramped, so nothing noticed until
// an opaque image, player or clip plate covered the line.
//
// What it proves, against the REAL web client and a throwaway backend, on a
// 1280x800 desktop AND a 390x844 coarse-pointer phone, in normal AND compact
// density:
//   1. a header message, four same-author lines, a grouped encrypted IMAGE
//      (uploaded through the composer, with a reaction under it), a line, a
//      grouped encrypted VIDEO (the inline player; nothing is played), a line,
//      a grouped Puca CLIP plate, a line, a blocked third-party image chip, a
//      line, a grouped SPOILERED image (marked in the composer; its blur cover
//      is scaled past its box and cropped by the spoiler), a line, then a
//      REPLY made with the hover toolbar (a new header row) and a line under
//      it, then a line from a second member whom the poster then BLOCKS (the
//      "Blocked message" stub row) and a line after it - posted at a person's
//      pace and read back from the server; and on the desktop the same run
//      plus an image in a DM (your conversation with yourself), which Chat.tsx
//      renders from its own branch;
//   2. no CONTENT of one message (each text line's glyph box from a Range,
//      every img / video / clip plate / attachment chip / reaction / reply
//      reference / avatar) intersects the content of any other message. Each
//      rect is first cut down to every ancestor inside its row that clips
//      overflow (what is PAINTED, not the layout box: the spoiler cover's
//      scaled <img> reaches ~10 px past each edge of what shows);
//   3. no message ROW overlaps its neighbour: the row is what the hover and
//      @mention backgrounds paint, so an overlapping row tints the next
//      message's first line;
//   4. desktop only (fine pointer): hovering any row moves no other row
//      (hover may change only the horizontal padding), moves none of the
//      hovered row's own content (the blocked stub's text used to jump 16 px
//      left), and the hovered row still overlaps nothing;
//   5. POSITIVE CONTROL, every configuration: the same detector, handed the
//      old failure mode (a grouped row pulled up 12 px), MUST report it - so
//      a detector that measured nothing, or the wrong elements, cannot pass;
//      and on the desktop the hover check, handed a hover that shifts the
//      row's content, MUST report that;
//   6. an engine without :has() (simulated) still gets no overlap;
//   7. the grouped-text line pitch is printed (MEASURE) and must not be
//      smaller than a line box (two single-line grouped rows sharing pixels
//      is the bug) - nor larger than the line box plus the density's run gap
//      (2 px normal, 0 compact), the same pitch as the first line under the
//      header, so a run still reads as one message. Its control: the looser
//      no-:has() spacing of check 6 must fail it;
//   8. nothing in the list is wider than the list: it cannot be dragged
//      sideways, and no picture, player or chip reaches past its right edge
//      (review finding 2026-10-05: on a 411 px phone a 1200 px picture was
//      drawn 400 px wide from x=68 - cut off, and every message could be
//      swiped 57 px left). Measured on the LIST, not the document: the list
//      scrolls on both axes, so the page's own width never changes. Its
//      CONTROL: an element 70 px wider than the list, put in a row, must fail
//      it.
// Each check prints PASS/FAIL; the exit code is the number of failures.
// Screenshots go to OUT (SHOT <file>) - look at them.
//
// Nothing is ever audible: the browser runs with --mute-audio, every <video>
// is muted before it is measured, and nothing calls play().
//
// Prereqs: a THROWAWAY backend (APP_ENV=development, raised
// AUTH_RATE_LIMIT_PER_SECOND / _BURST, its own fresh database - never a real
// one) and vite of THIS tree at APP, started with VITE_API_URL pointing at that
// backend (the walk imports /src/api/* through vite for the fixture).
//
// Usage (from frontend/):
//   APP=http://127.0.0.1:5711 OUT=<dir> node e2e/message-overlap-live.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:5711';
const OUT = process.env.OUT || 'e2e/shots-message-overlap';
const PASS = 'Password123!pw';
const stamp = Date.now().toString(36);
const USER = 'ovl_' + stamp;
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  -- ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch { /* retry */ }
        await sleep(step);
    }
    return last;
}
const shot = async (page, name) => {
    const f = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: f });
    console.log('SHOT', f);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio'] });

function watch(page, tag) {
    page.on('pageerror', e => console.log(`  [${tag} pageerror]`, e.message.slice(0, 200)));
    page.on('dialog', d => { console.log(`  [${tag} dialog]`, d.message().slice(0, 120)); d.dismiss().catch(() => {}); });
}

async function dismiss(page) {
    for (let i = 0; i < 3; i++) {
        let did = false;
        if (await page.locator('.recovery-confirm input[type="checkbox"]').count()) {
            await page.locator('.recovery-confirm input[type="checkbox"]').first().check().catch(() => {});
            await page.locator('.recovery-done-btn').first().click().catch(() => {});
            did = true;
        }
        if (await page.locator('.welcome-popup-close').count()) { await page.locator('.welcome-popup-close').first().click().catch(() => {}); did = true; }
        const later = page.getByRole('button', { name: 'Later', exact: true });
        if (await later.count()) { await later.first().click().catch(() => {}); did = true; }
        if (!did) return;
        await sleep(300);
    }
}

async function signIn(ctx, tag, register, user = USER) {
    const page = await ctx.newPage();
    watch(page, tag);
    await page.goto(APP + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByPlaceholder('Enter username').waitFor({ timeout: 60000 });
    if (register) await page.locator('.toggle-mode').click();
    await page.getByPlaceholder('Enter username').fill(user);
    await page.getByPlaceholder(register ? 'Choose a password (min 8 characters)' : 'Enter password').fill(PASS);
    await page.locator('button.login-button[type="submit"]').click();
    await page.waitForURL('**/chat', { timeout: 60000 });
    await sleep(1500);
    await dismiss(page);
    return page;
}

const call = (page, mod, fn, args = []) => page.evaluate(async ({ mod, fn, args }) => {
    const m = await import(mod);
    return m[fn](...args);
}, { mod, fn, args });

/** The composer, in a channel ("Message #x") or a DM ("Message @x"). */
const COMPOSER = 'form.message-form textarea';

const rowCount = (page) => page.evaluate(() =>
    [...(document.querySelector('.messages-container')?.children || [])].filter(e => e.classList.contains('message')).length);

/** The server has acknowledged every row (no optimistic local_ id left). */
const acked = (page) => page.evaluate(() => !document.querySelector('.messages-container > .message[id^="msg-local_"]'));

/** Type one line into the real composer and wait until the SERVER has it
 *  before the next one. The walk is about layout, not about how fast the
 *  composer can be driven: two sends tens of ms apart into a brand-new channel
 *  (no key yet) can each mint epoch 1, and the second row then reads
 *  "does not belong here" for every reader (seen 2026-10-04) - a separate
 *  defect, not this walk's subject. */
async function say(page, text) {
    const before = await rowCount(page);
    const box = page.locator(COMPOSER);
    await box.fill(text);
    await box.press('Enter');
    check(`posted "${text.slice(0, 40)}"`, !!await until(async () => (await rowCount(page)) > before && await acked(page), 15000));
}

/** Attach a file through the composer's own file input, then send it -
 *  marked as a spoiler with the chip's own toggle when asked. */
async function attach(page, file, { spoiler = false } = {}) {
    const before = await rowCount(page);
    await page.locator('label.file-upload-btn input[type="file"]').setInputFiles(file);
    const ready = await until(async () => (await page.locator('.composer-chip-ready').count()) > 0, 30000);
    check(`${file.name}: the upload finished in the composer`, !!ready);
    if (spoiler) {
        await page.getByRole('button', { name: `Mark ${file.name} as spoiler`, exact: true }).click();
        check(`${file.name}: marked as a spoiler in the composer`, (await page.locator('.composer-chip-spoiler').count()) === 1);
    }
    await page.locator(COMPOSER).press('Enter');
    check(`${file.name}: posted`, !!await until(async () => (await rowCount(page)) > before && await acked(page), 15000));
}

/**
 * In the page: every message row of the list, with the rects of what it
 * PAINTS (content) and of the row itself. Text is measured per line through a
 * Range (the glyph box of each line fragment), never the element's box: a
 * block's box spans its whole width, so it would "overlap" things the text
 * never touches. The hover toolbar is excluded - it floats over the row above
 * on purpose.
 *
 * Every content rect is what is PAINTED: cut down to each ancestor inside the
 * row that clips its overflow. An unrevealed spoiler's <img> is scaled 1.08
 * past its box for the blur cover and cropped by the spoiler's
 * overflow:hidden - its layout rect reaches ~10 px past each edge of what is
 * on screen, and measured raw it "overlapped" the lines above and below by
 * 3-10 px. An inline box is skipped: overflow does not apply to it, whatever
 * its computed value says.
 */
const MEASURE = () => {
    const list = document.querySelector('.messages-container');
    const rows = [...(list?.children || [])].filter(e => e.classList.contains('message'));
    const R = (q) => ({ top: q.top, bottom: q.bottom, left: q.left, right: q.right });
    const out = rows.map((row, index) => {
        const painted = (el, q) => {
            const r = R(q);
            for (let a = el.parentElement; a && a !== row; a = a.parentElement) {
                const cs = getComputedStyle(a);
                if (cs.display === 'inline' || (cs.overflowX === 'visible' && cs.overflowY === 'visible')) continue;
                const b = a.getBoundingClientRect();
                if (cs.overflowX !== 'visible') { r.left = Math.max(r.left, b.left); r.right = Math.min(r.right, b.right); }
                if (cs.overflowY !== 'visible') { r.top = Math.max(r.top, b.top); r.bottom = Math.min(r.bottom, b.bottom); }
            }
            return r;
        };
        const content = [];
        const body = row.querySelector('.message-body') || row;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue;
            const p = n.parentElement;
            if (!p || p.closest('.message-actions, .add-reaction-wrapper')) continue;
            const cs = getComputedStyle(p);
            if (cs.visibility === 'hidden' || p.getClientRects().length === 0) continue;
            const rg = document.createRange();
            rg.selectNodeContents(n);
            for (const q of rg.getClientRects()) {
                const r = painted(p, q);
                if (r.right - r.left > 0 && r.bottom - r.top > 0) content.push({ what: 'text:' + n.textContent.trim().slice(0, 24), ...r });
            }
        }
        const SEL = 'img, video, .clip-attachment, .message-attachment, .message-image-blocked, .reaction-badge, .message-reply-ref, .code-block, .message-quote, .task-checkbox';
        for (const el of body.querySelectorAll(SEL)) {
            if (el.closest('.message-actions, .add-reaction-wrapper')) continue;
            const r = painted(el, el.getBoundingClientRect());
            if (r.right - r.left > 0 && r.bottom - r.top > 0) content.push({ what: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''), ...r });
        }
        const av = row.querySelector(':scope > .message-avatar');
        if (av) { const q = av.getBoundingClientRect(); if (q.height) content.push({ what: 'avatar', ...R(q) }); }
        const stub = row.classList.contains('blocked-message-stub');
        const spoiler = !!row.querySelector('.spoiler:not(.revealed) .message-image img');
        const label = stub ? '[blocked]' : spoiler ? '[spoiler image]'
            : (row.querySelector('.message-content')?.textContent || '').trim().slice(0, 24)
            || (row.querySelector('img') ? '[image]' : row.querySelector('video') ? '[video]' : row.querySelector('.clip-attachment') ? '[clip]' : '[?]');
        // `y` is the row's top in the LIST's coordinates (scroll-independent),
        // so a scroll between two measurements is not mistaken for a shift.
        const y = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
        // The list's origin in viewport coordinates: content rect minus this
        // is its place in the list, whatever the list scrolled in between.
        const origin = { x: list.getBoundingClientRect().left - list.scrollLeft, y: list.getBoundingClientRect().top - list.scrollTop };
        const pad = getComputedStyle(row);
        return {
            index, label, grouped: row.classList.contains('grouped'), stub, spoiler, y, origin,
            padding: `${pad.paddingTop} ${pad.paddingRight} ${pad.paddingBottom} ${pad.paddingLeft}`,
            box: R(row.getBoundingClientRect()), content,
        };
    });
    return out;
};

/** The list's own width and how far it scrolls sideways (in the page). */
const LIST_WIDTH = () => {
    const list = document.querySelector('.messages-container');
    const left = list.getBoundingClientRect().left;
    return { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, left, right: left + list.clientWidth };
};

/** Check 8 over one MEASURE() and LIST_WIDTH(): the list does not scroll
 *  sideways, and no painted content reaches past either edge of it. */
function tooWide(rows, w) {
    const past = rows.flatMap(r => r.content
        .filter(c => c.right > w.right + 0.5 || c.left < w.left - 0.5)
        .map(c => `${r.label} ${c.what} ${c.left.toFixed(0)}..${c.right.toFixed(0)}`));
    return { ok: w.scrollWidth <= w.clientWidth && past.length === 0, scrollWidth: w.scrollWidth, clientWidth: w.clientWidth, past: past.slice(0, 4) };
}

/** Overlap findings over one MEASURE() result. */
function findings(rows) {
    const contentHits = [];
    const boxHits = [];
    const EPS = 0.5;
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            for (const a of rows[i].content) {
                for (const b of rows[j].content) {
                    const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                    const h = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                    if (v > EPS && h > EPS) contentHits.push({ upper: `${rows[i].label} ${a.what}`, lower: `${rows[j].label} ${b.what}`, px: +v.toFixed(1) });
                }
            }
        }
        if (i + 1 < rows.length) {
            const v = rows[i].box.bottom - rows[i + 1].box.top;
            if (v > EPS) boxHits.push({ upper: rows[i].label, lower: rows[i + 1].label, px: +v.toFixed(1) });
        }
    }
    return { contentHits, boxHits };
}

/** How the hovered row's OWN content moved, in the list's coordinates (a
 *  scroll of the list in between is not a move): each item matched to itself
 *  before the hover by kind and order (the hover toolbar is not content). */
function ownShift(before, after) {
    const keyed = (list) => { const n = {}; return list.map(c => [`${c.what}#${n[c.what] = (n[c.what] || 0) + 1}`, c]); };
    const was = new Map(keyed(before.content));
    const shifts = [];
    let compared = 0;
    for (const [k, c] of keyed(after.content)) {
        const p = was.get(k);
        if (!p) continue;
        compared++;
        const dx = (c.left - after.origin.x) - (p.left - before.origin.x);
        const dy = (c.top - after.origin.y) - (p.top - before.origin.y);
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            shifts.push({ what: k, dx: +dx.toFixed(1), dy: +dy.toFixed(1), scrolled: +(before.origin.y - after.origin.y).toFixed(1), was: [+p.left.toFixed(1), +p.top.toFixed(1)], now: [+c.left.toFixed(1), +c.top.toFixed(1)] });
        }
    }
    return { compared, shifts };
}

/** Measure, put the pointer on row `i`, measure again. */
async function hoverRow(page, i) {
    const row = page.locator('.messages-container > .message').nth(i);
    await row.scrollIntoViewIfNeeded();
    const before = await page.evaluate(MEASURE);
    const bb = await row.boundingBox();
    await page.mouse.move(bb.x + 8, bb.y + bb.height / 2);
    await sleep(60);
    const now = await page.evaluate(MEASURE);
    return { before, now };
}

/** Top of the first text line of the row whose content is exactly `text`. */
function lineTop(rows, text) {
    const r = rows.find(x => x.label === text);
    const t = r?.content.find(c => c.what === 'text:' + text);
    return t ? t : null;
}

/** Grouped-text line pitch: THE -> RAT -> "can he go in tunnels?" are
 *  single-line grouped rows that each follow a grouped row. */
function groupedPitch(rows) {
    const t = lineTop(rows, 'THE'), r3 = lineTop(rows, 'RAT'), tn = lineTop(rows, 'can he go in tunnels?');
    return t && r3 && tn ? [+(r3.top - t.top).toFixed(2), +(tn.top - r3.top).toFixed(2)] : null;
}

async function settleMedia(page) {
    // Lazy images only load near the viewport: walk every media element into
    // view and wait for it to have a real size before anything is measured.
    // Every <video> is muted first and none is ever played.
    await page.evaluate(() => document.querySelectorAll('video').forEach(v => { v.muted = true; }));
    const n = await page.locator('.messages-container .message-image img').count();
    for (let i = 0; i < n; i++) {
        const img = page.locator('.messages-container .message-image img').nth(i);
        await img.scrollIntoViewIfNeeded().catch(() => {});
        await until(() => img.evaluate(e => e.complete && e.naturalWidth > 0), 15000);
    }
    const v = page.locator('.messages-container .message-video video');
    if (await v.count()) {
        await v.first().scrollIntoViewIfNeeded().catch(() => {});
        await until(() => v.first().evaluate(e => { e.muted = true; return e.readyState >= 1 && e.videoWidth > 0; }), 15000);
    }
    await page.evaluate(() => { const c = document.querySelector('.messages-container'); c.scrollTop = c.scrollHeight; });
    await sleep(300);
}

async function setCompact(page, on) {
    await page.evaluate(async (on) => {
        const m = await import('/src/components/settingsStore.ts');
        m.saveSettings({ ...m.loadSettings(), compactMode: on });
    }, on);
    await sleep(250);
    return page.evaluate(() => document.documentElement.getAttribute('data-compact'));
}

/** What each fixture must have rendered before its measurements mean anything. */
const CHANNEL_FIXTURE = { rows: 19, grouped: 15, media: ['image', 'video', 'clip', 'reaction', 'reply', 'spoiler', 'stub'] };
const DM_FIXTURE = { rows: 6, grouped: 5, media: ['image'] };

/** The space between two lines of one same-author run, by density: what
 *  keeps a run reading as one message without any line touching another. */
const RUN_GAP = { normal: 2, compact: 0 };

/** One configuration: measure, report, hover (desktop), positive controls. */
async function runConfig(page, name, { hover, fx, runGap }) {
    await settleMedia(page);
    const rows = await page.evaluate(MEASURE);
    check(`${name}: the list rendered the whole fixture (${fx.rows} rows, ${fx.grouped} of them grouped)`,
        rows.length === fx.rows && rows.filter(r => r.grouped).length === fx.grouped,
        `${rows.length} rows, ${rows.filter(r => r.grouped).length} grouped`);
    const seen = {
        image: rows.some(r => r.content.some(c => c.what.startsWith('img') && c.bottom - c.top > 20)),
        video: rows.some(r => r.content.some(c => c.what.startsWith('video') && c.bottom - c.top > 20)),
        clip: rows.some(r => r.content.some(c => c.what.startsWith('div.clip-attachment'))),
        reaction: rows.some(r => r.content.some(c => c.what.includes('reaction-badge'))),
        reply: rows.some(r => r.content.some(c => c.what.includes('message-reply-ref'))),
        // Painted, i.e. still a real picture after the spoiler's clip.
        spoiler: rows.some(r => r.spoiler && r.content.some(c => c.what.startsWith('img') && c.bottom - c.top > 20)),
        stub: rows.some(r => r.stub && r.content.some(c => c.what === 'text:Blocked message')),
    };
    const media = Object.fromEntries(fx.media.map(k => [k, seen[k]]));
    check(`${name}: rendered ${fx.media.join(', ')}`, Object.values(media).every(Boolean), media);

    // Not this walk's subject, but say so when a row did not decrypt: its
    // placeholder is still text and is still measured.
    const locked = rows.filter(r => /^\[(Encrypted|Unable|Locked)/.test(r.label)).map(r => `#${r.index} ${r.label}`);
    if (locked.length) console.log(`  NOTE ${name}: rows showing a decrypt-failure placeholder: ${locked.join(', ')}`);

    const f = findings(rows);
    check(`${name}: no message's CONTENT overlaps another message's`, f.contentHits.length === 0, f.contentHits.slice(0, 4));
    check(`${name}: no message ROW overlaps its neighbour (hover/mention backgrounds stay on their own row)`, f.boxHits.length === 0, f.boxHits.slice(0, 4));
    const wide = tooWide(rows, await page.evaluate(LIST_WIDTH));
    check(`${name}: nothing in the list is wider than the list (no sideways drag, nothing cut off at its right edge)`, wide.ok, wide);

    // The owner's exact pair: the last text line above the grouped image.
    const tunnels = lineTop(rows, 'can he go in tunnels?');
    const imgRow = rows.find(r => r.label === '[image]');
    const img = imgRow?.content.find(c => c.what.startsWith('img'));
    const gapToImage = tunnels && img ? +(img.top - tunnels.bottom).toFixed(1) : null;
    check(`${name}: the grouped image starts BELOW the "can he go in tunnels?" line`, gapToImage !== null && gapToImage >= 0, `gap ${gapToImage}px`);

    const pitch = groupedPitch(rows);
    const lineH = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.messages-container .message.grouped .message-content')].find(e => e.textContent.trim() === 'THE');
        return el ? +el.getBoundingClientRect().height.toFixed(2) : null;
    });
    const firstPitch = (() => {
        const a = lineTop(rows, 'Stream the rat.');
        const b = rows[1]?.content.find(c => c.what.startsWith('text:'));
        return a && b ? +(b.top - a.top).toFixed(2) : null;
    })();
    console.log(`  MEASURE ${name}: grouped-text pitch ${JSON.stringify(pitch)} px (header->first grouped ${firstPitch} px), line box ${lineH} px, tunnels->image gap ${gapToImage} px`);
    const stubRow = rows.find(r => r.stub);
    if (stubRow) console.log(`  MEASURE ${name}: blocked stub padding ${stubRow.padding}, height ${+(stubRow.box.bottom - stubRow.box.top).toFixed(2)} px`);
    check(`${name}: two single-line grouped rows are at least one line box apart`, !!pitch && pitch.every(p => p >= lineH - 0.5), { pitch, lineH });
    // ...and no further: a run must still read as one message. Every grouped
    // line sits exactly where the first one under the header does.
    check(`${name}: same-author lines stay ${runGap}px apart (pitch = line box + ${runGap}px, as under the header)`,
        !!pitch && firstPitch !== null && pitch.every(p => Math.abs(p - (lineH + runGap)) <= 0.5 && Math.abs(p - firstPitch) <= 0.5),
        { pitch, firstPitch, want: +(lineH + runGap).toFixed(2) });
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ rows, findings: f, pitch, firstPitch, lineH, gapToImage }, null, 2));
    await page.locator('.messages-container .message', { hasText: 'Stream the rat.' }).first().scrollIntoViewIfNeeded();
    await sleep(200);
    await shot(page, name);
    // ...and the end of the list (the spoiler and the blocked stub).
    await page.evaluate(() => { const c = document.querySelector('.messages-container'); c.scrollTop = c.scrollHeight; });
    await sleep(200);
    await shot(page, `${name}-end`);

    if (hover) {
        const moved = [];
        const shifted = [];
        const uncompared = [];
        const hoverHits = [];
        for (let i = 0; i < rows.length; i++) {
            const { before, now } = await hoverRow(page, i);
            for (let k = 0; k < now.length; k++) {
                const d = now[k].y - before[k].y;
                if (Math.abs(d) > 0.5) moved.push({ hovered: rows[i].label, moved: now[k].label, px: +d.toFixed(1) });
            }
            const own = ownShift(before[i], now[i]);
            if (!own.compared) uncompared.push(rows[i].label);
            if (own.shifts.length) shifted.push({ hovered: rows[i].label, ...own.shifts[0] });
            const hf = findings(now);
            if (hf.contentHits.length || hf.boxHits.length) hoverHits.push({ hovered: rows[i].label, ...hf });
        }
        await page.mouse.move(2, 2);
        check(`${name}: hovering any row moves no row`, moved.length === 0, moved.slice(0, 4));
        check(`${name}: hovering a row moves none of its own content (no sideways jump either)`,
            shifted.length === 0 && uncompared.length === 0, { shifted: shifted.slice(0, 4), uncompared });
        check(`${name}: a hovered row overlaps nothing`, hoverHits.length === 0, JSON.stringify(hoverHits.slice(0, 2)).slice(0, 400));

        // CONTROL for the own-content check: a hover that shifts the content.
        await page.evaluate(() => {
            const s = document.createElement('style');
            s.id = '__shift_control';
            s.textContent = '.messages-container > .message:hover { padding-left: 3rem !important; }';
            document.head.appendChild(s);
        });
        const c = await hoverRow(page, 0);
        await page.evaluate(() => document.getElementById('__shift_control')?.remove());
        await page.mouse.move(2, 2);
        const ctlShift = ownShift(c.before[0], c.now[0]);
        check(`${name}: CONTROL - the own-content check reports a hover that pushes the content sideways`,
            ctlShift.shifts.length > 0, ctlShift.shifts.slice(0, 2));
    }

    // POSITIVE CONTROL: the old failure mode, re-created. The detector must
    // see it, or every PASS above is vacuous.
    await page.evaluate(() => {
        const s = document.createElement('style');
        s.id = '__overlap_control';
        s.textContent = '.messages-container > .message.grouped { margin-top: -12px !important; }';
        document.head.appendChild(s);
    });
    await sleep(100);
    const ctl = findings(await page.evaluate(MEASURE));
    await page.evaluate(() => document.getElementById('__overlap_control')?.remove());
    await sleep(100);
    check(`${name}: CONTROL - the detector reports a grouped row pulled 12px into the line above`,
        ctl.contentHits.length > 0 && ctl.boxHits.length > 0, `${ctl.contentHits.length} content / ${ctl.boxHits.length} row overlaps`);

    // CONTROL for check 8: something 70 px wider than the list, in a row.
    await page.evaluate(() => {
        const list = document.querySelector('.messages-container');
        const d = document.createElement('div');
        d.id = '__wide_control';
        d.style.cssText = `width: ${list.clientWidth + 70}px; height: 4px;`;
        list.querySelector(':scope > .message .message-content')?.appendChild(d);
    });
    await sleep(100);
    const wideCtl = tooWide(await page.evaluate(MEASURE), await page.evaluate(LIST_WIDTH));
    await page.evaluate(() => document.getElementById('__wide_control')?.remove());
    await page.evaluate(() => { document.querySelector('.messages-container').scrollLeft = 0; });
    await sleep(100);
    check(`${name}: CONTROL - the width check reports an element 70px wider than the list`, !wideCtl.ok, wideCtl);

    // An engine without :has() (Chromium < 105; nothing gates the Android
    // WebView version) drops the rule that trims the bottom of the row above
    // a grouped one. Simulated by putting that padding back: looser, but
    // still no overlap.
    await page.evaluate(() => {
        const s = document.createElement('style');
        s.id = '__no_has';
        s.textContent = '.messages-container > .message { padding-bottom: var(--message-pad) !important; }';
        document.head.appendChild(s);
    });
    await sleep(100);
    const noHasRows = await page.evaluate(MEASURE);
    const noHas = findings(noHasRows);
    const noHasPitch = groupedPitch(noHasRows);
    await page.evaluate(() => document.getElementById('__no_has')?.remove());
    await sleep(100);
    check(`${name}: without :has() support the rows still do not overlap`,
        noHas.contentHits.length === 0 && noHas.boxHits.length === 0, `${noHas.contentHits.length} content / ${noHas.boxHits.length} row overlaps`);
    // CONTROL for the "stay Npx apart" check: the looser no-:has() run must
    // FAIL it - which also proves this engine applied the :has() rule above.
    check(`${name}: CONTROL - the run-gap check rejects the looser no-:has() spacing`,
        !!noHasPitch && noHasPitch.some(p => Math.abs(p - (lineH + runGap)) > 0.5), { noHasPitch, want: +(lineH + runGap).toFixed(2) });
}

async function openChannel(page, serverName, channelName, phone) {
    await page.evaluate((n) => document.querySelector(`.server-icon[title="${n}"]`)?.click(), serverName);
    await sleep(800);
    if (phone) {
        await page.evaluate((n) => {
            const c = [...document.querySelectorAll('.channel-list .channel-name')].find(e => e.textContent.trim() === n);
            c?.click();
        }, channelName);
        await sleep(800);
        const navs = page.locator('.mobile-nav-btn');
        if (await navs.count() >= 3 && !(await page.locator(COMPOSER).isVisible().catch(() => false))) {
            await navs.nth(2).tap().catch(() => {});
            await sleep(600);
        }
    }
    await page.locator(COMPOSER).waitFor({ timeout: 20000 });
}

try {
    // ── The fixture, posted from a desktop through the real composer.
    const dCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const D = await signIn(dCtx, 'desktop', true);
    const srvName = 'OVL ' + stamp.slice(-4);
    const srv = await call(D, '/src/api/servers.ts', 'createServer', [srvName]);
    const chans = await call(D, '/src/api/servers.ts', 'listChannels', [srv.id]);
    const text = chans.find(c => c.channel_type === 0);
    check('setup: a server with a text channel', !!text, chans.map(c => `${c.name}:${c.channel_type}`).join(','));
    await D.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(D);
    await openChannel(D, srvName, text.name, false);

    // The owner's screenshot, line for line, then every kind of media.
    for (const line of ['Stream the rat.', 'STREAM', 'THE', 'RAT', 'can he go in tunnels?']) await say(D, line);

    const png = await D.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 640; c.height = 420;
        const x = c.getContext('2d');
        const g = x.createLinearGradient(0, 0, 640, 420);
        g.addColorStop(0, '#6b4f3a'); g.addColorStop(1, '#c9b49a');
        x.fillStyle = g; x.fillRect(0, 0, 640, 420);
        x.fillStyle = '#2a2a2a'; x.beginPath(); x.ellipse(320, 230, 170, 90, 0, 0, Math.PI * 2); x.fill();
        const b = await new Promise(r => c.toBlob(r, 'image/png'));
        const u8 = new Uint8Array(await b.arrayBuffer());
        let s = ''; for (const v of u8) s += String.fromCharCode(v);
        return btoa(s);
    });
    await attach(D, { name: 'rat.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const imgId = await D.evaluate(() => [...document.querySelectorAll('.messages-container > .message')].pop()?.id.replace(/^msg-/, ''));
    await call(D, '/src/api/reactions.ts', 'addReaction', [imgId, '\u{1F44D}']);
    await say(D, 'a line after the image');

    // A real WebM made in the page (canvas -> MediaRecorder); the app embeds
    // it in its inline <video> player. Recorded from a canvas: no audio track.
    const webm = await D.evaluate(async () => {
        const c = document.createElement('canvas');
        c.width = 320; c.height = 240;
        const x = c.getContext('2d');
        const stream = c.captureStream(15);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        const parts = [];
        rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
        const done = new Promise(r => { rec.onstop = r; });
        rec.start(100);
        const t0 = performance.now();
        await new Promise(res => {
            const tick = () => {
                const t = performance.now() - t0;
                x.fillStyle = `hsl(${(t / 5) % 360} 60% 45%)`; x.fillRect(0, 0, 320, 240);
                x.fillStyle = '#fff'; x.fillRect((t / 4) % 300, 100, 20, 20);
                if (t < 1500) requestAnimationFrame(tick); else res();
            };
            tick();
        });
        rec.stop();
        await done;
        const b = new Blob(parts, { type: 'video/webm' });
        const u8 = new Uint8Array(await b.arrayBuffer());
        let s = ''; for (const v of u8) s += String.fromCharCode(v);
        return btoa(s);
    });
    await attach(D, { name: 'tunnel.webm', mimeType: 'video/webm', buffer: Buffer.from(webm, 'base64') });
    await say(D, 'a line after the video');

    // A Puca clip plate. The ref is built by the app's own encoder; nothing
    // fetches its parts unless Play is pressed, and nothing presses it.
    const clipRef = await D.evaluate(async () => {
        const m = await import('/src/api/clips/clipRef.ts');
        const uuid = () => crypto.randomUUID();
        return m.encodeClipRef({
            key: crypto.getRandomValues(new Uint8Array(32)),
            noncePrefix: crypto.getRandomValues(new Uint8Array(8)),
            clipId: uuid(), videoCodec: 'avc1.640029', audioCodec: 'opus',
            durationMs: 30000, width: 1920, height: 1080, totalCipherBytes: 12_000_000,
            parts: [uuid(), uuid(), uuid()], partDurMs: [0, 15000, 15000],
        });
    });
    await say(D, `[Clip 0:30](${clipRef})`);
    await say(D, 'a line after the clip');
    await say(D, 'https://example.invalid/rat.png');
    await say(D, 'a line after the blocked image');
    // Spoilered in the composer, as a person does it: the image is covered
    // (blurred, scaled 1.08 inside the spoiler's clip) until clicked, and
    // nothing here clicks it.
    await attach(D, { name: 'spoiler.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }, { spoiler: true });
    await say(D, 'a line after the spoiler');

    // A reply starts a new header row (replies never group): through the
    // hover toolbar's Reply, as a person does it. One more line groups under it.
    const first = D.locator('.messages-container > .message').first();
    await first.scrollIntoViewIfNeeded();
    await first.hover();
    await first.locator('.msg-action-btn[title="Reply"]').click();
    await D.locator('.reply-preview-banner').waitFor({ timeout: 5000 });
    await say(D, 'replying to the first one');
    await say(D, 'and a line under the reply');

    // A second member posts one line, which the poster then blocks: it reads
    // back as the "Blocked message" stub row. One more line from the poster
    // follows it (a new header row - the stub's author is someone else).
    const bCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const B = await signIn(bCtx, 'member', true, 'ovlb_' + stamp);
    const inv = await call(D, '/src/api/servers.ts', 'createInvite', [srv.id, {}]);
    await call(B, '/src/api/servers.ts', 'joinViaInvite', [inv.code]);
    await B.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(B);
    await openChannel(B, srvName, text.name, false);
    await say(B, 'a line from someone you will block');
    const subOf = (page) => page.evaluate(() => Number(JSON.parse(atob(localStorage.getItem('auth_token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub));
    const bId = await subOf(B);
    await bCtx.close();
    await until(async () => (await rowCount(D)) >= CHANNEL_FIXTURE.rows - 1, 15000);
    await say(D, 'a line after the blocked one');
    await call(D, '/src/api/blocking.ts', 'blockUser', [bId]);
    await sleep(1000);

    // Read it back the way every other reader does: from the server.
    await D.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(D);
    await openChannel(D, srvName, text.name, false);
    await until(async () => (await rowCount(D)) >= CHANNEL_FIXTURE.rows, 15000);

    // ── Desktop 1280x800, normal then compact.
    check('desktop: normal density', (await setCompact(D, false)) === 'false');
    await runConfig(D, 'desktop-normal', { hover: true, fx: CHANNEL_FIXTURE, runGap: RUN_GAP.normal });
    check('desktop: compact density', (await setCompact(D, true)) === 'true');
    await runConfig(D, 'desktop-compact', { hover: true, fx: CHANNEL_FIXTURE, runGap: RUN_GAP.compact });
    await setCompact(D, false);

    // ── A DM renders the same rows from its own branch of Chat.tsx: your
    // conversation with yourself, the same run, through the same composer.
    const conv = await call(D, '/src/api/dms.ts', 'startDMConversation', [await subOf(D)]);
    check('setup: a conversation with yourself', !!conv?.id);
    await D.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await dismiss(D);
    await D.locator('.server-icon[title="Direct Messages"]').click();
    await sleep(800);
    await D.locator('.dm-item').first().click();
    await D.locator(COMPOSER).waitFor({ timeout: 20000 });
    check('the DM composer is open', /^Message @/.test(await D.locator(COMPOSER).getAttribute('placeholder') || ''));
    for (const line of ['Stream the rat.', 'STREAM', 'THE', 'RAT', 'can he go in tunnels?']) await say(D, line);
    await attach(D, { name: 'rat.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    check('DM: normal density', (await setCompact(D, false)) === 'false');
    await runConfig(D, 'dm-desktop-normal', { hover: true, fx: DM_FIXTURE, runGap: RUN_GAP.normal });
    check('DM: compact density', (await setCompact(D, true)) === 'true');
    await runConfig(D, 'dm-desktop-compact', { hover: true, fx: DM_FIXTURE, runGap: RUN_GAP.compact });
    await setCompact(D, false);

    // ── Phone 390x844, coarse pointer: the same account, signed in on a phone.
    const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const P = await signIn(pCtx, 'phone', false);
    await openChannel(P, srvName, text.name, true);
    check('phone: coarse pointer', await P.evaluate(() => matchMedia('(pointer: coarse)').matches));
    check('phone: normal density', (await setCompact(P, false)) === 'false');
    await runConfig(P, 'phone-normal', { hover: false, fx: CHANNEL_FIXTURE, runGap: RUN_GAP.normal });
    check('phone: compact density', (await setCompact(P, true)) === 'true');
    await runConfig(P, 'phone-compact', { hover: false, fx: CHANNEL_FIXTURE, runGap: RUN_GAP.compact });
    await setCompact(P, false);
} catch (e) {
    check('the walk ran to the end', false, String(e).split('\n')[0]);
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures);
