#!/usr/bin/env node
/**
 * Fails if an emoji reappears in UI chrome.
 *
 * The app's iconography lives in src/components/Icons.tsx (see
 * docs/ICON_LANGUAGE.md). Emoji were what it used before: they render in the
 * host font so the same button is a different picture on every platform, they
 * are full-colour bitmaps that ignore all eight themes and the high-contrast
 * modifier, and they overflow their em box by a different amount per glyph so a
 * row of them never optically aligns.
 *
 * Emoji as *content* are fine and are what the allowances below cover — the
 * picker's dataset, the :shortcode: map, reactions. If you are adding one of
 * those, wrap it:
 *
 *     // icon-lint:allow-emoji — these are the picker's data, not chrome
 *     ...
 *     // icon-lint:end
 *
 * and say why in the reason. A bare allowance with no reason is rejected, so
 * the next person can tell content from a shortcut.
 *
 * Run: node scripts/check-no-ui-emoji.mjs   (also chained into `npm run lint`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html']);

/**
 * Whole files that are emoji data by definition. Keep this list SHORT — a file
 * added here stops being checked forever, which is how the rule rots.
 */
const ALLOW_FILES = new Map([
    ['api/emojis.ts', 'the emoji picker dataset — ~1200 glyphs the user picks from'],
]);

/** Tests assert on content, including emoji content. */
const SKIP_DIRS = ['tests'];

const OPEN = /\/[/*]\s*icon-lint:allow-emoji\s*(?:[—–-]\s*(.+?))?\s*(?:\*\/)?$/;
const CLOSE = /icon-lint:end/;
/**
 * Characters that carry Extended_Pictographic but are typography, not
 * iconography:
 *
 *   © ® ™  — a copyright line is text; no icon should replace it.
 *   ↔ ↕    — prose punctuation meaning "between", as in
 *            "servers ↔ channels ↔ chat". Unicode is simply inconsistent
 *            here: → (U+2192) is used the same way throughout this codebase
 *            and is NOT Extended_Pictographic, so flagging only the
 *            bidirectional ones would be arbitrary. Neither is used as a
 *            control anywhere; ↩ and ↪ deliberately stay flagged, because
 *            those WERE the reply and forward buttons.
 */
const TEXT_SYMBOLS = /[©®™↔↕]/gu;
const EMOJI = /\p{Extended_Pictographic}/u;
const stripTextSymbols = (s) => s.replace(TEXT_SYMBOLS, '');

/**
 * Typographic glyphs used as icons. These are NOT emoji — they carry no
 * Extended_Pictographic property — which is exactly why they survived the first
 * pass: 30 close buttons rendering as host-font "✕" next to SVG icons
 * everywhere else.
 *
 * `×` (U+00D7) is deliberately absent from the character class and handled
 * separately below: "1920×1080" and "cover × zoom" are legitimate prose, so
 * flagging every occurrence would make the gate unpassable.
 */
/* ➤ (U+27A4) earned its place here the hard way: it is not
   Extended_Pictographic, so the mobile Send button shipped as a raw CSS
   `content: "➤"` glyph that ignored all eight themes, and this gate never
   saw it. */
const GLYPH_ICON = /[✕✔✓▲▼◀▶＋－⋮⋯➤]/u;

/**
 * A glyph sitting alone as an element's entire text content: >✕< or {'×'}.
 *
 * Arrows are only checked in this position, never by bare presence: "member id
 * → display name" is this codebase's normal comment style, but
 * `<button>← Back</button>` is a control wearing a character.
 */
const GLYPH_AS_CHILD =
    />\s*[✕✔✓▲▼◀▶＋－×⋮⋯➤←→↑↓]\s*(?:[A-Za-z][^<]*)?<|[{]\s*'[✕✔✓▲▼◀▶＋－×⋮⋯➤←→↑↓]'\s*[}]/u;

/**
 * `&times;` and friends are the same close button wearing a disguise — they
 * survive a Unicode scan because the source holds seven ASCII characters.
 */
const GLYPH_ENTITY = /&(?:times|#215|#xD7|#x27E1|#10005);/i;

const files = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.includes(entry.name)) continue;
            walk(full);
        } else if (EXT.has(path.extname(entry.name))) {
            files.push(full);
        }
    }
})(SRC);

const violations = [];
const unreasoned = [];
let allowedRegions = 0;

for (const file of files) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    if (ALLOW_FILES.has(rel)) continue;

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let open = false;

    lines.forEach((line, i) => {
        const openMatch = OPEN.exec(line.trim());
        if (openMatch) {
            open = true;
            allowedRegions++;
            if (!openMatch[1]) unreasoned.push(`${rel}:${i + 1}  allow-emoji with no reason given`);
            return;
        }
        if (open) {
            if (CLOSE.test(line)) open = false;
            return;
        }
        const scannable = stripTextSymbols(line);
        if (EMOJI.test(scannable)) {
            const glyphs = [...new Set(scannable.match(/\p{Extended_Pictographic}/gu))].join(' ');
            violations.push(`${rel}:${i + 1}  emoji ${glyphs}   ${line.trim().slice(0, 84)}`);
            return;
        }

        const trimmed = line.trim();
        if (GLYPH_ICON.test(line) || GLYPH_AS_CHILD.test(line) || GLYPH_ENTITY.test(line) || trimmed === '×') {
            const glyphs = [...new Set(line.match(/[✕✔✓▲▼◀▶＋－×⋮⋯➤←→↑↓]/gu) ?? [])].join(' ')
                || (GLYPH_ENTITY.exec(line) ?? [''])[0];
            violations.push(`${rel}:${i + 1}  glyph ${glyphs}   ${trimmed.slice(0, 84)}`);
        }
    });

    if (open) violations.push(`${rel}  icon-lint:allow-emoji opened but never closed`);
}

if (violations.length || unreasoned.length) {
    console.error('\nGlyphs used as iconography. Use an icon from src/components/Icons.tsx');
    console.error('(docs/ICON_LANGUAGE.md), or mark the region as content with');
    console.error('`// icon-lint:allow-emoji — why` … `// icon-lint:end`.');
    console.error('"emoji" = a colour glyph from the host font; "glyph" = a typographic');
    console.error('mark such as ✕ or ✓ standing in for an icon.\n');
    for (const v of violations) console.error('  ' + v);
    for (const u of unreasoned) console.error('  ' + u);
    console.error(`\n${violations.length + unreasoned.length} problem(s).`);
    process.exit(1);
}

console.log(
    `check-no-ui-emoji: clean — ${files.length} files scanned, ` +
    `${ALLOW_FILES.size} allowed file(s), ${allowedRegions} allowed region(s).`
);
