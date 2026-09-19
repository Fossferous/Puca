/**
 * The Reminders view's "At a place" section (Android app only): open items
 * with a place saved on this phone. Ticking one completes it; the row opens
 * its note. The place name is shown here — on the phone that saved it, inside
 * the app — and never in a notification.
 */
import { MapPinIcon } from '../../components/Icons';
import { type NoteCard } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';
import { type PlaceItem } from './useNotesPlaces';

interface PlaceRemindersProps {
    items: PlaceItem[];
    actions: NoteActions;
    onOpen: (card: NoteCard) => void;
}

export function PlaceReminders({ items, actions, onOpen }: PlaceRemindersProps) {
    if (items.length === 0) return null;
    return (
        <section className="notes-reminder-group" aria-label="At a place">
            <h2 className="notes-section-title">At a place</h2>
            {items.map(i => (
                <div key={i.task.id} className="notes-reminder-row" role="button" tabIndex={0}
                    onClick={() => onOpen(i.note)}
                    onKeyDown={e => { if (e.key === 'Enter') onOpen(i.note); }}
                >
                    <input
                        type="checkbox"
                        checked={false}
                        aria-label={`Complete: ${i.task.description}`}
                        onClick={e => e.stopPropagation()}
                        onChange={() => void actions.toggleTask(i.note.ref, i.task, true)}
                    />
                    <span className="notes-reminder-text">{i.task.description}</span>
                    <span className="notes-reminder-note">{i.note.title}</span>
                    <span className="notes-reminder-when" title="Reminds you when this phone arrives there">
                        <MapPinIcon /> {i.place.label}
                    </span>
                </div>
            ))}
        </section>
    );
}
