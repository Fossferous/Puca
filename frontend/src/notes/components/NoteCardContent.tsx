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
import { parseEncAttachment } from '../../api/attachments';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type GalleryItem } from '../../api/noteMedia';
import { parseParkedRef } from '../../api/parkedMedia';
import { parkedObjectUrl } from '../../api/parkedPreview';
import { useHeldAttachmentUrl } from '../../components/useHeldAttachmentUrl';
import { NoteLinkText } from '../../components/NoteLinkText';
import { findRanges, snippetAround } from '../model/noteSearch';
import { Highlight } from './Highlight';
import '../noteContent.css';

function HeroImage({ item, visible }: { item: GalleryItem; visible: boolean }) {
    const [parkedUrl, setParkedUrl] = useState<string | null>(null);
    const href = item.ref.href;
    const p = parseEncAttachment(href);
    // Decrypted once the card is on screen, then shown for as long as the
    // card is mounted (and the app on screen: useHeldAttachmentUrl); a
    // failure shows in the editor's gallery.
    const [reached, setReached] = useState(visible);
    if (visible && !reached) setReached(true);
    const held = useHeldAttachmentUrl(p ? { id: p.id, key: p.key, mime: p.mime, cap: p.cap } : null, { enabled: reached });
    useEffect(() => {
        if (!visible || parkedUrl || parseEncAttachment(href) || !parseParkedRef(href)) return;
        let cancelled = false;
        parkedObjectUrl(href)
            .then(u => { if (!cancelled && u) setParkedUrl(u); })
            .catch(() => { /* the gallery in the editor shows the failure */ });
        return () => { cancelled = true; };
    }, [visible, href, parkedUrl]);
    const url = p ? held.url : parkedUrl;
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
    // Links are marked, not tappable: the card's own tap opens the note, and a
    // 44px tap target cannot live inside a line-clamped preview at 390px.
    if (terms.length === 0) {
        return <p className="notes-card-body"><NoteLinkText text={body} interactive={false} /></p>;
    }
    // Searching: the window moves to the first hit, and the hits are marked
    // inside the link renderer's plain stretches, so a card keeps both.
    const snippet = snippetAround(body, findRanges(body, terms));
    return <p className="notes-card-body">
        <NoteLinkText
            text={snippet.text}
            interactive={false}
            renderText={v => <Highlight text={v} ranges={findRanges(v, terms)} />}
        />
    </p>;
}
