/**
 * A server mode's accent reaches the buttons on every theme (components/modes/useModeLook.ts).
 * A filled button paints --brand-fill (styles/theme.css), which is --brand-primary on most themes
 * but a deeper shade of its own on the colour themes whose brand is too bright for the white
 * words on it. The accent the hook sets is already one white words hold on (accentTokens), so it
 * has to set the fills too, or on Purple, Green, Orange and Yellow a mode's accent would recolour
 * the words and rings and leave every button the theme's own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { accentTokens, type ServerMode } from '../api/serverModes';

vi.mock('../api/modeLook', async (orig) => ({
    ...(await orig<typeof import('../api/modeLook')>()),
    // The green theme's surfaces, as the hook reads them off the page.
    readThemeColor: (token: string) => (token === '--bg-secondary' ? [14, 23, 18] : [21, 35, 28]),
}));

const { useModeLook } = await import('../components/modes/useModeLook');

const mode: ServerMode = {
    id: 7,
    name: 'Tournament',
    background_file_id: null,
    accent_color: '#ff5fa2',
    home_channel_id: null,
    auto_off: false,
    channel_ids: [],
};

function Chat({ on }: { on: ServerMode | null }) {
    useModeLook(on);
    return <main />;
}

let container: HTMLDivElement;
let root: Root;
const style = () => document.documentElement.style;

beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'green');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.removeAttribute('data-theme');
});

describe('a mode accent on a colour theme', () => {
    it('sets the fills a button paints, as it sets the brand, and takes them away with it', async () => {
        const tokens = accentTokens(mode.accent_color!, [[21, 35, 28], [14, 23, 18]])!;
        await act(async () => { root.render(<Chat on={mode} />); });
        expect(style().getPropertyValue('--brand-primary')).toBe(tokens.primary);
        expect(style().getPropertyValue('--brand-fill')).toBe(tokens.primary);
        expect(style().getPropertyValue('--brand-fill-hover')).toBe(tokens.hover);
        await act(async () => { root.render(<Chat on={null} />); });
        for (const token of ['--brand-primary', '--brand-hover', '--brand-active', '--brand-fill', '--brand-fill-hover']) {
            expect(style().getPropertyValue(token), token).toBe('');
        }
    });
});
