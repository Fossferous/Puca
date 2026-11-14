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
//   4. every component in the app on Light, inside the elements of each place it is used (skeleton's
//      placesOf: up to PLACES_PER_COMPONENT call sites, what a parent puts around its children, JSX
//      held in a local or made by a helper where it is named, a portal on the page), in each arm of
//      every branch and each value a class from data can take (skeleton's dataVariants), with the
//      elements around it in the same arm, with and without High Contrast, at both sizes, and again
//      at 1280x800 with every :hover and :focus on: the same 4.5:1 and 3:1, with opacity counted
//      (dimmed words are read dimmed), past the two entries in NOT_AS_DRAWN, each with its reason.
//      Until 2026-11-14 this held only 3:1 and only where the dark theme held, at rest, ignored
//      opacity and data classes, and read each component on the chat's paper: the role editor's
//      panels inside Light's Server Settings and the call's encryption badge (1.03:1) went unseen;
//   5. NEGATIVE CONTROLS. OLD_LIGHT is Light's colours as they were: every surface must fail on it,
//      or the checks above prove nothing, and the whole-app sweep must report it. OLD_SHARED does the
//      same for the words that were below the bar on every theme. LIGHT_AT_RAISE is Light as it was
//      before (4) was raised: every place fixed then must fail the raised sweep on it. A colour this
//      cannot read fails the run rather than being skipped (color-mix() once went unread that way,
//      and passed).
//
// With an outdir: a screenshot of every real mount on Light, as it is and with OLD_LIGHT, and on the
// worst look of the seven other themes. No server, no build. Headless and silent.

import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { armsIn, dataVariants, inPlace, placesOf, readJsx, toHtml } from './theme-surfaces/skeleton.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const outDir = process.argv[2] || null;
if (outDir) mkdirSync(outDir, { recursive: true });
const workDir = join(here, '..', 'node_modules', '.tmp', 'light-surfaces');
mkdirSync(workDir, { recursive: true });

const THEMES = ['light', 'dark', 'amoled', 'pink', 'purple', 'green', 'orange', 'yellow'];
const CONTRASTS = ['normal', 'high'];
const LOOKS = THEMES.flatMap(theme => CONTRASTS.map(contrast => [theme, contrast]));
// The sweep reads each component in up to this many of the places it is used (the first, in the
// order the source has them). Of the components used in more, most are icons and small wrappers.
const PLACES_PER_COMPONENT = 8;

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
/* #6d6f78: the dark themes' --text-faint until 2026-11-12, now itself 4.5:1 (theme.css). */
.notes-popover h4, .notes-labels-hint, .nick-edit-modal .settings-hint { color: #6d6f78 !important; }
.link-preview-site { color: #6c7086 !important; }
.sched-btn.primary, .sched-seg button.on, .notes-update-strip-btn { background: var(--brand-primary) !important; }
.nick-edit-actions .save-btn { background: var(--brand-primary) !important; color: var(--bg-primary) !important; }
`;
// In the whole-app sweep, what is not drawn as the skeleton has it: a class, each one read and
// reasoned, in place of a filter that could hide the next real one. file:line is not used, as it
// would rot. The skeleton reads JSX and nothing that runs, so these two it cannot see as drawn.
const NOT_AS_DRAWN = [
    ['member-role-badge', 'its paper is the role\'s own colour, set from JavaScript (style={{ backgroundColor: ... }})'],
    ['notes-editor-backdrop', 'it has no words of its own: what is in braces in it is {undo.bar}, the undo bar a hook hands it, read as .notes-undo above'],
];
// Light as it was before this file held the sweep to the full bar (2026-11-14, when it allowed
// anything above 3:1 and anything the dark theme also failed): every place in RAISED was below the
// bar then and must fail on it again, with and without High Contrast, or the sweep proves nothing.
// The fill tokens Light now defines, the role editor's words that were Light's, the rules
// lightTheme.css now answers, and the fixed colours since raised where they are drawn.
const LIGHT_AT_RAISE = `
[data-theme="light"] { --color-danger: #f23f43 !important; --color-success: #23a55a !important; --accent-lavender: #a78bfa !important; --status-offline: #80848e !important; --text-warning: #8a5a00 !important; }
.message-link { color: var(--mode-brand-text, var(--brand-primary)) !important; }
.message-content.task-completed, .cal-row.done .cal-row-title, .gseat-folded { opacity: 0.6 !important; }
.cal-chip.done { opacity: 0.55 !important; }
.cal-cell.other, .option-hint-dim, .device-wake-countdown { opacity: 0.75 !important; }
.tt-sched.ended, .blocked-message-stub, .message-attachment.loading { opacity: 0.7 !important; }
.sub-icon { opacity: 0.6 !important; }
.update-banner { background: linear-gradient(135deg, #4752c4 0%, #5865f2 100%) !important; }
.member-item.offline .member-avatar { opacity: 0.5 !important; }
.pcard-muted { opacity: 0.45 !important; filter: none !important; }
.clip-duration-chip-size { opacity: 0.8 !important; }
.user-profile-popup .friend-btn.pending { color: #8e9297 !important; }
.voice-e2ee.on { color: #b8f5c8 !important; background: rgba(36, 128, 70, 0.18) !important; }
.voice-e2ee.partial { color: #ffe0a3 !important; background: rgba(191, 149, 60, 0.18) !important; }
.voice-e2ee.off { color: #ffc4c4 !important; background: rgba(191, 60, 60, 0.15) !important; }
.user-profile-popup .verify-btn.changed { color: #ffc4c4 !important; }
button.ta-file.saved { color: #7fd18b !important; } button.ta-file.error { color: #ffb4b4 !important; }
.report-badge.spam, .audit-badge.kick, .report-status.pending { color: #f0b232 !important; }
.report-badge.harassment, .audit-badge.ban { color: #f04747 !important; }
.report-badge.inappropriate { color: #eb459e !important; } .report-status.resolved { color: #23a55a !important; }
.user-profile-bar .user-status.idle, .user-profile-bar .user-status.away, .active-status.idle, .active-status.away { color: var(--status-idle) !important; }
.cal-chip-time, .cal-chip-span { color: var(--text-muted) !important; }
.attachment-saved { opacity: 0.75 !important; }
[data-theme="light"] .role-editor-embedded {
    --text-normal: #313338 !important; --text-muted: #5a5c64 !important; --text-faint: #62656e !important;
    --header-primary: #060607 !important; --header-secondary: #4e5058 !important; color: #313338 !important;
}
[data-theme="light"][data-contrast="high"] .role-editor-embedded { --text-normal: #000 !important; --text-muted: #26282d !important; --text-faint: #43464e !important; color: #000 !important; }
.server-settings-nav .nav-item.active { background: rgba(79, 84, 92, 0.6) !important; color: #fff !important; }
.voice-controls-compact, .voice-clip-status { background: rgba(0, 0, 0, 0.2) !important; }
.voice-error-mini { background: rgba(237, 66, 69, 0.2) !important; color: #ed4245 !important; }
.voice-e2ee-blocked { background: rgba(191, 60, 60, 0.15) !important; color: #ffc4c4 !important; }
.voice-e2ee-warning { background: rgba(191, 130, 40, 0.15) !important; }
.reply-preview-banner .replying-to strong, .typing-dots, .note-link, .nb-conflict-actions button, .nb-retry, .app-version { color: var(--brand-primary) !important; }
.message-author, .message-reply-ref .reply-author { color: var(--mode-brand-text, var(--brand-primary)) !important; }
.channel-perms-role-flag { color: var(--accent-color, #5865f2) !important; }
.settings-close-hint { color: var(--text-faint) !important; }
.xfer-ok { color: #3ba55d !important; } .xfer-bad { color: #ed4245 !important; }
.settings-hint.settings-hint-live { color: #a6e3a1 !important; }
.settings-coming-soon { color: #a6adc8 !important; } .settings-coming-soon h4 { color: #cdd6f4 !important; }
.own-voice-banner-btn.leave { background: rgba(237, 66, 69, 0.9) !important; }
.user-profile-popup .upp-status.idle, .user-profile-popup .upp-status.away { color: var(--status-idle) !important; }
.autocomplete-item.active .ac-hash { color: var(--text-muted, #949ba4) !important; }
.autocomplete-item.active .ac-sub { color: rgba(255, 255, 255, 0.75) !important; }
.jump-latest-pill { background: linear-gradient(135deg, #7c3aed 0%, #4cc4ff 100%) !important; }
.live-badge-mini, .server-unread-bubble { background: #ed4245 !important; }
.watch-live-btn, .watch-streams-btn { background: linear-gradient(135deg, #ed4245, #dc3545) !important; }
.vs-live-badge { background: var(--text-danger, #f23f43) !important; }
.live-indicator, .permission-reset-btn { background: linear-gradient(135deg, #ed4245, #ff6b6b) !important; }
.permission-retry-btn, .error-buttons button.primary { background: linear-gradient(135deg, #7c3aed 0%, #00d9ff 100%) !important; }
.notes-dialog-body .notes-textbtn.primary { background: var(--brand-active) !important; color: var(--brand-primary) !important; }
.login-title { background-image: linear-gradient(90deg, #00d9ff, #7c3aed, #ff6b9d) !important; }
.login-button { background-image: linear-gradient(135deg, var(--login-accent-2, #7c3aed) 0%, var(--login-accent, #00d9ff) 100%) !important; }
.login-subtitle, .forgot-password-link { color: rgba(255, 255, 255, 0.5) !important; }
.login-container .form-group label, .notes-login-note, .notes-stay-hint { color: var(--text-muted) !important; }
.notes-login-note a { color: var(--text-link) !important; }
.login-container .error-message { color: #f04747 !important; }
.login-container .loading-spinner { color: #9399b2 !important; }
.login-container .success-message { color: var(--color-success, #23a55a) !important; }
.connection-error .connection-error-hint { color: #7f849c !important; }
.service-update-banner { background: linear-gradient(135deg, #3b6ea5 0%, #4f8bc9 100%) !important; }
.update-gate h2 { background-image: linear-gradient(135deg, #7289da, #5865f2) !important; }
.welcome-popup-header h2 { background-image: linear-gradient(135deg, #5865f2, #eb459e) !important; }
.device-stage-hint kbd { color: inherit !important; }
.device-stage-mobile-toolbar-toggle, .mouse-mode-btn.active { background-color: #1e88e5 !important; }
.keyboard-btn.kb-locked { background: #1e88e5 !important; }
.mouse-mode-btn.inactive { color: #b9bbbe !important; }
.device-stage-mobile-menu-item.danger .label { color: var(--color-danger, #ed4245) !important; }
.device-stage-mobile-confirm-btn.danger { background: var(--color-danger, #ed4245) !important; }
.device-stage-minimized { background: #007aff !important; }
.host-files-indicator-stop { background: var(--danger, #f04747) !important; }
.role-error, .confirm-delete-btn { background: #f04747 !important; }
.delete-role-btn { color: #f04747 !important; }
.role-hint, .permission-desc, .no-role-selected p { color: var(--text-faint) !important; }
.role-loading { color: #8e9297 !important; }
.role-modal-content .cancel-btn { color: var(--text-muted) !important; }
.invite-preview-icon, .discover-card-icon { background: linear-gradient(135deg, var(--brand-primary), var(--accent-pink)) !important; }
.discover-empty-hint, .discover-member-count { color: #72767d !important; }
.join-error { color: var(--color-danger) !important; }
.recovery-word-num { color: #6d6f78 !important; }
.stream-audio-error { color: var(--text-danger, #f23f43) !important; }
`;
// A class, or a file where no class names the place.
const RAISED = [
    // Light's own: the fill tokens, the rules in styles/lightTheme.css, the role editor's words.
    'nav-item active', 'voice-clip-status-text', 'voice-clip-link', 'voice-clip-save', 'voice-clip-arm', 'voice-error-mini',
    'reply-author', 'message-author', 'typing-dots', 'note-link', 'nb-retry', 'app-version', 'channel-perms-role-flag',
    'settings-close-hint', 'xfer-ok', 'xfer-bad', 'settings-hint-live', 'OwnVoiceBanner.tsx', 'upp-status',
    'unread-badge', 'secondary-btn active', 'danger-btn', 'add-friend-btn', 'copy-btn copied', 'friend-btn add',
    'add-status success', 'profile-success', 'profile-error', 'report-error', 'forward-error', 'save-note-error',
    'ban-btn', 'notes-badge', 'identity-banner-btn', 'dm-avatar', 'friend-avatar', 'avatar-placeholder', 'create-btn',
    'role-name', 'color-custom', 'role-hint', 'permission-desc', 'cancel-btn', 'delete-role-btn', 'role-error', 'role-loading',
    // Fixed colours, the same on every theme, raised where they are drawn.
    'ac-hash', 'ac-sub', 'jump-latest-pill', 'live-badge-mini', 'watch-live-btn', 'server-unread-bubble', 'vs-live-badge',
    'live-indicator', 'permission-reset-btn', 'permission-retry-btn', 'notes-textbtn primary', 'login-button', 'login-title',
    'login-subtitle', 'forgot-password-link', 'error-message', 'success-message', 'notes-login-note', 'notes-stay-hint',
    'connection-error-hint', 'update-later-btn', 'UpdateGate.tsx', 'WelcomePopup.tsx', 'ServiceUpdateBanner.tsx',
    'mouse-mode-btn', 'keyboard-btn', 'device-stage-mobile-confirm-btn', 'DeviceStageMobileMenus.tsx', 'DeviceStage.tsx',
    'host-files-indicator-stop', 'discover-empty-hint', 'discover-member-count', 'join-error', 'invite-preview-icon',
    'recovery-word-num', 'stream-audio-error',
    // Found once each component was read in its places, in each arm, and with opacity.
    'message-link', 'mention everyone', 'clip-attachment-broken', 'task-completed', 'cal-chip done', 'cal-row-title',
    'blocked-message-stub', 'option-hint-dim', 'device-wake-countdown', 'gseat-name', 'PlayingCard.tsx',
    'clip-duration-chip-size', 'friend-btn pending', 'sub-icon', 'message-attachment loading', 'update-notes',
    // Found once a class from data was read in each value the stylesheet gives it.
    'voice-e2ee-label', 'verify-btn changed', 'ta-file saved', 'ta-file error', 'report-badge spam', 'audit-badge ban',
    'report-status pending', 'user-status idle', 'active-status away', 'cal-chip-time', 'attachment-saved',
];
// High Contrast's muted and faint words already held 4.5:1 at these, so they were below the bar
// without it only.
const NOT_WITH_HIGH_CONTRAST = new Set(['settings-close-hint', 'notes-login-note', 'notes-stay-hint', 'option-hint-dim', 'gseat-name']);

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
const jsx = readJsx(srcDir);
// What a class that comes from data can be, as the stylesheet the sweep reads under names it.
dataVariants(jsx, `${appCss}\n${inlineNotes}`);
const { components, all } = jsx;
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
// Every component's own JSX, unnested, inside the elements of each place it is used (placesOf):
// what a new surface would be caught by, read on what is drawn behind it there.
const sweep = [];
const placeOf = placesOf(jsx, { most: PLACES_PER_COMPONENT });
const nameOfPlace = place => place.slice(-2).map(({ tag, classes }) => `${tag}${classes.length ? `.${classes.join('.')}` : ''}`).join(' > ') || 'the page';
// App's own screens (connecting, the connection error) are on the page's body, which App.css paints
// the same dark on every theme; everything else is somewhere in the chat's container.
const onTheBody = [];
for (const node of Object.values(components).flat()) {
    // With its fixed classes, and with each arm of every branch (all the && on): .active is where a
    // colour moves. The elements around it take the same reading, so a row a mention marks is read
    // with what is in it.
    const picks = [{ steady: true }, ...Array.from({ length: armsIn(node) }, (_, arm) => ({ arm }))];
    for (const place of placeOf(node)) {
        for (const pick of picks) {
            const html = toHtml(node, {}, { ...pick, around: placeOf.around });
            if (html) (node.host === 'App' ? onTheBody : sweep).push(`<section data-sweep="1" data-from="${node.at}" data-in="${nameOfPlace(place).replace(/"/g, '&quot;')}">${inPlace(place, html, pick)}</section>`);
        }
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
const sweepUrl = pageWith('sweep.html', `${onTheBody.join('\n')}${inApp(sweep.join('\n'))}`, STYLESHEETS[2][1]);
// The same with every :hover and :focus on: `:not(.__never)` matches as they would, with their weight.
const hovered = sheet => sheet.replace(/:(hover|focus-visible|focus-within|focus)(?![\w-])/g, ':not(.__never)');
const sweepHoveredUrl = pageWith('sweep-hovered.html', `${onTheBody.join('\n')}${inApp(sweep.join('\n'))}`, hovered(STYLESHEETS[2][1]));
const mountsUrl = pageWith('mounts.html', '<div id="root"></div>', mountsCss, mountsJs);
// The call's header as VoiceStage draws it, alone on a page, for a real pointer to rest on.
const callHeaders = instancesOf('.voice-stage-header');
if (!callHeaders.length) throw new Error('.voice-stage-header is no longer in the source: a rename? The pointer check has to follow it.');
const callHeaderUrl = pageWith('call-header.html', inApp(callHeaders.map(node => `<section data-from="${node.at}"><div class="voice-stage">${toHtml(node, components, { steady: true })}</div></section>`).join('\n')), STYLESHEETS[0][1]);

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
    // `memo` keeps each element's answer for one reading, so a deep tree costs one pass.
    const paints = (el, page, memo = new Map()) => {
        if (!el || el === document.documentElement) return [page.slice(0, 3)];
        if (memo.has(el)) return memo.get(el);
        const style = getComputedStyle(el);
        const stops = stopsOf(style.backgroundImage);
        const colour = parts(style.backgroundColor);
        let under;
        if (colour[3] >= 1) under = [colour.slice(0, 3)];
        else if (stops.length && stops.every(stop => stop[3] >= 1)) under = [[0, 0, 0]];
        else under = paints(el.parentElement, page, memo).map(below => (colour[3] > 0 ? over(colour, below) : below));
        const answer = stops.length ? under.flatMap(below => stops.map(stop => over(stop, below))) : under;
        memo.set(el, answer);
        return answer;
    };
    const paint = (el, page) => paints(el, page)[0];
    // Opacity: an element at opacity o paints all of itself, words and paper, at o over what is
    // behind it, so dimmed words are read dimmed (a done task's words at 0.6 were 3.71:1 on Light
    // where colours alone said 12.6). From 0.1 down it is a control shown elsewhere (one a hover
    // brings up), read as it is shown then. Nested ones multiply, over what is behind the outermost.
    // Not counted where the class says the control takes no press, as 1.4.3 exempts what cannot be
    // used (:disabled is skipped outright, below): `disabled` (a menu item or a sound that cannot
    // be chosen), `pending` (the clip button while it arms, a friend request already sent: both
    // disabled then), `busy` and `updating` (a refresh, a role's box while it saves), and
    // `dragging`, the item a drag is carrying, there for the drag and not to be read.
    const UNUSABLE = ['disabled', 'pending', 'busy', 'updating', 'dragging'];
    const dimOf = (el, dims) => {
        if (!el || el === document.documentElement) return { o: 1, top: null };
        if (dims.has(el)) return dims.get(el);
        // A popover or a modal dialog is in the top layer: what is around it in the markup dims nothing.
        const up = el.hasAttribute('data-top-layer') ? { o: 1, top: null } : dimOf(el.parentElement, dims);
        // What it would be without those classes: a calendar chip that is done and being dragged
        // is read as done.
        let own = parseFloat(getComputedStyle(el).opacity);
        const unusable = UNUSABLE.filter(name => el.classList.contains(name));
        if (unusable.length && own < 1) {
            el.classList.remove(...unusable);
            own = parseFloat(getComputedStyle(el).opacity);
            el.classList.add(...unusable);
        }
        const answer = own >= 0.1 && own < 1 ? { o: up.o * own, top: up.top ?? el } : up;
        dims.set(el, answer);
        return answer;
    };
    const hasWords = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    window.__measure = (root, page = pageColour(), memo = new Map(), dims = new Map()) => {
        const rows = [];
        const add = (el, kind, need) => {
            const style = getComputedStyle(el);
            const fill = parts(style.webkitTextFillColor || style.color);
            const stops = stopsOf(style.backgroundImage);
            // Words filled with their own gradient (background-clip: text, as the sign-in page's
            // title is): every stop is a colour of the words, and the paper is what is behind them.
            const clipped = stops.length && (style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text') && fill[3] === 0;
            // Words in no colour and over no gradient are painted for nobody (a field that only
            // takes a phone's keyboard). Over a gradient they are read, so a title whose
            // background-clip went missing reads as the 1:1 it is.
            if (fill[3] === 0 && !stops.length) return;
            const unders = clipped ? paints(el.parentElement, page, memo) : paints(el, page, memo);
            const dim = dimOf(el, dims);
            const behinds = dim.top ? paints(dim.top.parentElement, page, memo) : [null];
            const worst = unders
                .flatMap(under => (clipped ? stops : [fill]).flatMap(colour => behinds.map((behind) => {
                    let ink = over(colour, under);
                    let paper = under;
                    if (behind) { ink = over([...ink, dim.o], behind); paper = over([...paper, dim.o], behind); }
                    return { under: paper, ink, value: ratio(ink, paper) };
                })))
                .sort((a, b) => a.value - b.value)[0];
            rows.push({
                kind, need, at: el.getAttribute('data-at') || el.tagName, cls: String(el.className || '').slice(0, 60),
                dim: dim.top ? String(dim.top.className || '') : '',
                ratio: Math.round(worst.value * 100) / 100,
                ink: worst.ink.map(Math.round).join(','), under: worst.under.map(Math.round).join(','),
            });
        };
        for (const el of [root, ...root.querySelectorAll('*')]) {
            if (el.hasAttribute('data-icon')) continue;
            if (el.tagName === 'OPTION' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
            if (el.matches(':disabled')) continue; // 1.4.3 and 1.4.11 exempt a control that cannot be used
            if (el.closest('[data-hidden]')) continue; // style={{ display: 'none' }}: never shown
            // Visually hidden on purpose (.sr-only, a 2 px field that takes a phone's keyboard): not
            // painted for anyone to read. Its sizes as the stylesheet sets them, so this holds where
            // the skeleton's page does not lay it out.
            const size = getComputedStyle(el);
            if (parseFloat(size.width) <= 2 && parseFloat(size.height) <= 2) continue;
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
    window.__measureSections = (attr) => {
        const page = pageColour();
        const memo = new Map();
        const dims = new Map();
        return [...document.querySelectorAll(`section[${attr}]`)].flatMap(section => (
            window.__measure(section, page, memo, dims).map(row => ({
                ...row, surface: section.getAttribute(attr), from: section.getAttribute('data-from'),
                ...(section.hasAttribute('data-in') ? { in: section.getAttribute('data-in') } : {}),
            }))
        ));
    };
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

// 4. Every component, where it is drawn, on Light: the same bar as the surfaces above, with and
// without High Contrast, at both sizes.
{
    console.log('\nevery component in the app, where it is drawn, on Light');
    // The rows under the bar no entry of NOT_AS_DRAWN excuses. Only the readings of Light as it is
    // mark an entry used, so one that stops excusing a failure there is reported as stale.
    const used = new Set();
    const unexcused = (rows, mark) => below(rows).filter((row) => {
        const entry = NOT_AS_DRAWN.find(([name]) => row.cls.split(' ').includes(name));
        if (entry && mark) used.add(entry[0]);
        return !entry;
    });
    const read = async (page, look) => {
        await page.evaluate(l => window.__look(l), look);
        return (await page.evaluate(() => window.__measureSections('data-sweep'))).map(row => ({ ...row, surface: `in ${row.in}` }));
    };
    const failing = rows => unexcused(rows, false);
    // A needle of RAISED: a file's name, or classes every one of which the place has, or what dims
    // it with opacity has (a done task dims all the words in it).
    const isAt = (needle, row) => (needle.endsWith('.tsx')
        ? row.at.split(':')[0].split('/').pop() === needle
        : [row.cls, row.dim].some(classes => needle.split(' ').every(word => classes.split(' ').includes(word))));
    let readings = 0;
    const byLook = [];
    for (const [name, options] of [
        ['1280x800', { viewport: { width: 1280, height: 800 } }],
        ['390x844 touch', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
    ]) {
        const { page, close } = await open(sweepUrl, options);
        if (name.startsWith('390')) check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'CONTROL: this is a coarse pointer');
        for (const contrast of CONTRASTS) {
            const rows = await read(page, ['light', contrast]);
            readings += rows.length;
            byLook.push([`light/${contrast} ${name}`, unexcused(rows, true)]);
        }
        if (name.startsWith('1280')) {
            // 5. The controls: Light as it was in 0.9.855 ...
            await page.evaluate(sheet => window.__old(sheet), OLD_LIGHT + OLD_DARK_SURFACES);
            const old = new Set(failing(await read(page, ['light', 'normal'])).map(row => `${row.at} ${row.cls}`));
            check(old.size >= 300, 'CONTROL: the sweep finds Light as it was in 0.9.855', `${old.size} places`);
            // ... and as it was before this bar was raised: every place fixed then fails again.
            await page.evaluate(sheet => window.__old(sheet), LIGHT_AT_RAISE);
            for (const contrast of CONTRASTS) {
                const then = failing(await read(page, ['light', contrast]));
                const places = new Set(then.map(row => `${row.at} ${row.cls}`)).size;
                const fixed = RAISED.filter(needle => contrast === 'normal' || !NOT_WITH_HIGH_CONTRAST.has(needle));
                const held = fixed.filter(needle => !then.some(row => isAt(needle, row)));
                check(held.length === 0, `CONTROL: Light's colours before the bar was raised fail it (${contrast}), at ${places} places, each of the ${fixed.length} fixed then among them`, held.length ? `these still pass: ${held.join(' ')}` : '');
            }
            await page.evaluate(() => window.__old(''));
        }
        await close();
    }
    // Under a mouse and with the keyboard's focus: the same sweep with every :hover and :focus rule
    // on, each selector keeping its weight. A pointer resting on something hovers all around it too,
    // so those come on together, as they do. 1280x800, where there is a mouse.
    {
        const { page, close } = await open(sweepHoveredUrl);
        check(await page.evaluate(() => [...document.styleSheets].every(sheet => [...sheet.cssRules].every(rule => !/:hover|:focus/.test(rule.cssText)))), 'CONTROL: no :hover or :focus is left to wait for a pointer in the hovered sweep');
        for (const contrast of CONTRASTS) {
            const rows = await read(page, ['light', contrast]);
            readings += rows.length;
            byLook.push([`light/${contrast} 1280x800 hovered and focused`, unexcused(rows, true)]);
        }
        // CONTROL: Settings' Log Out under the pointer as it was (white words on a faint pink).
        await page.evaluate(sheet => window.__old(sheet), '.settings-modal .danger-btn:not(.__never) { color: #fff !important; background: rgba(243, 139, 168, 0.1) !important; }');
        const then = failing(await read(page, ['light', 'normal']));
        check(then.some(row => row.cls.split(' ').includes('danger-btn')), 'CONTROL: the hovered sweep finds a button whose words go white under the pointer on Light', `${then.length} places`);
        await page.evaluate(() => window.__old(''));
        await close();
    }
    const stale = NOT_AS_DRAWN.filter(([name]) => !used.has(name)).map(([name]) => name);
    check(stale.length === 0, 'and every entry of the list of what is not drawn as the skeleton has it still explains something', stale.join(' '));
    const poor = collect(byLook);
    for (const { worst, looks } of poor) console.log(describe(worst, looks));
    check(poor.length === 0, `every run of words 4.5:1 and every icon-only control 3:1 on Light, with and without high contrast, at both sizes, in ${readings} readings of ${sweep.length + onTheBody.length} blocks of the app's JSX where they are drawn (past ${NOT_AS_DRAWN.length} explained)`, `${poor.length} below`);
}

// 6. What a reading of words cannot see.
{
    console.log('\nfields in a form, and the call\'s header under the pointer');
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

    // VoiceStage.css whitens the words of the header's buttons under a mouse, for a dark header.
    const header = await open(callHeaderUrl);
    const buttons = header.page.locator('.voice-stage-header .voice-stage-btn');
    const count = await buttons.count();
    const pointedAt = async () => {
        const byLook = [];
        for (let i = 0; i < count; i++) {
            await buttons.nth(i).hover();
            for (const look of LOOKS) {
                await header.page.evaluate(l => window.__look(l), look);
                byLook.push([look.join('/'), await buttons.nth(i).evaluate(el => window.__measure(el).map(row => ({ ...row, surface: 'call header, under the pointer' })))]);
            }
        }
        await header.page.mouse.move(0, 0);
        return byLook;
    };
    check(await header.page.evaluate(() => matchMedia('(pointer: fine)').matches), 'CONTROL: this is a mouse, which the hover is for');
    const poor = collect(await pointedAt());
    for (const { worst, looks } of poor) console.log(describe(worst, looks));
    check(count >= 2 && poor.length === 0, `the call header's ${count} buttons hold the bar under the pointer on every look`, `${poor.length} below`);
    await header.page.evaluate(sheet => window.__old(sheet), '[data-theme="light"] .voice-stage-header .voice-stage-btn:hover { background: rgba(255, 255, 255, 0.08) !important; color: #fff !important; }');
    const poorThen = collect(await pointedAt());
    check(poorThen.some(({ looks }) => looks.includes('light/normal') && looks.includes('light/high')), 'CONTROL: VoiceStage.css\'s own hover fails on Light\'s header, with and without high contrast', poorThen.map(({ worst }) => `${worst.ratio}:1`).join(' '));
    await header.page.evaluate(() => window.__old(''));
    check(header.errors.length === 0, 'and no page error', header.errors.slice(0, 3).join('; '));
    await header.close();
}

// The file of Light's rules cannot reach another theme.
{
    const lightSheet = readFileSync(join(srcDir, 'styles', 'lightTheme.css'), 'utf8');
    // A media query only says when; the rules in it are read as any other.
    const strays = lightSheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}').flatMap(rule => rule.split('{')[0].split(','))
        .map(selector => selector.trim()).filter(Boolean).filter(selector => !selector.startsWith('[data-theme="light"]'));
    check(strays.length === 0, 'every selector in styles/lightTheme.css starts at [data-theme="light"]', strays.join(' | '));
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
