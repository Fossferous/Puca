/**
 * "Type text…" on the desktop stage: write or paste here, and it is typed on
 * the remote machine as characters (typeText.ts).
 *
 * The desktop forwards PHYSICAL keys, which is right for driving a computer and
 * wrong for some text: an emoji, a character only your IME or AltGr makes, a
 * password from a manager, or a paste into a field that will not take one (the
 * sign-in screen). The phone has always typed text this way; the desktop had
 * no route to it.
 *
 * Keys typed in this box stay here (the stage does not forward keys aimed at
 * a field of its own), Escape closes it, and Ctrl+Enter types it.
 */
import { useEffect, useRef, useState } from 'react';
import { MAX_TYPED_CHARS } from '../api/devices/typeText';

export function DeviceStageTypeText({ peerName, initial = '', onType, onClose }: {
    peerName: string | null;
    initial?: string;
    onType: (text: string) => void;
    onClose: () => void;
}) {
    const [text, setText] = useState(initial);
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useEffect(() => { ref.current?.focus(); }, []);
    const tooLong = text.length > MAX_TYPED_CHARS;
    const submit = () => {
        if (!text || tooLong) return;
        onType(text);
        onClose();
    };
    const pc = peerName?.trim() || 'that computer';
    return (
        <div
            className="device-stage-typetext-backdrop"
            onPointerDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}
        >
            <div className="device-stage-typetext" role="dialog" aria-modal="true" aria-labelledby="dstt-title">
                <strong id="dstt-title">Type text on {pc}</strong>
                <span className="device-stage-typetext-help">
                    Typed as characters where the cursor is over there, so its keyboard layout cannot change them.
                    New lines press Enter.
                </span>
                <textarea
                    ref={ref}
                    value={text}
                    rows={5}
                    spellCheck={false}
                    aria-label="Text to type"
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
                    }}
                />
                {tooLong && (
                    <span className="device-stage-error">
                        That is more than {MAX_TYPED_CHARS.toLocaleString()} characters — send it as the clipboard instead.
                    </span>
                )}
                <div className="device-stage-typetext-actions">
                    <button type="button" className="device-stage-btn" onClick={onClose}>Cancel</button>
                    <button
                        type="button"
                        className="device-stage-btn device-stage-btn-primary"
                        disabled={!text || tooLong}
                        title="Ctrl+Enter"
                        onClick={submit}
                    >
                        Type it
                    </button>
                </div>
            </div>
        </div>
    );
}
