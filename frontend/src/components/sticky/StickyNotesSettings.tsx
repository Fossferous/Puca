/**
 * Settings › Desktop App › Sticky notes (docs/STICKY_NOTES.md): the global
 * "new sticky note" shortcut, whether the notes that were open come back
 * when Púca starts, and whether deleting one from its window asks first.
 * All three are this device's (settingsStore).
 *
 * The shortcut row says what the SHELL did with it, not only what is
 * stored: Windows refuses a combination another app already holds
 * (stickyHotkey.ts), and a shortcut that silently does nothing is the one
 * failure this row exists to show.
 */
import { useEffect, useRef, useState } from 'react';
import { markKeySpentByCapture, setHotkeyCaptureMode } from '../../api/hotkeys';
import { DEFAULT_STICKY_HOTKEY, type KeyBinding } from '../settingsStore';
import { TrashIcon } from '../Icons';
import { stickyHotkeyLabel } from './stickyShell';
import { suspendStickyHotkey, useStickyHotkeyStatus } from './stickyHotkey';

interface StickyNotesSettingsProps {
    hotkey: KeyBinding | null;
    reopen: boolean;
    confirmDelete: boolean;
    onHotkey: (k: KeyBinding | null) => void;
    onReopen: (on: boolean) => void;
    onConfirmDelete: (on: boolean) => void;
}

function captureLabel(e: KeyboardEvent): string {
    if (e.key === ' ') return 'Space';
    if (e.key.length === 1) return e.key.toUpperCase();
    return e.key;
}

export function StickyNotesSettings({ hotkey, reopen, confirmDelete, onHotkey, onReopen, onConfirmDelete }: StickyNotesSettingsProps) {
    const [capturing, setCapturing] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const status = useStickyHotkeyStatus();
    // The capture reads the callback through a ref: a new identity on every
    // render must not restart the capture (and let go of the shortcut and
    // take it back) each time.
    const onHotkeyRef = useRef(onHotkey);
    useEffect(() => { onHotkeyRef.current = onHotkey; });

    useEffect(() => {
        if (!capturing) return;
        // The app's own hotkeys stand down, and so does the shortcut being
        // replaced: pressing it to rebind must not also make a note.
        setHotkeyCaptureMode(true);
        void suspendStickyHotkey(true);
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                markKeySpentByCapture(e.keyCode);
                setCapturing(false);
                setRefusal(null);
                return;
            }
            if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key) || !e.keyCode) return;
            if (!(e.ctrlKey || e.altKey || e.metaKey)) {
                // Shift and a letter is typing, in every app on the PC.
                setRefusal('Hold Ctrl, Alt or the Windows key with it — on its own, or with Shift, it is typing.');
                return;
            }
            markKeySpentByCapture(e.keyCode);
            setRefusal(null);
            onHotkeyRef.current({ keyCode: e.keyCode, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, label: captureLabel(e) });
            setCapturing(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            setHotkeyCaptureMode(false);
            void suspendStickyHotkey(false);
        };
    }, [capturing]);

    const statusLine = (() => {
        if (capturing || !hotkey) return null;
        if (status.state === 'taken') return `${stickyHotkeyLabel(hotkey)} is taken by Windows or another app — choose another.`;
        if (status.state === 'refused') return `${stickyHotkeyLabel(hotkey)} can’t be used: ${status.why}.`;
        return null;
    })();

    return (
        <>
            <div className="settings-option">
                <div className="option-info">
                    <label>New sticky note shortcut</label>
                    <span className="option-hint">
                        Makes a new sticky note from anywhere on this PC, while Púca is running.
                        Ctrl, Alt or the Windows key, and a key.
                        {statusLine && <span className="sticky-settings-warn" role="status" style={{ color: 'var(--text-danger, #d83c3e)', display: 'block' }}>{statusLine}</span>}
                    </span>
                </div>
                <span className="keybind-controls">
                    {capturing && refusal && <span className="keybind-conflict">{refusal}</span>}
                    <button
                        type="button"
                        className="keybind-btn"
                        data-testid="sticky-hotkey"
                        title="Click, then press the combination you want"
                        onClick={() => { setRefusal(null); setCapturing(v => !v); }}
                    >
                        {capturing ? 'Press a combination… (Esc to cancel)' : stickyHotkeyLabel(hotkey)}
                    </button>
                    <button
                        type="button"
                        className="keybind-reset"
                        title={`Back to ${stickyHotkeyLabel(DEFAULT_STICKY_HOTKEY)}`}
                        onClick={() => { setCapturing(false); onHotkey(DEFAULT_STICKY_HOTKEY); }}
                    >
                        Reset
                    </button>
                    <button
                        type="button"
                        className="keybind-clear"
                        onClick={() => { setCapturing(false); onHotkey(null); }}
                        disabled={!hotkey}
                        title="No shortcut"
                        aria-label="No shortcut"
                    >
                        <TrashIcon />
                    </button>
                </span>
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label htmlFor="sticky-reopen">Reopen sticky notes when Púca starts</label>
                    <span className="option-hint">The sticky notes you had open come back where they were.</span>
                </div>
                <input id="sticky-reopen" type="checkbox" checked={reopen} onChange={e => onReopen(e.target.checked)} />
            </div>
            <div className="settings-option">
                <div className="option-info">
                    <label htmlFor="sticky-confirm-delete">Ask before deleting a sticky note</label>
                    <span className="option-hint">Deleting moves the note to the trash in Púca Notes either way.</span>
                </div>
                <input id="sticky-confirm-delete" type="checkbox" checked={confirmDelete} onChange={e => onConfirmDelete(e.target.checked)} />
            </div>
        </>
    );
}
