/**
 * The home-screen app (docs/USER_GUIDE.md, "iPhone and iPad"): index.html, the
 * manifest and the icons must agree, because each can be wrong alone and nothing
 * else would say so. A manifest that names an icon file nobody committed, an
 * icon whose pixels are not the size the manifest claims, or a "180x180" icon
 * that has an alpha channel (iPhone fills transparency with black) all look fine
 * in the repository and fail only on somebody's phone.
 *
 * Each case below goes red if the thing it names breaks: delete a PNG, resize
 * one, save one with alpha, drop a manifest key, change one theme colour, or put
 * viewport-fit=cover back into the shared index.html.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FRONTEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(FRONTEND, '..');
const PUBLIC = path.join(FRONTEND, 'public');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8')) as {
    name?: string; short_name?: string; start_url?: string; scope?: string; display?: string;
    background_color?: string; theme_color?: string;
    icons?: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Width, height and PNG colour type from the IHDR chunk; null if not a PNG. */
function pngInfo(file: string): { width: number; height: number; colorType: number } | null {
    const b = fs.readFileSync(file);
    if (b.length < 26 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

/** `<meta ...>` and `<link ...>` tags (comments removed) as attribute maps. */
function tags(name: 'meta' | 'link'): Record<string, string>[] {
    const bare = html.replace(/<!--[\s\S]*?-->/g, '');
    return [...bare.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((m) =>
        Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
    );
}
const meta = (n: string) => tags('meta').find((t) => t.name === n)?.content;

describe('manifest.json', () => {
    it('has the fields a Home Screen app needs', () => {
        expect(manifest.name).toBe('Púca');
        expect(manifest.short_name).toBeTruthy();
        expect(manifest.short_name!.length).toBeLessThanOrEqual(12); // longer is cut under the icon
        expect(manifest.start_url).toBe('/');
        expect(manifest.scope).toBe('/');
        expect(manifest.display).toBe('standalone');
        expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('colours match index.html and the default theme', () => {
        expect(meta('theme-color')).toBe(manifest.theme_color);
        const theme = fs.readFileSync(path.join(FRONTEND, 'src', 'styles', 'theme.css'), 'utf8');
        const bg = /--bg-primary:\s*(#[0-9a-f]{6})/i.exec(theme)![1];
        expect(manifest.background_color!.toLowerCase()).toBe(bg.toLowerCase());
    });

    it('declares 180, 192 and 512 px icons and a maskable one', () => {
        const sizes = new Set(manifest.icons!.map((i) => i.sizes));
        for (const s of ['180x180', '192x192', '512x512']) expect(sizes.has(s)).toBe(true);
        expect(manifest.icons!.some((i) => i.purpose === 'maskable')).toBe(true);
    });

    it('names only files that exist, at exactly the size declared, opaque', () => {
        expect(manifest.icons!.length).toBeGreaterThanOrEqual(4);
        for (const icon of manifest.icons!) {
            expect(icon.src.startsWith('/')).toBe(true);
            expect(icon.type).toBe('image/png');
            const file = path.join(PUBLIC, icon.src.slice(1));
            expect(fs.existsSync(file), `${icon.src} is named but missing`).toBe(true);
            const info = pngInfo(file);
            expect(info, `${icon.src} is not a PNG`).not.toBeNull();
            expect(`${info!.width}x${info!.height}`, `${icon.src}'s pixels`).toBe(icon.sizes);
            // colour type 2 = RGB and 0 = grey: no alpha channel, nothing for iOS to fill black.
            expect([0, 2], `${icon.src} has an alpha channel`).toContain(info!.colorType);
        }
    });
});

describe('index.html', () => {
    it('links the manifest and an opaque 180 px apple-touch-icon that exists', () => {
        const links = tags('link');
        expect(links.find((l) => l.rel === 'manifest')?.href).toBe('/manifest.json');
        const touch = links.find((l) => l.rel === 'apple-touch-icon')!;
        expect(touch.sizes).toBe('180x180');
        const info = pngInfo(path.join(PUBLIC, touch.href.slice(1)));
        expect(info).toMatchObject({ width: 180, height: 180 });
        expect([0, 2]).toContain(info!.colorType);
    });

    it('carries the Apple and generic web-app tags', () => {
        expect(meta('apple-mobile-web-app-capable')).toBe('yes');
        expect(meta('mobile-web-app-capable')).toBe('yes');
        expect(meta('apple-mobile-web-app-title')).toBe('Púca');
        // translucent would draw the page under the status bar in white text
        expect(meta('apple-mobile-web-app-status-bar-style')).toBe('black');
    });

    it('does NOT set viewport-fit=cover (the Android and desktop apps share this file)', () => {
        const viewport = meta('viewport')!;
        expect(viewport).toContain('width=device-width');
        expect(viewport).not.toMatch(/viewport-fit/);
    });

    it('registers no service worker for the main app', () => {
        expect(html).not.toMatch(/serviceWorker/);
        expect(fs.existsSync(path.join(PUBLIC, 'sw.js'))).toBe(false);
    });
});

describe('the download page', () => {
    const page = fs.readFileSync(path.join(REPO, 'deploy', 'download-site', 'index.html'), 'utf8');
    const start = page.indexOf('<div class="notes-app" id="iphone">');
    const end = page.indexOf('<!-- id="notes-app"');
    const section = start >= 0 && end > start ? page.slice(start, end) : '';

    it('has an #iphone section, before Notes and Steam Deck, that the script moves first for iOS', () => {
        expect(section.length).toBeGreaterThan(500);
        expect(page.indexOf('id="iphone"')).toBeLessThan(page.indexOf('id="notes-app"'));
        expect(page.indexOf('id="notes-app"')).toBeLessThan(page.indexOf('id="steam-deck"'));
        expect(page).toMatch(/iPhone\|iPad\|iPod/);
    });

    it('gives the four steps and an Open Púca link, from the web app host token only', () => {
        for (const step of ['Safari', 'Share', 'Add to Home Screen', 'Add']) expect(section).toContain(`<b>${step}</b>`);
        expect(section).toContain('href="https://__APP_HOST__"');
        expect(section).toContain('>Open Púca<');
        // no domain typed in, and nothing fetched from anywhere else
        expect(section).not.toMatch(/https?:\/\/(?!__APP_HOST__)/);
        expect(section).not.toMatch(/<script|<img|<iframe/i);
    });

    it('holds a QR placeholder that the ship script fills, and says what the limits are', () => {
        expect(section).toContain('__APP_QR_SVG__');
        for (const limit of ['No notifications while Púca is closed', 'Calls are encrypted end to end', 'My Devices', 'Photos work']) {
            expect(section).toContain(limit);
        }
        // Safari encrypts mesh calls through RTCRtpScriptTransform now: the page
        // must not say otherwise, and must say an iPhone has not been tried yet.
        expect(section).not.toContain('Calls are held back');
        expect(section).not.toMatch(/Safari cannot do the frame-by-frame encryption/);
        expect(section).toMatch(/an iPhone has not been tried yet/);
    });

    it('keeps the gates the ship scripts read: variant panels, APK links, version label, Notes, Steam Deck', () => {
        expect(page).toContain('data-variant-panel="full"');
        expect(page).toContain('data-variant-panel="lite"');
        expect(page).toContain('function selectVariant');
        expect(page).toMatch(/href="\/mobile\/Puca-\d+\.\d+\.\d+\.apk"/);
        expect(page).toMatch(/href="\/mobile\/Puca-Lite-\d+\.\d+\.\d+\.apk"/);
        expect(page).toMatch(/href="\/mobile\/Puca-Notes-\d+\.\d+\.\d+\.apk"/);
        expect(page).toMatch(/<div class="meta">v\d+\.\d+\.\d+ &middot; Windows 10\/11/);
        expect(page).toContain('id="steam-deck"');
    });
});
