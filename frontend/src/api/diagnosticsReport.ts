/**
 * "Copy diagnostics" — the same truth `__pucaVoiceDiag()` gives, without
 * asking anybody to open a developer console.
 *
 * WHY THIS EXISTS. Every performance report so far has been diagnosed by
 * asking the person to open DevTools and paste the result of a global function
 * nobody could be expected to know about. Most people will not do that, and
 * the ones who will do it once will not do it again at the moment the problem
 * is actually happening — which is the only moment the numbers mean anything.
 * A menu item they can hit mid-call costs them two seconds and gets us the
 * measurement instead of an adjective.
 *
 * WHAT IT DOES NOT CONTAIN, deliberately. No message content, no channel or
 * server names, no account token, no email, no file paths, no IP addresses.
 * The candidate pair is reported by TYPE (`host/udp`, `relay/udp`) because
 * which KIND of path is in use answers a real question and the address answers
 * none. Peer identities are the pseudonymous ids the SFU already uses. Read it
 * before you send it — it is plain text for exactly that reason.
 */
import { sfuManager } from './rtc/sfuManager';
import { webrtcManager } from './webrtc';
import { currentAppVersion } from './appVersion';

/** Milliseconds of measurement. Rates and delays are meaningless as
 *  point-in-time counters, so the diagnostics take two samples this far apart —
 *  long enough to be stable, short enough that nobody gives up waiting. */
const WINDOW_MS = 4000;

/** `undefined` rather than a throw: a diagnostics report that fails because one
 *  of its sections failed is worth less than a partial one, and the section
 *  that broke is itself a fact worth printing. */
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | string> {
    try {
        return await fn();
    } catch (e) {
        return `(${label} unavailable: ${e instanceof Error ? e.message : String(e)})`;
    }
}

/** What the app is, before what it is doing. Version and platform decide
 *  whether a report is even about the build we think it is. */
export function environmentLines(now: string, version: string): string[] {
    return [
        `Púca diagnostics — ${now}`,
        `app       ${version}`,
        `platform  ${navigator.userAgent}`,
        `screen    ${window.screen.width}x${window.screen.height} @ ${window.devicePixelRatio}x`,
        `cores     ${navigator.hardwareConcurrency ?? 'unknown'}`,
    ];
}

/**
 * Build the report. Safe to call at any time: outside a call the media
 * sections simply say so, which is itself worth knowing when somebody reports
 * a problem they think is in a call and is not.
 */
export async function buildDiagnosticsReport(): Promise<string> {
    // The REAL version, asked of the shell rather than read off a build
    // constant: a webview served an older bundle would otherwise report the
    // version it was compiled with rather than the app it is running inside.
    const version = await attempt('version', () => currentAppVersion());
    const lines = environmentLines(new Date().toISOString(), String(version));

    lines.push('', '--- voice / screen share (SFU) ---');
    const sfu = await attempt('sfu', () => sfuManager.voiceDiagnostics(WINDOW_MS));
    lines.push(typeof sfu === 'string' ? sfu : JSON.stringify(sfu, null, 2));

    lines.push('', '--- voice / screen share (peer to peer) ---');
    const mesh = await attempt('mesh', () => webrtcManager.meshDiagnostics(WINDOW_MS));
    if (typeof mesh === 'string') {
        lines.push(mesh);
    } else {
        lines.push(mesh.length === 0 ? '(no peer-to-peer connections)' : JSON.stringify(mesh, null, 2));
    }

    return lines.join('\n');
}

/**
 * Build the report and put it on the clipboard. Returns what to tell the
 * person — success or the reason it failed, never a thrown error, because this
 * is invoked from a menu item and a menu item that explodes teaches nobody
 * anything.
 */
export async function copyDiagnostics(): Promise<string> {
    let text: string;
    try {
        text = await buildDiagnosticsReport();
    } catch (e) {
        return `Could not gather diagnostics: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
        await navigator.clipboard.writeText(text);
        return `Diagnostics copied (${Math.round(text.length / 1024)} KB). Paste them into the chat.`;
    } catch {
        // A clipboard write can be refused (no focus, no permission). The
        // report still exists, and the console is the fallback rather than the
        // first resort it used to be.
        console.info('[diagnostics] clipboard refused; report follows\n' + text);
        return 'Could not reach the clipboard — the report was printed to the developer console instead.';
    }
}
