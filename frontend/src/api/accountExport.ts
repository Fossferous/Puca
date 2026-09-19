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
import { openSelfField } from './listSeal';
import { TASK_DECRYPT_FAILED, isUndecryptable } from './decryptMarkers';
import { getActiveIdentity, openAccountBlob, parseEnvelopeEx } from './e2ee';
import { isMobile } from './platform';
import { saveAttachment, type SaveResult } from './saveAttachment';
import { PUCA_FOLDER, saveTextToDevice } from './saveToDevice';

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
    channelTask: (channelId: number, stored: string, kind: 'chan-task' | 'chan-taskatt' | 'chan-taskevt' | 'chan-tasksnz', ownerId: number) => Promise<string>;
    selfText: (stored: string) => Promise<string>;
    /** A personal list's note text / picture sidecar (migration 065): the
     *  STRICT self reader — those fields never held plaintext. */
    listField?: (stored: string) => Promise<string>;
    /** A sealed-to-self account blob (migration 067); null = cannot open. */
    accountBlob?: (name: string, stored: string, userId: number) => Promise<string | null>;
}

const appReaders: ExportReaders = {
    channelMessage: decryptChannelContent,
    dmMessage: decryptDMContent,
    channelTask: openChannelTaskText,
    selfText: openSelfTaskText,
    listField: openSelfField,
    accountBlob: async (name, stored, userId) => {
        const id = getActiveIdentity();
        return id ? openAccountBlob(id, userId, name, stored) : null;
    },
};

/** A list's `body` / `attachments` for the file: absent stays absent (an
 *  older server), none is null, and a value that is not an envelope is
 *  reported unreadable rather than written out as if it were the owner's
 *  text — these fields never held plaintext (api/listSeal.ts). */
async function openListField(stored: unknown, readers: ExportReaders, stats: OpenStats): Promise<OpenedText | null | undefined> {
    if (stored === undefined) return undefined;
    if (typeof stored !== 'string' || stored === '') return null;
    if (envelopeMeta(stored) === null) {
        stats.sealed++;
        stats.unreadable++;
        return { content_ciphertext: stored, envelope: null, text: null, unreadable: TASK_DECRYPT_FAILED };
    }
    const read = readers.listField ?? readers.selfText;
    return open(stored, () => read(stored), stats);
}

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
 * A task's sealed schedule and snooze (066+ servers), opened like its
 * attachments. Keys the server did not send stay absent. These columns never
 * had a plaintext era, so a value that is not an envelope is reported as
 * unreadable rather than exported as if it were the user's text.
 */
async function openTaskTimingForExport(
    t: RawTask,
    viaChannel: (channelId: number, read: () => Promise<string>) => () => Promise<string>,
    readers: ExportReaders,
    stats: OpenStats,
): Promise<{ schedule?: OpenedText | null; snooze?: OpenedText | null }> {
    const out: { schedule?: OpenedText | null; snooze?: OpenedText | null } = {};
    for (const [key, kind] of [['schedule', 'chan-taskevt'], ['snooze', 'chan-tasksnz']] as const) {
        if (!(key in t)) continue;
        const stored = t[key];
        if (typeof stored !== 'string' || stored === '') { out[key] = null; continue; }
        if (envelopeMeta(stored) === null) {
            stats.sealed++;
            stats.unreadable++;
            out[key] = { content_ciphertext: stored, envelope: null, text: null, unreadable: '[Not sealed — a timing value must be encrypted; not read as text]' };
            continue;
        }
        const read = t.channel_id !== null
            ? viaChannel(t.channel_id, () => readers.channelTask(t.channel_id!, stored, kind, t.created_by))
            : () => readers.selfText(stored);
        out[key] = await open(stored, read, stats);
    }
    return out;
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
        tasks.push({ ...rest, description: opened, attachments: attachmentsOpened, ...await openTaskTimingForExport(t, viaChannel, readers, stats) });
        tick();
    }
    const task_lists = [];
    for (const l of raw.task_lists) {
        const { title, body, attachments, ...rest } = l;
        const extra: Record<string, OpenedText | null> = {};
        const openedBody = await openListField(body, readers, stats);
        if (openedBody !== undefined) extra.body = openedBody;
        const openedAtt = await openListField(attachments, readers, stats);
        if (openedAtt !== undefined) extra.attachments = openedAtt;
        task_lists.push({ ...rest, title: await open(title, () => readers.selfText(title), stats), ...extra });
        tick();
    }

    // Sealed account blobs have their OWN envelope (not a message envelope),
    // so they are opened here rather than through open().
    const sealed_blobs = [];
    const readBlob = readers.accountBlob ?? appReaders.accountBlob!;
    for (const b of Array.isArray(raw.sealed_blobs) ? raw.sealed_blobs as { name: string; blob_ciphertext: string }[] : []) {
        stats.sealed++;
        let text: string | null = null;
        try { text = await readBlob(b.name, b.blob_ciphertext, me); } catch { text = null; }
        if (text === null) stats.unreadable++; else stats.opened++;
        sealed_blobs.push({ ...b, text, unreadable: text === null ? '[Encrypted — could not be opened on this device]' : null });
    }

    const doc: Record<string, unknown> = {
        ...raw,
        channel_messages,
        dm_messages,
        tasks,
        task_lists,
        sealed_blobs,
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
            // Documents/Puca/<name> through @capacitor/filesystem (api/saveToDevice.ts).
            return await saveTextToDevice(PUCA_FOLDER, name, json);
        } catch (e) {
            console.warn('[export] could not write the export to this device:', e);
            // DO NOT blame disk space alone. Writing into the public Documents
            // folder needs no grant on Android 11+ (scoped storage), but on
            // Android 10 and older it needs storage permission — and that is
            // the likeliest cause of a failure here, on exactly the devices
            // least likely to be short of space. Naming the wrong cause sends
            // someone to delete photos over a permission dialog.
            throw new Error(
                'Could not save the export to this device. On Android 10 and older, Púca needs '
                + 'permission to write to Documents — allow storage access in Android Settings → '
                + 'Apps → Púca → Permissions, then try again. Otherwise check you have free space, '
                + 'or run the export from the desktop app or a browser.'
            );
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
