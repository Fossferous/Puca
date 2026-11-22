# Púca Design Philosophy — one frontend, two pointer worlds

Púca ships **one React codebase to three shells**: Tauri (Windows desktop),
Capacitor (Android/iOS), and the plain browser (app.example.com). There is no
separate mobile app to keep in sync — which means **every surface you add is a
mobile surface the moment you merge it.** This document exists because we once
shipped a string of desktop-shaped features (Friends dashboard, settings
modals, checklist drawer, voice panel) that were unusable on phones, and then
spent a release un-breaking all of them at once (v0.5.65). Read this before
adding any new panel, modal, overlay, or popup.

The prime directive: **desktop is a multi-column layout; mobile is a
full-screen panel machine.** A component that positions itself absolutely in
desktop's roomy grid will, on a phone, either paint under something, bleed
through everything, or trap itself off-screen. Nothing "just works" at 390px —
it works because it follows the contracts below.

---

## 1. The mobile panel system (what you are integrating with)

`src/mobile.css` activates under **`@media (pointer: coarse) and
(max-width: 1024px)`** and converts the app into fixed, full-screen panels
driven by `data-mobile-panel` on `.chat-container` (values: `servers`,
`channels`, `chat`, `members`), navigated by a fixed bottom nav. Panels slide
via `transform: translateX(...)`.

Every mobile panel reserves the same box:

```css
top:    var(--safe-area-top);                                    /* notch */
bottom: calc(var(--mobile-nav-height) + var(--safe-area-bottom)); /* nav  */
```

**Z-index bands (registry — pick your band, don't invent one):**

| z | who | notes |
|---|-----|-------|
| 90 | `.mobile-panel-overlay` | tap-to-dismiss scrim |
| 95 | `.device-stage-minimized-strip` | a minimised remote-control session's "Return to" and the PC's name, a bar the layout makes room for: above the bottom nav and the voice bar on a phone, along the window's foot on a desktop, with every panel and view ending above its measured height. Under every panel and view (nothing needs to be under it), and so under whatever one of them draws over its place: a panel or view is fixed, a stacking context of its own, and a dialog drawn inside one counts as that panel's z (the Devices view's Share, Notes' dialogs in the desktop app); at 250 the strip was over them. Over the scrim, as the bottom nav is. DeviceStageReturn.tsx, drawn inside `.chat-container` through chatRoot.ts though RcGlobals mounts it: see below the table |
| 100 | `.chat-main` | the "chat" slot |
| 105 | `.friends-dashboard` | shares the chat slot, above chat-main |
| 150 | `.sidebar`, `.member-sidebar` | slide-in side panels |
| 200 | `.server-list-container` | server rail |
| 250 | `.checklist-panel`, `.voice-panel-compact` | persistent drawers/bars |
| 300 | `.mobile-bottom-nav` | always on top of panels |
| 400 | `.stream-stage`, `.camera-preview`, `.device-stage` | fullscreen media |
| 1000+ | modals/pickers (component-local) | settings modal is 2000 |
| 1500 | `.device-downloads` | device-download tray — above modals so progress survives them, below the 2000+ consent dialogs and the 2050 file browser (which shows the same rows inside itself via `.dd-strip`) |
| 105 | `.devices-dashboard` | the Devices view — shares the chat slot with `.friends-dashboard`, same panel-transform contract |
| 2040 | `.deep-link-notice-overlay` | "This invite is for another server" / "Could not check this invite" (a `puca://` link from outside the app) — above Settings (2000), since it answers something done in another program; below the 2050+ prompts that carry deadlines |
| 2050 | `.device-file-browser` | remote file browser — above the settings modal because a Files session can be started while any modal is open and none of them close when it does |
| 2100 | `.ua-prompt-backdrop` | unattended passphrase prompt — above the browser above, because connecting to an armed device raises it on top |
| 2060 | `.clip-composer-backdrop` | clip composer — above Settings/ScreenShare (2000) because the save-clip hotkey fires while Settings can be open; below the 2100 live-connection prompts |
| 2090 | `.clip-approval-backdrop` | clip approval prompt (Phase 2) — above the composer, below the 2100 prompts, which block a live connection on a 45 s deadline |
| 1100 | `.activity-scrim` | the Activities picker (docs/GAMES.md, *Activities*) — portaled to `<body>`; a centred panel on a desktop, a bottom sheet on a phone; same band as the table's sheets, which it never coexists with |
| 1100 | `.games-sheet-scrim` | the card table's amount sheet and first-sit disclosure (docs/GAMES.md) — portaled to `<body>`; above the voice bar and bottom nav, below Settings. The sheet rides the bottom of `window.visualViewport`, so it stays above the soft keyboard |
| 9988–9991 | `.call-encryption-notice` 9988, `.hotkey-blocked-banner` 9989, `.identity-banner` 9990, `.hidden-recipient-banner` 9991 | the fixed full-width strips at the top of the signed-in app (App.tsx), each dismissible or self-clearing; they push nothing, so when two show at once the higher — the graver — is the one read first. The call-encryption notice only informs, so it is lowest |

**On a phone the bands below 1000 hold only INSIDE `.chat-container`.**
mobile.css fixes `.chat-container` to the screen, and a fixed element is a
stacking context of its own, z-index or not: everything Chat draws (the
panels, the bottom nav, its dialogs at 1000 to 2000) is stacked inside it, and
the whole of it sits at level 0 of the page. An element outside it (mounted
beside Chat in App.tsx or RcGlobals, or portaled to `<body>`) with any z-index
above 0 is drawn over ALL of Chat, every dialog and backdrop included. So a
persistent bar mounted outside Chat that must sit in one of this table's bands
is drawn inside Chat's root: `useChatRoot()` (components/chatRoot.ts) gives the
element, as DeviceStageReturn.tsx does (e2e/return-pill-live.mjs, `dialogs`,
measures the strip under the profile sheet, Edit Channel, Create Channel,
Settings, Server Settings and the Devices view's Share).

**A panel or view is a stacking context too.** Every panel above (and on a
desktop the Friends, Devices and Notes views beside the rail, at 100) is
fixed, so a dialog drawn inside one, not portaled out of it, is stacked at
that panel's z whatever its own: the Devices view's Share at z 1200 counts as
105 on a phone, under the bottom nav (300), whose bar still covers its sheet's
foot. A bar that must be under such a dialog sits below every panel, as the
strip does at 95. `.voice-panel-compact` and `.own-voice-banner`
are still portaled to `<body>` on a phone at z 250 (the sidebar's transform
would trap them), and so are drawn over Chat's dialogs while they are up: the
voice bar over the foot of the full-screen Settings, measured 2026-11-22.

### The integration contract for any NEW top-level surface

A new surface must be one of:

1. **Content inside `.chat-main`** (preferred — checklist channels and the
   All-Checklists board did this and needed zero mobile work), or
2. **A registered panel-system citizen**: under the coarse-pointer media query
   it must (a) span full width from `left: 0`, (b) reserve the safe-area top
   and bottom-nav bottom, (c) pick a z band from the table, and (d) **track the
   panel transforms** so the bottom nav still works while it's open — mirror
   `.chat-main`'s rules:

   ```css
   .chat-container[data-mobile-panel="servers"] .my-surface,
   .chat-container[data-mobile-panel="channels"] .my-surface { transform: translateX(100%); }
   .chat-container[data-mobile-panel="members"] .my-surface { transform: translateX(-100%); }
   ```

   (`.friends-dashboard` is the reference implementation, bottom of
   `FriendsPanel.css`.)
3. **A modal** — full-screen on mobile (§4).

A fixed desktop overlay with `left: 72px; z-index: 100` and none of the above
is how the Friends dashboard ended up bleeding through every screen. Don't.

---

## 2. Platform detection: JS and CSS must agree

The JS gate **must mirror the CSS media query exactly**, plus the native shell:

```ts
import { isMobile as isNativeMobile } from '../api/platform'; // Capacitor.isNativePlatform()
const isMobile = isNativeMobile() ||
    window.matchMedia('(pointer: coarse) and (max-width: 1024px)').matches;
```

- **NEVER** use `'Capacitor' in window` — `@capacitor/core` sets that global on
  *every* platform, including desktop. (This exact bug made desktop render
  mobile chrome that CSS happened to hide.)
- If JS renders mobile chrome the CSS doesn't style (or vice versa), the layout
  is half-hijacked. Change both sides together or neither.

## 3. Navigation must steer the panel

On mobile, showing something is not enough — the user must also be *taken* to
it, and whatever covered it must get out of the way. Any handler that changes
what the user is looking at must:

1. `if (isMobile) setMobilePanel('chat')` (or the appropriate panel), and
2. close covering surfaces: `setShowFriendsPanel(false)`, and the checklist
   drawer if it's open (`setShowChecklist(false)` / `setShowSelfChecklist(false)`).

This applies to: channel/DM/collection clicks, "All Checklists", Notes-to-self,
`onStartDM` callbacks (context menu, profile popup, Friends panel), post-create
auto-selection, and kicked-from-server fallbacks. Grep `setMobilePanel(` in
`Chat.tsx` for the current full list — a new selection path belongs on it.
Persistent overlays (checklist drawer) also close when the bottom nav switches
panels — see the nav button handlers.

## 4. Modals on a phone

Two-pane desktop modals (nav sidebar + content) **crush to a ~70px content
sliver at 390px**. Under the coarse-pointer query every such modal must:

- go full-screen: `width: 100vw; height: 100dvh; max-height: none; border-radius: 0`
- turn the nav pane into a **horizontal, scrollable tab strip** on top
  (`flex-direction: row; overflow-x: auto; flex-shrink: 0`), or stack panes
  vertically with a height cap on the list pane
- stack label/control rows vertically; controls `width: 100%; min-width: 0`
- keep the close button reachable: pin it `position: fixed`/sticky if it lives
  inside the scroll container, and pad for `--safe-area-top`
- cap free-floating modals at `max-height: 85dvh; overflow-y: auto` (the
  keyboard eats half the viewport; Save must stay reachable)
- take Android's **Back**: `useBackClose(onClose, isOpen)` (`hooks/useBackClose.ts`)
  inside the component, above any early return. Takers stack, so the layer
  opened last closes first. `src/tests/backCloseCoverage.test.ts` fails a
  component that draws a dialog, menu or backdrop without it, unless it is
  listed there with the reason it leaves Back alone

Reference implementations: `SettingsModal.css`, `ServerSettingsModal.css`,
`RoleSettingsModal.css` (mobile blocks at the bottom of each).

## 5. Touch rules (every interactive element)

- **No hover-only affordances.** `opacity: 0` until `:hover` means *invisible
  on touch but still tappable* — and the blanket 44px touch-target rule in
  `mobile.css` inflates the invisible button into a landmine (we had invisible
  delete buttons covering 40% of emoji tiles). Under coarse pointer, reveal the
  control (`opacity: 1`) and give it an explicit compact size. If a row gets
  crowded, collapse actions behind one visible `⋯` button.
- **Text inputs ≥ 16px font under coarse pointer.** Below 16px, iOS auto-zooms
  on focus and the fixed panel layout doesn't recover. `mobile.css` covers the
  message form; new inputs must add their own rule (see the checklist/settings
  blocks for the pattern).
- Keep the 44px minimum for real buttons; add scoped exceptions (like
  `.tt-btn`) only for dense icon rows, never below ~30px.
- Anything draggable needs a tap alternative (move up/down buttons, not just
  drag handles).

## 5a. Iconography — no emoji in chrome

UI icons come from `src/components/Icons.tsx`. **Emoji are not iconography here**
and a new one in chrome will be rejected: they render in the host font (a
different picture per platform), they are full-colour bitmaps that ignore all
eight themes and `[data-contrast="high"]`, and they overflow their em box by
different amounts per glyph so a row of them never optically aligns.

Emoji stay where emoji are the *content* — the picker dataset, the
`:shortcode:` map, reactions, custom server emoji.

```jsx
<span className="menu-icon"><ChecklistIcon /></span>   {/* yes */}
<span className="menu-icon">📋</span>                   {/* no  */}
```

Icons default to a `1.2em` box, so they inherit the `font-size` of the wrapper
they sit in — which is why the migration touched almost no CSS. Keep the
wrapper and swap the glyph; do **not** move the wrapper's class onto the
`<svg>`, because wrappers like `.menu-icon` set `width: 20px` and CSS beats the
element's width attribute, giving you a 20px-wide, 1.2em-tall stretched icon.

Full rules — grid, stroke, optical sizing, the registry, when a new icon is
justified — are in `docs/ICON_LANGUAGE.md`. Read it before adding one.

`node frontend/scripts/check-no-ui-emoji.mjs` fails on emoji that reappear in
chrome; it is wired into `npm run lint`.

## 6. CSS traps that have already bitten us

- **A CSS `transform` on any ancestor makes it the containing block for
  `position: fixed` descendants.** Every mobile panel is transformed, so a
  fixed element *inside* a panel is trapped in the panel's box and slides away
  with it — this is why the voice panel was invisible while chatting. If a
  fixed element must survive panel switches, **portal it to `document.body`**
  (see the VoicePanel portal in `Chat.tsx`) and reserve space for it where it
  overlaps content.
- **Anchored popups must clamp to the viewport.** A 352px picker anchored
  `right: 0` to a button near the screen edge hangs off-screen at 390px. Under
  coarse pointer, pin popups within the viewport (`left/right: 8px` fixed) or
  cap `max-width: calc(100vw - 16px)`.
- **Narrow-desktop ≠ mobile.** Media queries that adapt to a *narrow desktop
  window* must be guarded with `(pointer: fine)`; mobile rules with
  `(pointer: coarse) and (max-width: 1024px)`. An unguarded `max-width: 700px`
  rule fires on phones with desktop assumptions (the Friends sidebar collapsed
  to a 60px icon rail on phones this way).
- **`mobile.css` is imported last** (`main.tsx`) — its coarse-pointer block
  wins the cascade over component CSS at equal specificity. Component-local
  mobile blocks live at the *bottom* of the component's own CSS file
  (pattern: `MessageReactions.css`, `FriendsPanel.css`).
- Use `100dvh`/`--safe-area-*`, never bare `100vh`/`bottom: 0`, for anything
  full-height on mobile.
- **`:root` in `styles/theme.css` is the dark palette, and a theme only has an
  answer for what it redefines.** A colour named outright, or a token no theme
  defines with a dark fallback, stays dark on Light under Light's dark words:
  this reached 1.00:1, across most of the app's small surfaces. So a surface and
  its words come from the same place. Take both from tokens; or, for something
  drawn dark on every theme (a frame around a picture, a menu over a stream),
  add it to the list at the top of `styles/theme.css`, which gives everything
  inside it the dark palette. A colour no token can reach goes in
  `styles/lightTheme.css`. The brand colour as words is `--brand-text`:
  `--brand-primary` is under 4.5:1 on a surface on every theme. A fill under
  white words (a filled button, a selected tab, a badge) is `--brand-fill`, and
  `--brand-fill-hover` under the pointer: held on every theme to the rule a server
  mode's accent is (4.5:1 for the words, 3:1 on the surfaces), where white on the
  Purple, Green, Orange and Yellow brands is 2.9 to 4.2:1. `--brand-primary`
  itself stays for marks (a focus ring, a border, a bar). A red fill under white
  words is `--danger-fill`, since `--color-danger` is words too and is 3.77:1
  under white on the dark palette.
  `e2e/light-surfaces-real-browser.mjs` reads every component back on Light, and
  message links, the words on a brand fill and the device list's danger button on
  every theme.

## 7. Definition of done for UI work

A UI change is not done until it has been **seen at 390×844 with a coarse
pointer**. DevTools responsive mode is not enough (it doesn't flip
`pointer: coarse` unless touch emulation is on) — use the Playwright harness,
which drives real touch emulation against the local stack:

```bash
# backend: ./target/release/puca   frontend: npm run dev
cd frontend
node e2e/mobile-walk.mjs  <outdir>                    # register + core panels
node e2e/mobile-walk2.mjs <outdir> <user> <pass>      # server/channel/checklist creation
node e2e/mobile-walk3.mjs <outdir> <user> <pass>      # content surfaces, emoji, settings
node e2e/mobile-voice-test.mjs <outdir>               # voice panel + drawer behavior (+ asserts NO clip controls on phones)
node e2e/clips-mobile-walk.mjs <outdir> [baseURL]     # clip approval prompt / posted clip / owner block at 390x844 (fixture harness, no login)
node e2e/devices-mobile-walk.mjs <outdir> [baseURL]   # Devices view, both tabs, at 390x844 (fixture harness, no login)
APP=… API=… OUT=<outdir> node e2e/games-walk.mjs      # activities + the in-call card table: the launcher's sheet, the notice and the tile, Poker + Blackjack, 1280x800 and 390x844, keyboard-open raise sheet, 460 px overflow controls, eight themes (header of the file)
APP=… API=… OUT=<outdir> node e2e/games-live.mjs      # four players (one a 390x844 coarse-pointer phone) and a spectator at one table through the real server: Hold'em, Blackjack, grace drops, games switched off; every received frame scanned for leaked cards (header of the file)
APP=… OUT=<outdir> node e2e/message-overlap-live.mjs  # chat list: no message paints over another (grouped text, image, video, clip plate, spoilered image, reaction, reply, a blocked member's stub, a DM), 1280x800 and 390x844, normal and compact density, same-author lines exactly 2 px (compact 0) apart, hover moves nothing (no row, and none of the hovered row's own content); positive controls (header of the file)
APP=… API=… OUT=<outdir> node e2e/modes-walk.mjs      # server modes: defined in Server Settings, switched from the selector, channels and look arriving live on a 390x844 phone, the notice and its Join, Call everyone back, turning off ending the call, eight themes with and without high contrast; with LK_API, the same on SFU channels by LiveKit's own list (header of the file)
APP=… API=… OUT=<outdir> node e2e/sidebar-toggles-walk.mjs   # the built bundle's cascade: a voice channel under a collection listed once, a collection of voice rooms opening, muting and deleting, every switch in Server Settings, 1280x800 and 390x844, eight themes with and without high contrast (header of the file)
APP=… API=… OUT=<outdir> node e2e/mobile-ui-sweep-walk.mjs   # the 2026-11-12 phone sweep: 16px fields, the themed bottom bar, Settings rows, the @ list, message headers, link cards, Tasks, Friends' tabs, the headers' channel names, the keyboard and the bottom bar, Android's long press, faint text on every theme, the voice bar, camera tiles and the sideways stream in a call, 390x844 and 360x800 (header of the file)
SERIAL=emulator-NNNN API=… node e2e/android-phone-sweep-live.mjs   # the same on the real debug APK: Back, a real long press, the soft keyboard (header of the file)
node e2e/member-popup-scroll.mjs <outdir>             # member profile popup: everything reachable by wheel (1280x720, 1280x460) and touch (390x844, a sheet above the nav); needs API= and APP= (header of the file)
node e2e/user-context-menu-reach.mjs <outdir> [baseURL]   # right-click user menu: inline Move to / Roles lists reachable by wheel and touch at 1280x720, 1280x400 and 390x844 (fixture harness, no login)
node e2e/user-menu-move-to-real-browser.mjs           # Move to targets and the server icon's Notification Settings: on screen and hit by real clicks/taps, desktop + 390x844 (bundled component, no server)
node e2e/desktop-regression-check.mjs <outdir>        # desktop must be unchanged
```

Each prints `SHOT <file>` per screenshot — **look at the screenshots**, don't
just check exit codes. Extend the walks when you add a surface; a surface with
no walk coverage is a surface that will silently break.

Checklist for a new surface:

- [ ] Reachable and fully visible at 390×844 (no bleed-through, nothing under
      the bottom nav or notch)
- [ ] Panel-system citizen per §1, or content inside `.chat-main`
- [ ] Selecting/opening it steers the panel and closes covering overlays (§3)
- [ ] All actions visible without hover; inputs ≥16px (§5)
- [ ] Icons from `Icons.tsx`, no emoji in chrome (§5a); icon-only controls have
      an `aria-label`
- [ ] Desktop layout pixel-identical (fine-pointer guard on every new rule)
- [ ] Walk script extended to screenshot it

## 8. Release parity

Every release ships all surfaces (STANDING RULE): desktop (Tauri NSIS +
`latest.json` + `app-version.json`), mobile (**signed/encrypted** OTA via
`deploy/mobile/encrypt-bundle.mjs` — see `deploy/mobile/README.md`), and the
browser webapp (`deploy/webapp/README.md`). Web-only changes ride the OTA;
native-shell changes (plugins, `capacitor.config.ts`, manifests) require a new
APK.
