/**
 * Data export: the account's own rows, opened with this device's identity,
 * saved as one JSON file.
 *
 * The server can hand over ROWS (GET /account/export, src/export_handlers.rs)
 * but not text — every message, task and list title it holds is ciphertext.
 * So the export is assembled here: each sealed body is opened through the
 * SAME reader the app renders it with (channel messages, DMs, tasks), and the
 * file carries the plaintext beside the ciphertext as stored. What this
 * identity cannot open — a channel epoch nobody wrapped for us, a peer whose
 * key changed, an envelope version this build predates — is reported on the
 * row as `unreadable` with the reader's reason, never dropped silently.
 *
 * ONLY THE USER'S OWN WRITES are in the server's document (other people's
 * messages are theirs), and the file is PLAINTEXT ON DISK where it could be
 * opened — the one place the product deliberately inverts its storage
 * posture, which the UI says before the button is pressed.
 */
import { requestAccountExport } from './auth';
import { decryptChannelContent } from './servers';
import { decryptDMContent } from './dms';
import { openChannelTaskText, openSelfTaskText } from './tasks';
import { isUndecryptable } from './decryptMarkers';
import { parseEnvelopeEx } from './e2ee';
import { isMobile } from './platform';
import { saveAttachment, type SaveResult } from './saveAttachment';

/** A sealed body's parsed header — what the row looks like without the key. */
export interface EnvelopeMeta {
    version: number;
    type: 'dm' | 'ch' | 'self' | 'unknown';
    epoch: number | null;
}

/** How an opened body is written into the file, beside its ciphertext. */
export interface OpenedText {
    /** The row's `content` as the server stores it — never altered. */
    content_ciphertext: string;
    /** Parsed envelope header, or null for a legacy plaintext row. */
    envelope: EnvelopeMeta | null;
    /** The plaintext, when this identity could open it. */
    text: string | null;
    /** The reader's reason when it could not (a decrypt-failure marker). */
    unreadable: string | null;
}

export interface RawChannelMessage {
    id: string;
    channel_id: number;
    content: string;
    [k: string]: unknown;
}

export interface RawDmMessage {
    id: string;
    partner_user_id: number;
    content: string;
    [k: string]: unknown;
}

export interface RawTask {
    id: number;
    channel_id: number | null;
    list_id: number | null;
    description: string;
    attachments: string | null;
    created_by: number;
    [k: string]: unknown;
}

export interface RawTaskList {
    id: number;
    title: string;
    [k: string]: unknown;
}

/** The server's document (src/export_handlers.rs). Sections this module
 *  does not open are carried through untouched. */
export interface AccountExportRaw {
    format: string;
    user_id: number;
    channel_messages: RawChannelMessage[];
    dm_messages: RawDmMessage[];
    tasks: RawTask[];
    task_lists: RawTaskList[];
    [k: string]: unknown;
}

export interface OpenStats {
    /** Sealed bodies seen (legacy plaintext rows are not counted). */
    sealed: number;
    opened: number;
    unreadable: number;
}

/** The readers, injectable so the assembly can be tested without keys. */
export interface ExportReaders {
    channelMessage: (channelId: number, content: string, senderId: number) => Promise<string>;
    dmMessage: (content: string, partnerUserId: number, senderId: number) => Promise<string>;
    channelTask: (channelId: number, stored: string, kind: 'chan-task' | 'chan-taskatt', ownerId: number) => Promise<string>;
    selfText: (stored: string) => Promise<string>;
}

const appReaders: ExportReaders = {
    channelMessage: decryptChannelContent,
    dmMessage: decryptDMContent,
    channelTask: openChannelTaskText,
    selfText: openSelfTaskText,
};

export function envelopeMeta(content: string): EnvelopeMeta | null {
    const parsed = parseEnvelopeEx(content);
    if (parsed.kind === 'unsupported-version') return { version: parsed.v, type: 'unknown', epoch: null };
    if (parsed.kind !== 'envelope') return null;
    return { version: parsed.env.v, type: parsed.env.t, epoch: parsed.env.epoch ?? null };
}

/** Run one reader over one stored body and shape the result for the file. */
async function open(stored: string, read: () => Promise<string>, stats: OpenStats): Promise<OpenedText> {
    const envelope = envelopeMeta(stored);
    if (envelope === null) {
        // Legacy plaintext row: nothing to open, and nothing to count.
        return { content_ciphertext: stored, envelope: null, text: stored, unreadable: null };
    }
    stats.sealed++;
    let out: string;
    try {
        out = await read();
    } catch (e) {
        // A reader that throws (identity locked, a key fetch that failed) is
        // this row's failure, not the export's: report it here and go on.
        stats.unreadable++;
        return { content_ciphertext: stored, envelope, text: null, unreadable: `[Encrypted — ${e instanceof Error ? e.message : String(e)}]` };
    }
    if (isUndecryptable(out)) {
        stats.unreadable++;
        return { content_ciphertext: stored, envelope, text: null, unreadable: out };
    }
    stats.opened++;
    return { content_ciphertext: stored, envelope, text: out, unreadable: null };
}

/**
 * Open every sealed body in the server's document that this identity can,
 * in place of the raw `content` fields. Pure over its readers; the app's own
 * readers are the default.
 */
export async function openExport(
    raw: AccountExportRaw,
    readers: ExportReaders = appReaders,
    onProgress?: (done: number, total: number) => void,
): Promise<{ doc: Record<string, unknown>; stats: OpenStats }> {
    const stats: OpenStats = { sealed: 0, opened: 0, unreadable: 0 };
    const me = raw.user_id;
    const total = raw.channel_messages.length + raw.dm_messages.length + raw.tasks.length + raw.task_lists.length;
    let done = 0;
    const tick = () => { done++; if (onProgress && (done % 50 === 0 || done === total)) onProgress(done, total); };

    // A channel whose reader THROWS — the key cannot be fetched at all: the
    // user has left it, the server refuses, the identity is locked — throws
    // for every row in it, and each attempt is a network round trip. Remember
    // the reason per channel and apply it to the rest without asking again.
    // Marker RETURNS (key unavailable for one epoch) are not memoised: they
    // come from cached state and differ per epoch.
    //
    // ONLY A SETTLED ANSWER IS REMEMBERED. One dropped connection used to
    // seal a whole channel for the rest of the export, so a moment of bad
    // Wi-Fi turned a year of readable messages into ciphertext with no
    // warning beyond a count. A transport failure is retried on the next row
    // instead; a refusal (this account cannot have that key) still costs one
    // round trip and no more.
    const deadChannels = new Map<number, string>();
    const settledRefusal = (e: unknown): boolean => {
        const status = (e as { status?: number } | null)?.status;
        if (typeof status === 'number') return status >= 400 && status < 500;
        const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
        return m.includes('locked') || m.includes('no key') || m.includes('not a member')
            || m.includes('forbidden') || m.includes('unauthor');
    };
    const viaChannel = (channelId: number, read: () => Promise<string>): (() => Promise<string>) => {
        const known = deadChannels.get(channelId);
        if (known !== undefined) return () => Promise.reject(new Error(known));
        return () => read().catch((e: unknown) => {
            if (settledRefusal(e)) {
                deadChannels.set(channelId, e instanceof Error ? e.message : String(e));
            }
            throw e;
        });
    };

    const channel_messages = [];
    for (const m of raw.channel_messages) {
        const { content, ...rest } = m;
        const read = viaChannel(m.channel_id, () => readers.channelMessage(m.channel_id, content, me));
        channel_messages.push({ ...rest, ...(await open(content, read, stats)) });
        tick();
    }
    const dm_messages = [];
    for (const m of raw.dm_messages) {
        const { content, ...rest } = m;
        dm_messages.push({ ...rest, ...(await open(content, () => readers.dmMessage(content, m.partner_user_id, me), stats)) });
        tick();
    }
    const tasks = [];
    for (const t of raw.tasks) {
        const { description, attachments, ...rest } = t;
        const readText = t.channel_id !== null
            ? viaChannel(t.channel_id, () => readers.channelTask(t.channel_id!, description, 'chan-task', t.created_by))
            : () => readers.selfText(description);
        const opened = await open(description, readText, stats);
        let attachmentsOpened: OpenedText | null = null;
        if (attachments) {
            const readAtt = t.channel_id !== null
                ? viaChannel(t.channel_id, () => readers.channelTask(t.channel_id!, attachments, 'chan-taskatt', t.created_by))
                : () => readers.selfText(attachments);
            attachmentsOpened = await open(attachments, readAtt, stats);
        }
        tasks.push({ ...rest, description: opened, attachments: attachmentsOpened });
        tick();
    }
    const task_lists = [];
    for (const l of raw.task_lists) {
        const { title, ...rest } = l;
        task_lists.push({ ...rest, title: await open(title, () => readers.selfText(title), stats) });
        tick();
    }

    const doc: Record<string, unknown> = {
        ...raw,
        channel_messages,
        dm_messages,
        tasks,
        task_lists,
        opened_on: {
            at: new Date().toISOString(),
            sealed_bodies: stats.sealed,
            opened: stats.opened,
            unreadable: stats.unreadable,
            note: 'Each sealed body carries content_ciphertext (as the server stores it) and either text (opened on the exporting device) or unreadable (why it could not be). Bodies this device could not open are still here as ciphertext.',
        },
    };
    return { doc, stats };
}

/** `puca-export-<user>-<yyyy-mm-dd>.json`, safe as a file name. */
export function exportFileName(username: string, now = new Date()): string {
    const user = (username || 'account').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
    const day = now.toISOString().slice(0, 10);
    return `puca-export-${user}-${day}.json`;
}

/**
 * Write the document where this platform keeps files:
 *  - Android: `Documents/Puca/<name>` through @capacitor/filesystem — a file
 *    the app creates in the public Documents folder needs no all-files grant,
 *    and a blob-URL anchor click is not a download in a WebView.
 *  - Desktop: the attachment save path (Downloads/Puca, or "Ask where to
 *    save files"), i.e. the same command every received file uses.
 *  - Web: a transient download anchor, as attachments do.
 */
export async function saveExportFile(doc: Record<string, unknown>, username: string): Promise<SaveResult> {
    const name = exportFileName(username);
    const json = JSON.stringify(doc, null, 2);

    if (isMobile()) {
        // A phone has no download tray and a blob-URL anchor click writes
        // NOTHING in a WebView, so the anchor below is not a fallback here —
        // it is a silent failure that then reports "Downloaded as …". Either
        // the real write happens or the caller is told it did not.
        try {
            const { Capacitor } = await import('@capacitor/core');
            if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('Filesystem')) {
                throw new Error('this app cannot write files on this platform');
            }
            {
                const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
                await Filesystem.writeFile({
                    path: `Puca/${name}`,
                    data: json,
                    directory: Directory.Documents,
                    encoding: Encoding.UTF8,
                    recursive: true,
                });
                return { where: `Documents/Puca/${name}`, onDisk: true };
            }
        } catch (e) {
            console.warn('[export] could not write the export to this device:', e);
            throw new Error('Could not save the export to this device. Free some space and try again, or run the export from the desktop app.');
        }
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        return await saveAttachment(url, name);
    } finally {
        // Late, as the attachment path does: revoking at once can cancel a
        // browser download before it has read the blob.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}

/** One sentence the user can trust about what the saved file holds. */
export function resultSummary(where: string, onDisk: boolean, stats: OpenStats): string {
    const saved = onDisk ? `Saved to ${where}.` : `Downloaded as ${where}.`;
    if (stats.sealed === 0) return `${saved} Nothing in it was encrypted.`;
    const read = `${stats.opened} of ${stats.sealed} encrypted item${stats.sealed === 1 ? '' : 's'} could be read on this device`;
    return stats.unreadable > 0
        ? `${saved} ${read}; ${stats.unreadable} ${stats.unreadable === 1 ? 'is' : 'are'} included as ciphertext only.`
        : `${saved} ${read}.`;
}

/** Proving and fetching are one round trip (requestAccountExport), so they
 *  are one phase; the label says both. */
export type ExportPhase =
    | { phase: 'proving' }
    | { phase: 'opening'; done: number; total: number }
    | { phase: 'saving' };

/**
 * The whole flow behind the Settings button: prove the password, fetch,
 * open, save. Throws with a user-facing message; the caller shows it.
 */
export async function runAccountExport(
    username: string,
    password: string,
    onPhase: (p: ExportPhase) => void = () => {},
): Promise<{ saved: SaveResult; stats: OpenStats }> {
    onPhase({ phase: 'proving' });
    const raw = await requestAccountExport(username, password) as AccountExportRaw;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.channel_messages)) {
        throw new Error('The server answered with something that is not an export document.');
    }
    const { doc, stats } = await openExport(raw, appReaders, (done, total) => onPhase({ phase: 'opening', done, total }));
    onPhase({ phase: 'saving' });
    const saved = await saveExportFile(doc, username);
    return { saved, stats };
}
