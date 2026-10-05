/**
 * The placeholder an encrypted attachment shows while it downloads (see
 * api/attachmentProgress.ts): the bytes received so far — and out of how
 * many, when the server says — instead of a static label that looked frozen
 * for as long as a large video took to arrive.
 */
import { useEffect, useState, type Ref } from 'react';
import { watchAttachmentBytes } from '../api/attachmentProgress';
import { bytesOfText } from '../api/loadProgressText';
import { LockIcon } from './Icons';

export function AttachmentLoading({ fileId, ref }: { fileId: string; ref?: Ref<HTMLSpanElement> }) {
    // A string, so a chunk that does not change the readout re-renders nothing.
    const [shown, setShown] = useState<string | null>(null);
    useEffect(() => watchAttachmentBytes(fileId, (b) => setShown(bytesOfText(b.received, b.total))), [fileId]);
    return (
        <span className="message-attachment loading" ref={ref}>
            <LockIcon /> {shown ? `Loading attachment… ${shown}` : 'Loading attachment…'}
        </span>
    );
}
