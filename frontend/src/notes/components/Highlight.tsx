/**
 * Text with the searched-for words marked. Plain React children only — never
 * dangerouslySetInnerHTML: the text is the user's own decrypted note, and the
 * ranges come from noteSearch.ts, so there is nothing to gain by building HTML
 * and everything to lose.
 *
 * With no ranges it renders exactly the string it was given, which is what
 * lets every caller pass `ranges` unconditionally.
 */
import { Fragment } from 'react';
import { type Range } from '../model/noteSearch';

interface HighlightProps {
    text: string;
    ranges?: readonly Range[];
}

export function Highlight({ text, ranges }: HighlightProps) {
    if (!ranges || ranges.length === 0) return <>{text}</>;
    const parts: React.ReactNode[] = [];
    let at = 0;
    ranges.forEach((r, i) => {
        const start = Math.max(at, Math.min(r.start, text.length));
        const end = Math.max(start, Math.min(r.end, text.length));
        if (start > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, start)}</Fragment>);
        if (end > start) parts.push(<mark key={`m${i}`} className="notes-hl">{text.slice(start, end)}</mark>);
        at = end;
    });
    if (at < text.length) parts.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
    return <>{parts}</>;
}
