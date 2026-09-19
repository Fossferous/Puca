/**
 * "Edited <when>" beside a note's "Created" — hidden when the two are the
 * same (within a minute: a note created with its items is stamped by each
 * insert). Edit times come from the server's content-diff triggers (a
 * reorder or a snooze is not an edit), so this reads what people mean.
 */
import '../timing.css';

export function EditedStamp({ createdAt, updatedAt }: { createdAt?: string; updatedAt?: string }) {
    if (!updatedAt) return null;
    const u = Date.parse(updatedAt);
    const c = createdAt ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(u) || (Number.isFinite(c) && u - c < 60_000)) return null;
    const d = new Date(u);
    const sameDay = d.toDateString() === new Date().toDateString();
    return (
        <span className="notes-edited" title={d.toLocaleString()}>
            Edited {sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString()}
        </span>
    );
}
