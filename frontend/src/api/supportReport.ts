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

/** Everything the send touches, injectable for the tests. */
export interface SendDeps {
    version: () => Promise<string>;
    diagnostics: () => Promise<string>;
    /** null when there is no log file on this platform. */
    readLog: () => Promise<string | null>;
    upload: (file: File) => Promise<string>;
    openConversation: (userId: number) => Promise<{ id: string }>;
    encrypt: (text: string, recipientId: number) => Promise<string>;
    post: (conversationId: string, wire: string) => Promise<unknown>;
    now: () => Date;
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
        upload: file => encryptAndUpload(file),
        openConversation: dms.startDMConversation,
        encrypt: dms.encryptDMContent,
        post: dms.sendDMMessageRest,
        now: () => new Date(),
    };
}

/**
 * Build the report and DM it to `ownerId`. Resolves with the file's size in
 * bytes; throws with a message fit to show when any step fails, because a
 * half-sent report (a file uploaded with no message pointing at it) is simply
 * an orphan the server will reap, never something the recipient sees.
 */
export async function sendSupportReport(ownerId: number, note: string, deps?: SendDeps): Promise<number> {
    const d = deps ?? await defaultDeps();
    const [version, diagnostics, log] = await Promise.all([
        d.version().catch(() => 'unknown'),
        d.diagnostics().catch(e => `(diagnostics unavailable: ${e instanceof Error ? e.message : String(e)})`),
        d.readLog(),
    ]);
    const text = reportText(diagnostics, log);
    const file = new File([text], reportFileName(version, d.now()), { type: 'text/plain' });
    const markdown = await d.upload(file);
    const conv = await d.openConversation(ownerId);
    const wire = await d.encrypt(reportMessage(version, note, markdown), ownerId);
    await d.post(conv.id, wire);
    return file.size;
}
