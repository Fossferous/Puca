/**
 * A card's view of a note's OWN content: the pictures across the top (photos
 * and drawings from the list's sidecar) and the note text under the title.
 * Read-only, like the rest of the card; the editor changes them. Pictures
 * decrypt only once the card is on screen, at most three per card.
 */
import { useEffect, useState } from 'react';
import { decryptToBlobUrl, parseEncAttachment } from '../../api/attachments';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type GalleryItem } from '../../api/noteMedia';
import { findRanges, snippetAround } from '../model/noteSearch';
import { Highlight } from './Highlight';
import '../noteContent.css';

function HeroImage({ item, visible }: { item: GalleryItem; visible: boolean }) {
    const [url, setUrl] = useState<string | null>(null);
    const href = item.ref.href;
    useEffect(() => {
        const p = parseEncAttachment(href);
        if (!visible || !p || url) return;
        let cancelled = false;
        decryptToBlobUrl(p.id, p.key, p.mime, p.cap)
            .then(u => { if (!cancelled) setUrl(u); })
            .catch(() => { /* the gallery in the editor shows the failure */ });
        return () => { cancelled = true; };
    }, [visible, href, url]);
    if (!url) return <span className="notes-hero-pending" />;
    return <img src={url} alt={item.ref.name} className={item.kind === 'drawing' ? 'drawing' : ''} loading="lazy" />;
}

export function NoteHero({ items, visible }: { items: GalleryItem[]; visible: boolean }) {
    if (items.length === 0) return null;
    return (
        <div className={`notes-card-hero ${items.length === 1 ? 'one' : ''}`}>
            {items.map(i => <HeroImage key={i.ref.href} item={i} visible={visible} />)}
        </div>
    );
}

/**
 * The note's text under the title, clamped to its first lines by CSS.
 *
 * During a search the clamp is the problem: a note holds up to 48 KB and a hit
 * at character 30,000 was rendered nowhere, so a matching card looked empty.
 * `snippetAround` moves the window to the first match instead of the head of
 * the text, and the clamp still applies to the window.
 */
export function NoteBodyPreview({ body, terms = [] }: { body: string | null | undefined; terms?: readonly string[] }) {
    if (!body) return null;
    // A marker is never searched and never marked up (noteMatches' rule).
    if (isUndecryptable(body)) return <p className="notes-card-body unreadable">{body}</p>;
    if (terms.length === 0) return <p className="notes-card-body">{body}</p>;
    const snippet = snippetAround(body, findRanges(body, terms));
    return <p className="notes-card-body">
        <Highlight text={snippet.text} ranges={snippet.ranges} />
    </p>;
}
