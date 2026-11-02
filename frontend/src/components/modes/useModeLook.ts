import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { cachedFileUrl, fetchFileUrl } from '../../api/authedMedia';
import { UNKNOWN_EXTREMES, measureExtremes, readThemeColor } from '../../api/modeLook';
import { accentTokens, scrimAlpha, type Rgb, type ServerMode } from '../../api/serverModes';

const LOOK_ATTRIBUTES = ['data-theme', 'data-contrast', 'data-server-looks'];

function subscribeLook(onChange: () => void): () => void {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: LOOK_ATTRIBUTES });
    return () => observer.disconnect();
}

/** Theme, contrast and the personal switch, as one value that changes with any. */
function lookSnapshot(): string {
    const root = document.documentElement;
    return LOOK_ATTRIBUTES.map(a => root.getAttribute(a)).join('|');
}

/**
 * May this reader's window take a mode's look at all? High contrast is the reader
 * asking for the plainest possible surfaces, and the personal switch (Settings,
 * Appearance) is them declining it.
 */
export function serverLooksAllowed(): boolean {
    const root = document.documentElement;
    return root.getAttribute('data-contrast') !== 'high' && root.getAttribute('data-server-looks') !== 'off';
}

const BRAND_TOKENS = ['--brand-primary', '--brand-hover', '--brand-active'] as const;

/**
 * A mode's look on this reader's screen: sets the accent on the document for as
 * long as `mode` is the one on screen (the menus and dialogs the app portals to
 * <body> take it too), and answers the style for `.chat-main`'s background.
 *
 * The picture is a background on `.chat-main` rather than a layer inside it,
 * because a positioned child would need `position: relative` on an element whose
 * containing-block chain the message toolbar and pickers depend on (Chat.css).
 */
export function useModeLook(mode: ServerMode | null): CSSProperties | undefined {
    const look = useSyncExternalStore(subscribeLook, lookSnapshot);
    const allowed = useMemo(() => {
        void look;
        return serverLooksAllowed();
    }, [look]);

    const accent = allowed ? mode?.accent_color ?? null : null;
    useEffect(() => {
        if (!accent) return;
        const surfaces = ['--bg-primary', '--bg-secondary'].map(readThemeColor).filter((c): c is Rgb => c !== null);
        const tokens = accentTokens(accent, surfaces);
        if (!tokens) return;
        const root = document.documentElement.style;
        root.setProperty('--brand-primary', tokens.primary);
        root.setProperty('--brand-hover', tokens.hover);
        root.setProperty('--brand-active', tokens.active);
        return () => {
            for (const token of BRAND_TOKENS) root.removeProperty(token);
        };
        // `look`: the theme decides what the accent has to contrast with.
    }, [accent, look]);

    const fileId = allowed ? mode?.background_file_id ?? null : null;
    const [loaded, setLoaded] = useState<{ fileId: string; url: string; extremes: readonly Rgb[] } | null>(null);
    useEffect(() => {
        if (!fileId || loaded?.fileId === fileId) return;
        let stale = false;
        void (async () => {
            const url = cachedFileUrl(fileId) ?? await fetchFileUrl(fileId);
            if (!url || stale) return;
            const extremes = await measureExtremes(url).catch(() => UNKNOWN_EXTREMES);
            if (!stale) setLoaded({ fileId, url, extremes });
        })();
        return () => { stale = true; };
    }, [fileId, loaded?.fileId]);

    return useMemo(() => {
        if (!fileId || loaded?.fileId !== fileId) return undefined;
        const surface = readThemeColor('--bg-primary');
        const texts = ['--text-normal', '--text-muted', '--text-link'].map(readThemeColor).filter((c): c is Rgb => c !== null);
        if (!surface) return undefined;
        const alpha = scrimAlpha(loaded.extremes, surface, texts);
        const veil = `rgba(${surface[0]}, ${surface[1]}, ${surface[2]}, ${alpha})`;
        return {
            backgroundImage: `linear-gradient(${veil}, ${veil}), url("${loaded.url}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        } satisfies CSSProperties;
        // `look`: the theme decides how far the picture has to be dimmed.
    }, [fileId, loaded, look]);
}
