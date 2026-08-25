# Púca Icon Language

Púca shipped its UI iconography as **emoji** — roughly 250 call sites across
45 files. Emoji were never a design decision; they were the fastest thing to
type. They cost us four things:

1. **They are not ours.** Every emoji renders in the host font — Segoe UI Emoji
   on Windows, Noto on Android, Apple Color Emoji on iOS. The same button is a
   different picture on every platform, and none of them are drawn to our grid.
2. **They ignore the theme.** Emoji are full-colour bitmaps. On the eight themes
   in `styles/theme.css` — dark, light, amoled, pink, purple, green, orange,
   yellow — a 🔴 stays the same red on a green theme and the same red on a white
   one. They also ignore `[data-contrast="high"]` entirely.
3. **They carry tone we did not choose.** 💣 for "Disband Server" and 👢 for
   "Kick" read as jokes on a screen where somebody is being removed.
4. **They are inconsistent in weight and size.** Emoji overflow their em box by
   different amounts per glyph, so an emoji row never optically aligns.

This document is the replacement. It defines the construction rules; the set
itself lives in `frontend/src/components/Icons.tsx`.

---

## 1. Construction

Every icon is drawn to the same grid. No exceptions — an icon that breaks the
grid is what makes a set look bought rather than designed.

| Property | Value |
|---|---|
| Canvas | `viewBox="0 0 24 24"` |
| Live area | 20×20, inset 2 on every side |
| Stroke | `1.75` nominal, `currentColor` |
| Caps / joins | `round` / `round` |
| Fill | `none` (see §4 for the solid exceptions) |
| Corner radius | `2` on small forms, `2.5` on 16-wide forms, `4+` only for pill shapes |
| Negation slash | `M3.5 3.5 20.5 20.5` — one 45° stroke, always this one |

The 2px inset is not padding for its own sake. It is the room the round caps
need: a 1.75 stroke centred on x=2 paints out to x=1.13, so anything drawn at
the very edge of the viewBox clips when the browser rasterises at 16px.

### Keylines

Shapes are sized to *optical* parity, not mathematical parity. A circle that
measures the same as a square looks smaller than it.

| Form | Keyline |
|---|---|
| Circle | ⌀18 — `cx=12 cy=12 r=9` |
| Square | 16.5×16.5 — `x=3.75 y=3.75` r=2.5 |
| Landscape rect | 19×13.5 — `x=2.5 y=5.75` |
| Portrait rect | 11.5×19.5 — `x=6.25 y=2.25` |
| Full-height | 20 tall — `y` from 2 to 22 |

### Dots

A dot is a **zero-length path with a round cap**, never a `<circle>`:

```jsx
<path d="M12 16.75h.01" />
```

It inherits the stroke width, so it scales with the icon and stays optically
matched to every other terminal in the set. A `<circle r="0.875">` does not —
it stays fixed while the strokes around it change.

---

## 2. Colour and theming

**Icons are monochrome and always `currentColor`.** That single rule is what
makes them work across all eight themes and the high-contrast modifier for free:
an icon is the same colour as the text it sits next to, whatever that text is.

There is no icon palette, and semantic colour is **never** baked into the icon.
An icon that must read as dangerous or live gets its colour from the call site:

```jsx
<span className="menu-icon" style={{ color: 'var(--color-danger)' }}><TrashIcon /></span>
```

or, preferably, from a class that already sets it (`.context-menu-item.danger`
sets `color`, and the icon inherits it). This is why `.danger` menu rows now
tint their icon too — with emoji that was impossible.

The one deliberate exception is `LiveDotIcon`, which is a filled dot for the
"LIVE" indicator. It is still `currentColor`; the red comes from
`.live-indicator`'s existing colour.

---

## 3. Sizing

Icons are **typographic**: the default box is `1.2em`, so an icon inherits the
`font-size` of whatever it sits in. This is what let the migration land without
rewriting 40 CSS files — every one of the ~250 emoji sites was already sized by
`font-size` on a wrapper (`.menu-icon`, `.nav-icon`, `.context-icon`, …), and
those rules keep working unchanged.

`1.2em` rather than `1em` because an SVG fills its box to the 20/24 live area
(0.833×) while an emoji glyph overflows its em box. `1.2 × 20/24 = 1.0em` of
visible mark — the same optical size as the emoji it replaced, so no layout
shifted.

Pass an explicit numeric `size` when the icon is not text-adjacent (hero art,
empty states, fixed-size chrome). Numeric sizes get **optical stroke
compensation** automatically, because a stroke that scales linearly looks fat at
64px and vanishes at 14px:

| Rendered size | Stroke |
|---|---|
| ≤ 16px | `2` |
| 17–39px | `1.75` |
| ≥ 40px | `1.4` |

Override with `strokeWidth` only if you have a specific reason and can say what
it is.

### The wrapper was sized for whatever used to be in it

This is the trap that made a dozen close buttons look wrong after the
migration, and it is worth understanding before you trust an inherited size.

An **emoji** fills its em box almost completely — a 24px emoji draws about 24px
of ink. `1.2em × 20/24 = 1.0em` of icon, so a wrapper that held an emoji gives
an icon the *same* visual size. Those wrappers were all correct untouched.

A **typographic glyph** does not. `×` (U+00D7) draws roughly half its em box,
so `.invite-modal-close { font-size: 24px }` was showing about 12px of ink. Put
an icon in it and you get 24px — twice the mark, in the same box. Every close
button in the app hit this.

So: a wrapper inherited from an emoji needs nothing; a wrapper inherited from
`✕ × ✓ ▲ ▼ ⋮ →` needs an explicit `size`, and roughly half what the CSS says.
Close buttons landed on `size={18}`.

Passing an explicit size has a second benefit worth knowing. All component CSS
is bundled globally here, and `.close-btn` is declared in more than one file —
so which `font-size` wins depends on import order. An icon with a numeric size
does not care.

### Wrapper contract

**Put the icon inside the existing wrapper; do not move the wrapper's class onto
the icon.** Several wrappers set `width`/`height` in px (`.menu-icon` is
`width: 20px`). CSS beats presentation attributes, so moving that class onto the
`<svg>` would set width to 20px while height stayed `1.2em` — a stretched icon.

```jsx
<span className="menu-icon"><CopyIcon /></span>   {/* correct */}
<CopyIcon className="menu-icon" />                {/* stretches */}
```

---

## 4. Solid forms

The set is an outline set. Three things are solid, each for a reason:

- **`LiveDotIcon`** — a live indicator is a light, not a diagram.
- **`StopSharingIcon`** — the filled inner square is the universal "stop"
  mark; an outlined one reads as an empty box.
- **`TapIcon` / `TapDoubleIcon` / `TapLongIcon`** — the contact point is a
  fingerprint on glass, and an outlined ring there reads as a target instead.

Note what is *not* on that list: `CheckboxCheckedIcon`. A filled box with a
knocked-out tick is more legible at 14px, but the knockout has to be painted in
the **background** colour, and there is no single background — the same icon
renders on `--bg-primary` in Tasks and on `--bg-secondary` in a sidebar, so one
of them would always be wrong. It stays outlined.

If you find yourself wanting a fourth, ask whether the state should be carried
by colour or weight at the call site instead.

---

## 5. Accessibility

Icons are decorative by default: `aria-hidden="true"`, `focusable="false"`.
An icon next to a text label must stay hidden — otherwise a screen reader says
the name twice.

An icon that is the **only** content of a control needs a name, and it must go
on the control, not the icon:

```jsx
<button aria-label="Delete message"><TrashIcon /></button>
```

Pass `title` to the icon only when it is genuinely standalone content with no
control wrapping it; that switches it to `role="img"` with an SVG `<title>`.

Every control that previously relied on an emoji to convey meaning without a
label was audited during the migration — `aria-label` was added where it was
missing, which was most of them.

---

## 6. Naming

`<Thing><Modifier>Icon`, and the modifier is always a state, never a visual
description: `MicOffIcon`, not `MicSlashIcon`. Name what it *means* in this
product — `DisbandIcon`, not `ServerCrossedOutIcon` — so the call site reads as
intent.

Data-driven menus use the string registry instead of the component:

```ts
import { type IconName } from './Icons';
const item = { id: 'copy', label: 'Copy Text', icon: 'copy' satisfies IconName };
```

`IconName` is a union derived from the registry, so a typo is a compile error.
The old `icon?: string` field allowed `'📋'` and would have allowed `'x'` just
as happily.

---

## 6a. The Classic escape hatch

**Settings → Appearance → Icon Style** switches the whole app back to the emoji
and glyphs the icons replaced. Not everyone will want the new set, and a
redesign nobody can undo is a redesign people resent.

- `iconStyle: 'modern' | 'classic'` in `settingsStore`, default `modern`.
- The live value is a plain module store, `components/iconStyle.ts` — **not** a
  React context and **not** inside `Icons.tsx`. Not a context because icons
  render on the Login screen and inside the crash boundary, neither of which
  sits under the app's providers. Not in `Icons.tsx` because `settingsStore`
  has to write it, and `settingsStore` is imported across `api/` — the icon set
  and `Icons.css` would be dragged into every one of those bundles for one
  string.
- `applyAppearance` writes it at boot and on every save, the same path the
  theme takes. `Icons.tsx` reads it with `useSyncExternalStore`.
- The glyph per icon is `LEGACY_GLYPHS` in `Icons.tsx` — the one place emoji
  are permitted as chrome, marked with an `icon-lint:allow-emoji` region.
- An icon **missing** from that map keeps drawing in Classic. `HomeIcon`,
  `ChannelsIcon`, `ChatIcon`, `CameraOffIcon`, `FlipCameraIcon` and
  `DisconnectIcon` were already SVGs before the migration, so there is no older
  glyph to go back to.

Adding an icon? Add its `LEGACY_GLYPHS` entry only if it is replacing a glyph
that currently ships. A brand-new icon has no classic form and should not
invent one. (`ClipIcon` / `ClipOffIcon` — the clip replay buffer, 2026-08-18 —
are the reference case: registered as `clip` / `clip-off`, no legacy entry, and
deliberately NOT `RecordIcon`, which means live recording to a file.)

`src/tests/iconStyle.test.tsx` covers the swap in both directions. Every
assertion there has its opposite asserted too — "classic shows the emoji" is
worth nothing without "modern does not".

## 7. What is NOT an icon

Emoji stay where emoji are the **content**:

- `api/emojis.ts` — the emoji picker's data. ~1,200 glyphs. Untouched.
- `MessageContent.tsx`'s `:shortcode:` map — typing `:fire:` produces 🔥 in a
  message. That is user text.
- Message reactions — a reaction *is* an emoji.
- Custom server emoji.

The emoji picker's **category tabs** are chrome, not content, and were converted
— the tab strip is navigation, the grid below it is content.

---

## 8. Adding an icon

1. Check the registry first. `SpeakerIcon` already covers volume, voice channel
   and audio-source; a second speaker drawn slightly differently is how sets rot.
2. Draw it to §1. Start from the nearest existing icon and keep its keyline.
3. Add it to `ICONS` so it gets an `IconName`.
4. Look at it at **14px, 16px and 24px** before committing. Most icons die at
   14px — usually because they have more than 4 elements, or a detail smaller
   than 2 units. Cut detail rather than shrinking it.
5. It must be legible in light, dark, amoled and one tinted theme, with
   `[data-contrast="high"]` both on and off.

## 9. Checking your work

```bash
node frontend/scripts/check-no-ui-emoji.mjs     # chained into `npm run lint`
node frontend/scripts/check-icon-cohesion.mjs   # run by hand
```

`check-no-ui-emoji` fails on emoji or glyph icons in chrome. `check-icon-cohesion`
reports where one meaning maps to two icons — it is regex heuristics over JSX, so
it is deliberately *not* wired into `lint`; a required gate that cries wolf is a
gate people learn to skip. It caught three real ones after the migration:
"Delete" was a cross in Emoji Settings and a bin everywhere else, "Revoke invite"
was a cross in one modal and a bin in another, and a button titled "More"
rendered an overflow icon while going straight to a remove-friend confirm.

To see the whole set, or one icon in the wrapper it will actually ship in:

```bash
cd frontend && npm run dev
# then open e2e/icon-context-harness.html
```

That harness links the **real** stylesheets and parses the SVG bodies out of
`Icons.tsx`, so it cannot drift from what ships. It is how the oversized close
buttons were found — every icon in it is measured for square aspect, and any
wrapper whose rendered size lands outside the sane band shows up immediately.
