/**
 * A message as a compact preview: its text, with every attachment shown as an
 * icon and its file name instead of the `![name](sovereign-enc:…?k=…)` ref
 * (which carries the file's key). The rule lives in api/messagePreview.ts;
 * this only draws it. Rendered INSIDE each surface's own text span (reply
 * snapshot, "Replying to" bar, pinned list, search results, collection feed),
 * so that span's ellipsis and colour still apply.
 *
 * Icons match the message list: a picture for an image, the note its audio
 * player's card carries for audio, the paperclip the message's own file chip
 * uses for any other file, the clip frame for a clip,
 * and the eye-off of the composer's spoiler toggle for a spoiler (whose name
 * stays hidden — the name can be the spoiler).
 */
import { messagePreviewSegments, segmentDisplayName, segmentLabel, type PreviewSegment } from '../api/messagePreview';
import { ClipIcon, EyeOffIcon, ImageIcon, MusicIcon, PaperclipIcon } from './Icons';
import './MessagePreview.css';

function SegmentIcon({ seg }: { seg: Exclude<PreviewSegment, { type: 'text' }> }) {
    if (seg.type === 'clip') return <ClipIcon />;
    if (seg.spoiler) return <EyeOffIcon />;
    if (seg.kind === 'image') return <ImageIcon />;
    if (seg.kind === 'audio') return <MusicIcon />;
    return <PaperclipIcon />;
}

export function MessagePreview({ content, max }: { content: string; max?: number }) {
    const segments = messagePreviewSegments(content, max);
    return (
        <>
            {segments.map((seg, i) => seg.type === 'text'
                ? <span key={i}>{seg.text}</span>
                : (
                    <span
                        key={i}
                        className={`msg-preview-att msg-preview-att-${seg.type === 'clip' ? 'clip' : seg.spoiler ? 'spoiler' : seg.kind}`}
                        title={segmentLabel(seg)}
                    >
                        <span className="msg-preview-att-icon" aria-hidden="true"><SegmentIcon seg={seg} /></span>
                        <span className="msg-preview-att-name">{segmentDisplayName(seg)}</span>
                    </span>
                ))}
        </>
    );
}
