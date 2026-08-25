/**
 * An `<img>` for an uploaded file, fetched with credentials.
 *
 * `/files/:id` is authenticated, and `<img src>` cannot send an Authorization
 * header, so the bytes are fetched and handed over as an object URL (see
 * api/authedMedia). Renders nothing until they arrive, and nothing if the
 * fetch fails — a missing emoji or icon is better than a broken-image glyph.
 *
 * SmartAvatar does this itself because it also owns the speaking/freeze
 * behaviour; this is for the plainer sites (emoji, server icons).
 */
import type React from 'react';
import { useAuthedFileUrl } from '../hooks/useAuthedFileUrl';

export function AuthedImg({ fileId, alt = '', ...imgProps }: {
    fileId: string | null | undefined;
} & Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
    const src = useAuthedFileUrl(fileId);
    if (!src) return null;
    return <img src={src} alt={alt} {...imgProps} />;
}
