/**
 * Púca Notes' keyboard-shortcut sheet. The dialog shell itself is
 * components/NotesDialog.tsx (the .ics import uses it in Púca too).
 */
import { NotesDialog } from '../../components/NotesDialog';

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
    return (
        <NotesDialog title="Keyboard shortcuts" onClose={onClose}>
            <div className="notes-kbd-grid">
                <kbd>/</kbd><span>Search notes</span>
                <kbd>c</kbd><span>New note</span>
                <kbd>r</kbd><span>Refresh from the server</span>
                <kbd>Esc</kbd><span>Close the note, a menu, or clear the search</span>
                <kbd>Enter</kbd><span>In a note: add the next item; while editing an item: save it</span>
                <kbd>?</kbd><span>This help</span>
            </div>
            <p className="notes-labels-hint">In the Calendar:</p>
            <div className="notes-kbd-grid">
                <kbd>t</kbd><span>Today</span>
                <kbd>j</kbd><span>Next month / week / day (also <kbd>n</kbd>)</span>
                <kbd>k</kbd><span>Previous (also <kbd>p</kbd>)</span>
                <kbd>m</kbd><span>Month · <kbd>w</kbd> week · <kbd>d</kbd> day · <kbd>a</kbd> agenda</span>
                <kbd>c</kbd><span>Add on the selected day (instead of a new note)</span>
                <kbd>Arrows</kbd><span>Home/End and PageUp/PageDown too: move around the month; Enter picks the day</span>
                <kbd>[</kbd><span>On a focused item: move it a day earlier (<kbd>]</kbd> later)</span>
            </div>
            <p className="notes-labels-hint">
                Inside a note, drag an item by its grip to reorder it, and drag it right or left to nest or un-nest —
                the same gestures as Púca's Tasks view.
            </p>
        </NotesDialog>
    );
}
