import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { cachedFileUrl, fetchFileUrl } from '../../api/authedMedia';
import { mapPicture, pictureStyle, readPictureTheme, readThemeColor } from '../../api/modeLook';
import { accentTokens, type PictureLimit, type Rgb, type ServerMode } from '../../api/serverModes';

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
 * Accessibility) is them declining it.
 */
export function serverLooksAllowed(): boolean {
    const root = document.documentElement;
    return root.getAttribute('data-contrast') !== 'high' && root.getAttribute('data-server-looks') !== 'off';
}

const BRAND_TOKENS = ['--brand-primary', '--brand-hover', '--brand-active'] as const;

/** A picture on screen: `.chat-main`'s style, and the band its text has to stay out of. */
export interface ModeLook {
    style: CSSProperties;
    limit: PictureLimit;
}

/**
 * A mode's look on this reader's screen: sets the accent on the document for as
 * long as `mode` is the one on screen (the menus and dialogs the app portals to
 * <body> take it too), and answers the style for `.chat-main`'s background.
 *
 * The picture is a background on `.chat-main` rather than a layer inside it,
 * because a positioned child would need `position: relative` on an element whose
 * containing-block chain the message toolbar and pickers depend on (Chat.css).
 * It never touches the reader's theme: only Settings does (settingsStore applyTheme).
 */
export function useModeLook(mode: ServerMode | null): ModeLook | undefined {
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
    // The theme decides the curve, so a theme change maps the picture again. Until that
    // is done there is no picture: the old mapping is unreadable on the new theme. The
    // accent is in the key for the names written in it.
    const key = fileId ? `${fileId}|${look}|${accent ?? ''}` : null;
    const [mapped, setMapped] = useState<{ key: string; look: ModeLook } | null>(null);
    useEffect(() => {
        if (!fileId || !key || mapped?.key === key) return;
        let stale = false;
        void (async () => {
            const source = cachedFileUrl(fileId) ?? await fetchFileUrl(fileId);
            const theme = readPictureTheme();
            if (!source || !theme || stale) return;
            const picture = await mapPicture(source, theme.limit);
            if (picture && !stale) setMapped({ key, look: { style: pictureStyle(picture.url, theme) as CSSProperties, limit: theme.limit } });
        })();
        return () => { stale = true; };
    }, [fileId, key, mapped?.key]);

    return key && mapped?.key === key ? mapped.look : undefined;
}
