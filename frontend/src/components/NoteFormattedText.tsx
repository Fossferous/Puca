/**
 * A note's text as it READS: its formatting (bold, italic, underline,
 * strikethrough, bullets — notes/model/noteFormat.ts) drawn, its marks taken
 * off, and its web addresses as links exactly as NoteLinkText makes them.
 * Used wherever a note's text is read rather than typed into: the text
 * field's read view (NoteBodyField), a card on the grid, a sticky note you are
 * not typing in.
 *
 * Every run of words carries `data-at`, where it starts in the text: the read
 * view puts the caret where it was clicked (noteTextOffset.ts), and with the
 * marks gone the drawn words no longer line up with the text one for one.
 *
 * Nothing is fetched to draw it (NoteLinkText's header has why): an address
 * is an anchor and nothing more.
 */
import { Fragment, type ReactNode, useMemo } from 'react';
import { type FmtRun, type Marks, readNoteFormat } from '../notes/model/noteFormat';
import './NoteFormattedText.css';

interface NoteFormattedTextProps {
    text: string;
    /** False = links styled as links, but not links (the card grid). */
    interactive?: boolean;
    /**
     * Draw a run of plain words as something other than the bare string —
     * Púca Notes marks a search's hits in them. `from` is where the run starts
     * in the text. Never asked for a link's own words.
     */
    renderText?: (value: string, from: number) => ReactNode;
}

function wrap(marks: Marks, node: ReactNode): ReactNode {
    let out = node;
    if (marks.strike) out = <s>{out}</s>;
    if (marks.underline) out = <u>{out}</u>;
    if (marks.italic) out = <em>{out}</em>;
    if (marks.bold) out = <strong>{out}</strong>;
    return out;
}

function Run({ run, interactive, renderText }: { run: FmtRun; interactive: boolean; renderText?: NoteFormattedTextProps['renderText'] }) {
    if (run.kind === 'link') {
        const body = interactive ? (
            <a
                className="note-link"
                href={run.href}
                target="_blank"
                rel="noopener noreferrer"
                data-at={run.from}
                // The link router (api/linkRouter.ts) opens it; this only
                // keeps the press from also starting an edit (NoteLinkText).
                onClick={e => e.stopPropagation()}
            >
                {run.text}
            </a>
        ) : <span className="note-link" data-at={run.from}>{run.text}</span>;
        return <>{wrap(run.marks, body)}</>;
    }
    return <>{wrap(run.marks, <span data-at={run.from}>{renderText ? renderText(run.text, run.from) : run.text}</span>)}</>;
}

export function NoteFormattedText({ text, interactive = true, renderText }: NoteFormattedTextProps) {
    const lines = useMemo(() => readNoteFormat(text), [text]);
    return (
        <>
            {lines.map((line, i) => (
                <Fragment key={i}>
                    {i > 0 && '\n'}
                    {line.bullet && (
                        <span className="nf-bullet" data-at={line.bullet.at}>{line.bullet.indent}{'• '}</span>
                    )}
                    {line.runs.map((r, j) => <Run key={j} run={r} interactive={interactive} renderText={renderText} />)}
                </Fragment>
            ))}
        </>
    );
}
