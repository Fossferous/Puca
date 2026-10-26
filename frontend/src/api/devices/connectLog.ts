/**
 * Why a remote-control connection failed, kept where "Send diagnostics" finds
 * it.
 *
 * Why: on 2026-10-20 the owner reported that after an ungraceful drop the
 * Android app would not reconnect until it was closed, and could not
 * remember what the retry said. Five different gaps could each produce that,
 * and each one says something different on screen — so without the words
 * there was no telling which. Every failed or abandoned controller attempt
 * now leaves one line: what kind of session, how far it got, the reason it
 * was given, and whether the app was backgrounded or the socket down.
 *
 * And so does every DELIBERATE end since 2026-10-26 ("ended by choice":
 * Disconnect, connecting again over a live session, the other computer's own
 * stop, a sign-out), with how long the session was up. The laptop timeline
 * that day had to be rebuilt from the other computer's offsets because a
 * reconnect left nothing here. The stage adds the one inference worth a line:
 * that computer running an older Púca (no pointer shape while it could have
 * said one; olderHost.ts).
 *
 * Kept in memory as well as logged: the phone has no app log file, and
 * Send diagnostics on a phone sends only the report — which now carries
 * these lines (diagnosticsReport.ts). On desktop they also reach puca.log
 * through the shell. No device names or ids: the report goes to a server
 * owner, and the reason alone says which gap it was.
 */
import { isTauri } from '../platform';

const MAX_LINES = 40;
const recent: string[] = [];
let chain: Promise<void> = Promise.resolve();

export function logRcConnect(event: string): void {
    const line = `[rc-connect] ${new Date().toISOString()} ${event}`;
    recent.push(line);
    if (recent.length > MAX_LINES) recent.shift();
    console.info(line);
    if (!isTauri()) return;
    chain = chain.then(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('log_stream_diag', { line });
        } catch { /* best effort — a missing line is not worth an error */ }
    });
}

/** The lines this run has logged, oldest first. */
export function recentRcConnectLines(): string[] {
    return [...recent];
}
