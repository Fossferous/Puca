/**
 * A note's text (or an item's), with its web addresses shown as links. The
 * ONE renderer both front doors use — Púca Notes' editor and cards, and
 * Púca's Tasks view — so a note reads the same through either.
 *
 * Nothing is fetched to render a link: `linkSegments` works out where it goes
 * from the text this device already decrypted (see that module's header for
 * why a favicon or an OG scrape is refused). There is no `<img>`, no
 * `preconnect`, no prefetch here, and `src/tests/noteLinkText.test.tsx`
 * asserts the render makes ZERO network calls — that is the test a future
 * "just a little site icon" has to get past.
 *
 * `rel="noopener noreferrer"`, not `noopener` alone: for content the server
 * itself cannot read, the destination must not learn the origin and path of
 * the page that was being read.
 *
 * `interactive={false}` marks a link without making it tappable. The card
 * grid uses that on purpose: the card's own tap opens the note, and a 44px
 * tap target cannot live inside a line-clamped card preview at 390px.
 */
import { type ReactNode } from 'react';
import { linkSegments } from '../utils/linkSegments';
import { openExternalUrl } from '../api/openExternal';

interface NoteLinkTextProps {
    text: string;
    /** False = styled as a link, but not a link (see the header). */
    interactive?: boolean;
    /**
     * Render the PLAIN stretches between links as something other than the
     * bare string — Púca Notes marks a search's hits inside them. Per
     * segment, so the ranges a caller works out are the segment's own and no
     * offset arithmetic can drift. A link's own text is never re-rendered:
     * it is already an element, and a <mark> inside an anchor would make the
     * tap target ambiguous.
     */
    renderText?: (value: string) => ReactNode;
}

export function NoteLinkText({ text, interactive = true, renderText }: NoteLinkTextProps) {
    const segments = linkSegments(text);
    return (
        <>
            {segments.map((s, i) => {
                if (s.kind === 'text') return renderText ? <span key={i}>{renderText(s.value)}</span> : s.value;
                if (!interactive) return <span key={i} className="note-link">{s.text}</span>;
                return (
                    <a
                        key={i}
                        className="note-link"
                        href={s.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        // The handler, not the anchor's own navigation: the
                        // Tauri shell denies new windows, and the Notes
                        // WebView has no multiple-window support either.
                        // stopPropagation is what keeps a link tap from also
                        // starting an inline item edit or opening the note.
                        onClick={e => { e.preventDefault(); e.stopPropagation(); openExternalUrl(s.href); }}
                    >
                        {s.text}
                    </a>
                );
            })}
        </>
    );
}
