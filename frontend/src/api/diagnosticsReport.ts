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
 * Which GPU the app is rendering on, and whether any codec can be encoded in
 * HARDWARE at the sizes a screen share uses.
 *
 * THE QUESTION THIS ANSWERS. Every share this project has logs for was encoded
 * by OpenH264 — software — on machines whose own native agent encodes with an
 * NVIDIA hardware encoder for other features. Software H.264 at 1080p is the
 * single largest cost a share imposes, and it is why sharing can make a game
 * stutter. Whether that is fixable inside the browser turns on one fact: does
 * this browser get offered a hardware encoder at all.
 *
 * WHY NOT `mediaCapabilities.encodingInfo`, WHICH IS THE OBVIOUS ANSWER. It
 * lies. This function shipped using it and had to be rewritten within the
 * hour. Measured 2026-09-09 on an RTX 4080 SUPER, in ONE renderer, at the same
 * moment:
 *
 *   encodingInfo({type:'webrtc', contentType:'video/H264', 1920x1080})
 *       -> powerEfficient: false
 *   outbound-rtp, that instant, on a live 1920x1080 H.264 send
 *       -> encoderImplementation: "MediaFoundationVideoEncodeAccelerator
 *                                  (NVIDIA H.264 Encoder MFT)"
 *          powerEfficientEncoder: true
 *
 * It is not a cold-start artefact — cold, after getUserMedia, and mid-send all
 * gave false. It is not hardcoded either: `decodingInfo` on the same build
 * discriminates correctly. The webrtc ENCODE answer is simply wrong, and the
 * W3C spec leaves `powerEfficient` "to the user agent", so this is permitted
 * rather than a bug we can wait out. Shipping it would have written "your
 * machine has no hardware encoder" into every user's report regardless of
 * truth — the worst kind of diagnostic, one that is confidently wrong.
 *
 * WHAT IS USED INSTEAD. WebCodecs `VideoEncoder.isConfigSupported` with
 * `hardwareAcceleration: 'prefer-hardware'`, which on that same machine
 * returned exactly NVENC's real matrix — H.264 High yes, AV1 yes, VP8 and VP9
 * no (no NVIDIA part has ever encoded either). The in-call truth
 * (`encoderImplementation`, `powerEfficientEncoder`) is in the SFU/mesh
 * sections below and is the final word; this section is what can be answered
 * before a call starts.
 *
 * The WebGL renderer string is here for the other half: a machine with several
 * adapters can leave the browser on one that has no encoder, and the string
 * names which one it landed on.
 */
export async function encodingSupportLines(): Promise<string[]> {
    const out: string[] = [];
    try {
        const gl = document.createElement('canvas').getContext('webgl');
        const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
        out.push(`gpu       ${dbg && gl ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(no webgl)'}`);
    } catch {
        out.push('gpu       (unavailable)');
    }
    const VE = (globalThis as { VideoEncoder?: {
        isConfigSupported(c: unknown): Promise<{ supported?: boolean }>;
    } }).VideoEncoder;
    if (!VE?.isConfigSupported) {
        // WebCodecs needs a secure context. The desktop shell and the web app
        // both have one; saying which is missing beats a bare "unavailable".
        out.push(`encoding  (WebCodecs unavailable${window.isSecureContext ? '' : ' — not a secure context'})`);
        return out;
    }
    for (const [label, codec] of [
        ['H.264 High', 'avc1.640028'],
        ['H.264 Base', 'avc1.42E01F'],
        ['VP8', 'vp8'],
        ['VP9', 'vp09.00.10.08'],
        ['AV1', 'av01.0.04M.08'],
    ]) {
        for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
            try {
                const r = await VE.isConfigSupported({
                    codec, width: w, height: h, bitrate: 4_500_000, framerate: 30,
                    hardwareAcceleration: 'prefer-hardware',
                });
                out.push(`encoding  ${label.padEnd(11)} ${w}x${h}  hardware=${r.supported === true}`);
            } catch (e) {
                out.push(`encoding  ${label} ${w}x${h}  (asked and refused: ${e instanceof Error ? e.message : String(e)})`);
            }
        }
    }
    // The floor nobody expects. Chromium encodes ANYTHING under 360 lines in
    // software on purpose (kForceSoftwareForRtcLowResolutions), whatever the
    // hardware says — measured on the same machine: 640x360 hardware,
    // 576x324 software, with the flag flipped as a positive control.
    out.push('encoding  note: Chromium forces SOFTWARE below 360 lines regardless of hardware');
    return out;
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

    lines.push('', '--- video encoding this machine can offer ---');
    lines.push(...await encodingSupportLines());

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
