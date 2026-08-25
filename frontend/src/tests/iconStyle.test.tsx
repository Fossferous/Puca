/**
 * The Classic icon style must actually swap the icons.
 *
 * A stored setting with nothing reading it is this repo's most-repeated bug
 * (CLAUDE.md: "A setting needs its UI in the same change"), and the icon
 * toggle is unusually easy to ship broken: the store is a module-level
 * external store, so if the subscription is wrong every icon simply keeps its
 * first render forever and the option looks like it does nothing.
 *
 * Each assertion here has its opposite asserted too — "classic shows the
 * emoji" is worthless without "modern does not", or a component that always
 * rendered the emoji would pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TrashIcon, HomeIcon, SpeakerOffIcon, ClipIcon } from '../components/Icons';
import { setIconStyle, getIconStyle } from '../components/iconStyle';
import { applyAppearance, defaultSettings } from '../components/settingsStore';

let host: HTMLDivElement;
let root: Root;

const render = (node: React.ReactNode) => {
    act(() => { root.render(node); });
};

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    setIconStyle('modern');
});

afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    setIconStyle('modern');
});

describe('icon style toggle', () => {
    it('ClipIcon (new; no classic form) stays an SVG in BOTH styles', () => {
        render(<ClipIcon />);
        expect(host.querySelector('svg.svrn-icon')).not.toBeNull();
        act(() => { setIconStyle('classic'); });
        expect(host.querySelector('svg.svrn-icon')).not.toBeNull();
        expect(host.querySelector('.svrn-icon-legacy')).toBeNull();
        act(() => { setIconStyle('modern'); });
    });

    it('draws an SVG and no emoji in modern', () => {
        render(<TrashIcon />);
        expect(host.querySelector('svg.svrn-icon')).not.toBeNull();
        expect(host.querySelector('.svrn-icon-legacy')).toBeNull();
        expect(host.textContent).toBe('');
    });

    it('swaps to the emoji in classic', () => {
        render(<TrashIcon />);
        act(() => { setIconStyle('classic'); });

        expect(host.querySelector('svg.svrn-icon')).toBeNull();
        const legacy = host.querySelector('.svrn-icon-legacy');
        expect(legacy).not.toBeNull();
        expect(legacy!.textContent).toBe('\u{1F5D1}️'); // wastebasket
    });

    it('swaps back — the subscription is live, not just the first render', () => {
        render(<TrashIcon />);
        act(() => { setIconStyle('classic'); });
        expect(host.querySelector('svg.svrn-icon')).toBeNull();

        act(() => { setIconStyle('modern'); });
        expect(host.querySelector('svg.svrn-icon')).not.toBeNull();
        expect(host.querySelector('.svrn-icon-legacy')).toBeNull();
    });

    it('keeps drawing icons that never had a glyph to go back to', () => {
        // HomeIcon was already an SVG before the migration, so `classic` has
        // nothing older to show and must not render an empty span.
        render(<HomeIcon />);
        act(() => { setIconStyle('classic'); });
        expect(host.querySelector('svg.svrn-icon')).not.toBeNull();
        expect(host.querySelector('.svrn-icon-legacy')).toBeNull();
    });

    it('keeps the icon decorative in both styles', () => {
        render(<SpeakerOffIcon />);
        expect(host.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');

        act(() => { setIconStyle('classic'); });
        expect(host.querySelector('.svrn-icon-legacy')!.getAttribute('aria-hidden')).toBe('true');
    });

    it('names a standalone icon in both styles', () => {
        render(<SpeakerOffIcon title="muted" />);
        expect(host.querySelector('svg')!.getAttribute('role')).toBe('img');
        expect(host.querySelector('svg title')!.textContent).toBe('muted');

        act(() => { setIconStyle('classic'); });
        const legacy = host.querySelector('.svrn-icon-legacy')!;
        expect(legacy.getAttribute('role')).toBe('img');
        expect(legacy.getAttribute('aria-label')).toBe('muted');
    });

    it('sizes the emoji to the box, not to 1.2em of it', () => {
        // The SVG needs 1.2em to match an emoji's ink; the emoji IS the ink, so
        // passing that correction through would render it 20% too large.
        render(<TrashIcon size={18} />);
        act(() => { setIconStyle('classic'); });
        expect((host.querySelector('.svrn-icon-legacy') as HTMLElement).style.fontSize).toBe('18px');
    });

    it('ships modern by default', () => {
        expect(defaultSettings.iconStyle).toBe('modern');
    });

    it('is applied by applyAppearance, the same path the theme uses', () => {
        applyAppearance({ ...defaultSettings, iconStyle: 'classic' });
        expect(getIconStyle()).toBe('classic');

        applyAppearance({ ...defaultSettings, iconStyle: 'modern' });
        expect(getIconStyle()).toBe('modern');
    });
});
