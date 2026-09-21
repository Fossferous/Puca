/**
 * A card's view of a note's OWN content: the pictures across the top (photos
 * and drawings from the list's sidecar) and the note text under the title.
 * Read-only, like the rest of the card; the editor changes them. Pictures
 * decrypt only once the card is on screen, at most three per card —
 * including one added with no connection, which comes from this device's own
 * sealed copy instead of the server (api/parkedPreview.ts), so a photo note
 * taken on a plane looks like a photo note.
 */
import { useEffect, useState } from 'react';
import { decryptToBlobUrl, parseEncAttachment } from '../../api/attachments';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type GalleryItem } from '../../api/noteMedia';
import { parseParkedRef } from '../../api/parkedMedia';
import { parkedObjectUrl } from '../../api/parkedPreview';
import '../noteContent.css';

function HeroImage({ item, visible }: { item: GalleryItem; visible: boolean }) {
    const [url, setUrl] = useState<string | null>(null);
    const href = item.ref.href;
    useEffect(() => {
        const p = parseEncAttachment(href);
        if (!visible || url || (!p && !parseParkedRef(href))) return;
        let cancelled = false;
        const load = p ? decryptToBlobUrl(p.id, p.key, p.mime, p.cap) : parkedObjectUrl(href);
        load
            .then(u => { if (!cancelled && u) setUrl(u); })
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

export function NoteBodyPreview({ body }: { body: string | null | undefined }) {
    if (!body) return null;
    if (isUndecryptable(body)) return <p className="notes-card-body unreadable">{body}</p>;
    return <p className="notes-card-body">{body}</p>;
}
