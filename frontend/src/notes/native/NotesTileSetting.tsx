/**
 * "Add the quick tile" in Púca Notes' account menu — Android app only, and
 * only in an APK that offers it (API level 2; an older one has no such method
 * and this renders nothing, like NotesLocationSettings).
 *
 * The tile is one button in the notification shade that opens a new note. It
 * carries a fixed label and nothing else: the shade is reachable over a
 * locked screen on some phones, so it must never show a count or a title
 * (NotesTileService.java).
 *
 * Android 13+ can ask for it with a system dialog; below that, and when the
 * system refuses, the row says where to add it by hand instead of leaving a
 * button that appears to do nothing.
 */
import { useEffect, useState } from 'react';
import { GridIcon } from '../../components/Icons';
import { isAndroidApp } from '../../api/platform';
import { notesNativeFeatures, requestNativeAddTile } from './notesNative';

export function NotesTileSetting() {
    const [offered, setOffered] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    useEffect(() => {
        if (!isAndroidApp()) return;
        let live = true;
        void notesNativeFeatures().then(f => { if (live) setOffered(f.includes('tile')); });
        return () => { live = false; };
    }, []);

    if (!isAndroidApp() || !offered) return null;

    const add = () => {
        void requestNativeAddTile().then(ok => {
            setNote(ok ? null : 'This phone can’t offer it — add “New note” from the shade’s Edit screen.');
        });
    };

    return (
        <div className="notes-menu-tile">
            <button type="button" className="notes-menu-item" onClick={add}>
                <GridIcon />
                Add the quick tile
            </button>
            {note && <p className="notes-menu-hint">{note}</p>}
        </div>
    );
}
