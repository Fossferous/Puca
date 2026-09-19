/**
 * Export and share for Púca Notes, on every platform it runs on.
 *
 *  - Save (Markdown or JSON): a download in the browser; in the Android app a
 *    file in Documents/Puca Notes/ (noteText.saveNotesExport), with the
 *    place it landed — or the real reason it did not — in a toast.
 *  - Share (Android app only): the same text through Android's share sheet,
 *    so it can go to Files, Drive, e-mail or a messenger. The browser offers
 *    no equivalent worth the name here, so the menu hides it there.
 *
 * What leaves is PLAINTEXT: an export is the user taking their notes out of
 * the encrypted store on purpose. Every path says so before or as it happens.
 */
import { pushMessageToast } from '../../components/messageToastBus';
import { type NoteCard } from '../model/notesModel';
import { fileStamp, noteToMarkdown, notesToJson, notesToMarkdown, saveNotesExport } from '../model/noteText';
import { notesNativeAvailable, shareText } from './notesNative';

/** Share is offered only where the plugin can do it. */
export function canShareNotes(): boolean {
    return notesNativeAvailable();
}

function payload(cards: NoteCard[], format: 'md' | 'json', now: number) {
    const base = `puca-notes-${fileStamp(now)}`;
    return format === 'md'
        ? { name: `${base}.md`, text: notesToMarkdown(cards), mime: 'text/markdown;charset=utf-8' }
        : { name: `${base}.json`, text: notesToJson(cards, new Date(now).toISOString()), mime: 'application/json' };
}

export async function exportNotes(cards: NoteCard[], format: 'md' | 'json'): Promise<void> {
    const p = payload(cards, format, Date.now());
    try {
        const r = await saveNotesExport(p.name, p.text, p.mime);
        if (r.onDisk) pushMessageToast({ title: `Saved to ${r.where} — this copy is not encrypted` });
    } catch (e) {
        pushMessageToast({ title: e instanceof Error ? e.message : 'Couldn’t save the export' });
    }
}

const SHARE_WARNING = 'Share as a plain, unencrypted file? Whichever app you pick receives the text of your notes.';

async function share(filename: string, text: string, mime: string): Promise<void> {
    if (!window.confirm(SHARE_WARNING)) return;
    const r = await shareText({ filename, text, mime, subject: filename });
    if (!r.ok) pushMessageToast({ title: r.reason === 'unsupported' ? 'Sharing needs the current Púca Notes app' : r.reason });
}

/** Every note, as Markdown, to the share sheet. */
export async function shareNotes(cards: NoteCard[]): Promise<void> {
    const p = payload(cards, 'md', Date.now());
    // text/plain, not text/markdown: most share targets do not list the
    // latter, and a .md file is plain text to all of them.
    await share(p.name, p.text, 'text/plain');
}

/** One note, as Markdown, to the share sheet. */
export async function shareNote(card: NoteCard): Promise<void> {
    const title = card.title.trim() || 'note';
    await share(`${title}.md`, noteToMarkdown(card), 'text/plain');
}
