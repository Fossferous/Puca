/**
 * "Send diagnostics to the server owner": one click that puts everything the
 * app knows about a stream or call problem in front of the person who runs the
 * server, as a file in an ordinary end-to-end encrypted DM.
 *
 * WHY. "Copy diagnostics" is a four-second snapshot, and the history that
 * explains a problem lives in puca.log, which nobody will dig out of
 * %LOCALAPPDATA% on request. A server owner asked for exactly this: a way to
 * get an extensive log off someone without talking them through Explorer.
 *
 * WHAT GOES. The same report "Copy diagnostics" builds (encoders, live call
 * measurements), then, on desktop, the whole app log (support_log.rs: the
 * rotated files too, Windows account name removed from paths). No messages,
 * keys, tokens, email or addresses are in either. It travels as a normal DM
 * attachment: sealed on this device, readable only by the two people in the
 * conversation.
 *
 * WHO GETS IT. The owner of a server this person is in, and only that: the
 * recipient is chosen from server owners, so a report cannot be steered to an
 * arbitrary account by anything but the person's own pick.
 */
import type { Server } from './servers';
import { QUICK_TIMEOUT_MS, withTimeout } from './withTimeout';

/** A server owner the report can go to. One entry per owner: someone in two
 *  servers run by the same person is not asked to choose between them. */
export interface OwnerChoice {
    ownerId: number;
    /** The server the choice is named after (the preferred one when the owner
     *  runs several). */
    serverId: string;
    serverName: string;
    isSelf: boolean;
}

/**
 * Owners of the servers `me` is in, the preferred server's owner first, then
 * by server name. The person's own servers stay in the list (a report to
 * yourself lands in your own notes conversation, which is how an owner tries
 * the feature), marked so the UI can say so.
 */
export function ownerChoices(servers: Server[], me: number, preferredServerId?: string | null): OwnerChoice[] {
    const ordered = [...servers].sort((a, b) =>
        Number(b.id === preferredServerId) - Number(a.id === preferredServerId)
        || a.name.localeCompare(b.name));
    const seen = new Set<number>();
    const out: OwnerChoice[] = [];
    for (const s of ordered) {
        if (!Number.isFinite(s.owner_id) || seen.has(s.owner_id)) continue;
        seen.add(s.owner_id);
        out.push({ ownerId: s.owner_id, serverId: s.id, serverName: s.name, isSelf: s.owner_id === me });
    }
    return out;
}

/** `puca-report-0.9.828-20260929-2242.txt`, local time: the recipient sorts
 *  a folder of these by when they were sent. */
export function reportFileName(version: string, now: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
    const v = version.replace(/[^0-9A-Za-z.-]/g, '_') || 'unknown';
    return `puca-report-${v}-${stamp}.txt`;
}

/** The DM text that carries the file. The note is the person's own words, one
 *  paragraph, kept short: the file is the report. */
export function reportMessage(version: string, note: string, attachmentMarkdown: string): string {
    const said = note.replace(/\s+/g, ' ').trim().slice(0, 500);
    return [
        `Diagnostics report (Púca ${version})`,
        said ? `"${said}"` : '',
        attachmentMarkdown,
    ].filter(Boolean).join('\n');
}

/** The report file's text: the diagnostics snapshot, then the log. */
export function reportText(diagnostics: string, log: string | null): string {
    return [
        diagnostics.trimEnd(),
        '',
        '===================== app log =====================',
        log ?? '(this platform keeps no app log file: the report above is everything)',
        '',
    ].join('\n');
}

/** Everything the send touches, injectable for the tests. The `signal` each
 *  network step receives is aborted when the send gives up (a step timed out,
 *  or the person closed the dialog), so the request really stops. */
export interface SendDeps {
    version: () => Promise<string>;
    diagnostics: () => Promise<string>;
    /** null when there is no log file on this platform. */
    readLog: () => Promise<string | null>;
    upload: (file: File, signal?: AbortSignal) => Promise<string>;
    openConversation: (userId: number, signal?: AbortSignal) => Promise<{ id: string }>;
    encrypt: (text: string, recipientId: number) => Promise<string>;
    post: (conversationId: string, wire: string, signal?: AbortSignal) => Promise<unknown>;
    now: () => Date;
}

/** Each step's own budget. A step that never answers must cost the send, with
 *  a sentence the dialog can show, never the person's ability to close it
 *  (the modal used to lock Close while sending, so one stalled step trapped
 *  them there for good). */
const NETWORK_STEP_MS = 20_000;
const UPLOAD_BASE_MS = 60_000;
/** Slowest uplink the upload is still waited for: 64 KB/s on top of the base,
 *  so a multi-megabyte puca.log on a poor link gets its time. */
const UPLOAD_FLOOR_BYTES_PER_S = 64 * 1024;
/** The measurement (diagnosticsReport.ts's STEP_TIMEOUT_MS: its 4 s window plus
 *  the stats calls either side) and a whole puca.log read off disk through the
 *  shell. */
const MEASURE_MS = 12_000;
const READ_LOG_MS = 12_000;

export const uploadTimeoutMs = (bytes: number): number =>
    UPLOAD_BASE_MS + Math.ceil(bytes / UPLOAD_FLOOR_BYTES_PER_S) * 1000;

function abortError(): Error {
    const e = new Error('Sending was cancelled');
    e.name = 'AbortError';
    return e;
}

/** One bounded step: rejects on its own timeout, or at once when the send is
 *  aborted, whichever the step's promise does not beat. */
function step<T>(signal: AbortSignal, label: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        withTimeout((async () => fn(signal))(), ms, label)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function defaultDeps(): Promise<SendDeps> {
    const [{ currentAppVersion }, { buildDiagnosticsReport }, { encryptAndUpload }, dms, { isTauri }] = await Promise.all([
        import('./appVersion'),
        import('./diagnosticsReport'),
        import('./attachments'),
        import('./dms'),
        import('./platform'),
    ]);
    return {
        version: currentAppVersion,
        diagnostics: buildDiagnosticsReport,
        readLog: async () => {
            if (!isTauri()) return null;
            const { invoke } = await import('@tauri-apps/api/core');
            try {
                return await invoke<string>('read_support_log');
            } catch (e) {
                // An older shell has no such command: say so in the report
                // rather than failing the send.
                return `(the app log could not be read: ${e instanceof Error ? e.message : String(e)})`;
            }
        },
        upload: (file, signal) => encryptAndUpload(file, signal ? { signal } : undefined),
        openConversation: (userId, signal) => dms.startDMConversation(userId, signal ? { signal } : undefined),
        encrypt: dms.encryptDMContent,
        post: (conversationId, wire, signal) => dms.sendDMMessageRest(conversationId, wire, signal ? { signal } : undefined),
        now: () => new Date(),
    };
}

/**
 * Build the report and DM it to `ownerId`. Resolves with the file's size in
 * bytes; throws with a message fit to show when any step fails, because a
 * half-sent report (a file uploaded with no message pointing at it) is simply
 * an orphan the server will reap, never something the recipient sees.
 *
 * Every step is bounded (see NETWORK_STEP_MS): a step that stalls fails the
 * send with a sentence naming it, and aborts the requests still in flight.
 * Measuring and reading the log degrade into the report instead, as a failed
 * measurement already did. `opts.signal` is the dialog closing: it stops the
 * send before the next step starts, so nothing is posted after the person has
 * gone. The one thing a timeout cannot know is whether the final post reached
 * the server before it was cut, and the message for that step says so.
 */
export async function sendSupportReport(
    ownerId: number, note: string, deps?: SendDeps, opts?: { signal?: AbortSignal },
): Promise<number> {
    const ac = new AbortController();
    const outer = opts?.signal;
    const onOuterAbort = () => ac.abort();
    if (outer?.aborted) ac.abort();
    else outer?.addEventListener('abort', onOuterAbort, { once: true });
    try {
        const d = deps ?? await defaultDeps();
        const { signal } = ac;
        const [version, diagnostics, log] = await Promise.all([
            step(signal, 'Reading the version', QUICK_TIMEOUT_MS, () => d.version()).catch(e => {
                if (signal.aborted) throw e;
                return 'unknown';
            }),
            step(signal, 'The measurement', MEASURE_MS, () => d.diagnostics()).catch(e => {
                if (signal.aborted) throw e;
                return `(diagnostics unavailable: ${e instanceof Error ? e.message : String(e)})`;
            }),
            step(signal, 'Reading the app log', READ_LOG_MS, () => d.readLog()).catch(e => {
                if (signal.aborted) throw e;
                return `(the app log could not be read: ${e instanceof Error ? e.message : String(e)})`;
            }),
        ]);
        const text = reportText(diagnostics, log);
        const file = new File([text], reportFileName(version, d.now()), { type: 'text/plain' });
        const markdown = await step(signal, 'The upload', uploadTimeoutMs(file.size), s => d.upload(file, s));
        const conv = await step(signal, 'Opening the conversation with the owner', NETWORK_STEP_MS, s => d.openConversation(ownerId, s));
        const wire = await step(signal, 'Encrypting the report', NETWORK_STEP_MS, () => d.encrypt(reportMessage(version, note, markdown), ownerId));
        try {
            await step(signal, 'Posting the message', NETWORK_STEP_MS, s => d.post(conv.id, wire, s));
        } catch (e) {
            if (!signal.aborted && e instanceof Error && /gave no answer within \d+ s$/.test(e.message)) {
                throw new Error(`${e.message}. It may still have been delivered: check your direct messages with the owner before sending again`);
            }
            throw e;
        }
        return file.size;
    } catch (e) {
        ac.abort();
        throw e;
    } finally {
        outer?.removeEventListener('abort', onOuterAbort);
    }
}
