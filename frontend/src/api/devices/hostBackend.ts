/**
 * THE SEAM.
 *
 * There are two ways to host a device-control session, and the whole staging of
 * this feature depends on them being interchangeable:
 *
 *   - `webview`  — reuse getDisplayMedia + the existing WebRTC stack. Ships
 *                  first, works while the app is running and armed.
 *   - `agent`    — a native binary that captures and injects without a webview.
 *                  Required for genuine unattended access, and the ONLY option
 *                  on Linux (WebKitGTK has no insertable streams, so media E2EE
 *                  silently drops every frame there).
 *
 * Everything else in this feature — device identity, pairing, grants,
 * authorization, revocation, signalling, UI — sits ABOVE this interface and
 * does not change when the backend does. If you find yourself adding a
 * `if (kind === 'agent')` branch outside this file, the seam is in the wrong
 * place.
 *
 * Note what is deliberately NOT here: the agent never speaks WebSocket to the
 * Puca server. It speaks local IPC to this app, which keeps ownership of
 * the socket, the device key, and every authorization decision.
 */
import { isTauri } from '../platform';

export interface MonitorInfo {
    id: number;
    label: string;
    width: number;
    height: number;
    primary: boolean;
    /** Desktop-space position, when the backend can measure it (the agent
     *  reports it; a getDisplayMedia webview host cannot). Present on every
     *  monitor or on none — the controller's zoom-follows-monitor feature
     *  needs the full layout or nothing. */
    left?: number;
    top?: number;
}

export interface HostCapabilities {
    /** Can produce a video stream at all. */
    capture: boolean;
    /** Can START a capture with no user gesture — i.e. genuinely unattended. */
    unattended: boolean;
    /** Can inject mouse/keyboard. */
    input: boolean;
    /** Can drive UAC / the lock screen (needs the SYSTEM service). */
    elevated: boolean;
    clipboard: boolean;
    files: boolean;
    monitors: MonitorInfo[];
    /** Why capture or unattended is unavailable, for the UI to show verbatim.
     *  A greyed-out control with no reason is a support ticket. */
    limitation?: string;
}

/** How media reaches the controller for this session.
 *
 *  The webview host produces a STREAM and hands it over; session.ts owns the
 *  RTCPeerConnection. Splitting it this way keeps capture (backend-specific) and
 *  transport (identical for both backends) apart — which is what lets the agent
 *  drop in later without session.ts changing. */
export type HostTransport =
    /** This webview captured; session.ts should publish this stream. */
    | { kind: 'webview-pc'; stream: MediaStream; width: number; height: number }
    /** The agent owns its own connection; we only pump signalling. */
    | { kind: 'agent-pc' }
    /** No capture at all: session.ts builds the pc, publishes nothing, and
     *  answers data-only. The phone's file hosting rides this — a files-only
     *  session on a host that has no screen to give. */
    | { kind: 'data-pc' };

export interface StartSessionOptions {
    sessionId: string;
    controllerDevice: string;
    /** Raw AES-256-GCM key for the sealed control channel. */
    sessionKey: Uint8Array;
    /** Which monitor to capture; null = primary. */
    monitor: number | null;
}

export interface HostBackend {
    readonly kind: 'webview' | 'agent' | 'capacitor' | 'none';
    capabilities(): Promise<HostCapabilities>;
    startSession(opts: StartSessionOptions): Promise<HostTransport>;
    stopSession(sessionId: string): Promise<void>;
    /** Inject one input event that has ALREADY been opened and sequence-checked
     *  by session.ts (which holds the session key). The backend's job is the OS
     *  call, not the crypto — putting the key here would mean two owners for one
     *  secret. Callers must never pass an unverified event. */
    injectEvent(sessionId: string, event: string): Promise<void>;
    /** Release every key/button remote input is holding down, WITHOUT ending
     *  the session. stopSession does this too; this exists for the moment the
     *  relay drops while the session is being held for a reconnect — no
     *  key-up is coming over a dead relay, and a key stranded down for the
     *  whole grace window types itself into whatever is focused. */
    releaseInput?(): Promise<void>;
    listMonitors(): Promise<MonitorInfo[]>;
    /** Point a LIVE session at another monitor.
     *
     *  Rejects on a backend that cannot do it — notably the webview host, where
     *  the source was fixed when the user answered getDisplayMedia and there is
     *  no API to change it without asking again. Callers surface the failure
     *  rather than leaving the viewer looking at the old screen. */
    setMonitor(sessionId: string, monitor: number): Promise<void>;
    /** Update encoding quality parameters on the fly.
     *
     *  Only supported by the agent backend. */
    updateStream(sessionId: string, fps?: number, bitrateKbps?: number): Promise<void>;
    /** Retrieve the current encoder settings for this session.
     *
     *  Only supported by the agent backend. */
    getStreamQuality?(sessionId: string): Promise<{ fps: number; bitrate_kbps: number }>;
    /** Force the encoder to emit a keyframe. Optional and agent-only: the
     *  agent's GOP is infinite, so a controller whose decoder lost state (an
     *  Android app frozen in the background) has no other way back to a
     *  decodable picture. A webview host needs nothing here — its browser
     *  encoder answers the peer's PLI natively — so `undefined` means
     *  "no-op", never "error". */
    requestKeyframe?(sessionId: string): Promise<void>;
    /** Is a Windows security screen (a UAC prompt, the lock or sign-in screen)
     *  currently blocking this session's capture?
     *
     *  Agent-and-Windows only, and OPTIONAL on purpose: a webview host has no
     *  way to know (it is handed a stream, not a desktop), and a phone has no
     *  such concept. `undefined` means "cannot tell", which the caller treats as
     *  "no" — the behaviour every build had before this existed. Never throws
     *  for an older agent; it answers false.
     *
     *  `cursorClipped` rides the same poll: a ClipCursor region (a fullscreen
     *  game) is holding the pointer entirely off the streamed monitor, so
     *  injected clicks get clamped somewhere the viewer cannot see. Optional
     *  for the same skew reason — an implementation predating it reads as
     *  "not clipped". */
    sessionStatus?(
        sessionId: string,
    ): Promise<{ secureDesktop: boolean; cursorClipped?: boolean }>;
    /** Blank this machine's screen behind an overlay while it is controlled.
     *
     *  Only the agent can do this; the webview has no way to cover the desktop.
     *  Rejects rather than resolving, so a host that cannot blank never reports
     *  privacy mode as active over a perfectly visible screen. */
    setPrivacyMode?(sessionId: string, enabled: boolean): Promise<void>;
    /** Stop blending this machine's pointer into the stream, because the
     *  controller draws its own. OPTIONAL: a backend without it (the webview
     *  host, a phone) rejects the request, the controller never gets its ack,
     *  and both ends stay exactly as they are today — one cursor, the host's. */
    setDrawCursor?(sessionId: string, enabled: boolean): Promise<void>;
    /** Lock this machine's console, or shut it down, on the controller's
     *  request. OPTIONAL: it is a capability of the DESKTOP SHELL (which runs
     *  as the signed-in user, the one process allowed to do both), so BOTH
     *  Tauri-backed hosts carry it — the native-agent one and the webview
     *  fallback alike, via `shellPowerAction` — while a phone host has none
     *  and the session's power arm reports that back rather than pretending.
     *  Rejects on failure — never resolves over a machine that is still
     *  unlocked / still up. */
    powerAction?(action: import('./session').PowerAction): Promise<string | void>;
    /** The desktop's display topology just changed (a detach/reattach): the
     *  AGENT must rebuild every live capture against a fresh enumeration and
     *  re-aim input. OPTIONAL and agent-only — the webview host's capture
     *  follows the browser's own surface handling. Rejects on an old agent
     *  ("bad request"); the caller swallows that and the stream heals slowly
     *  instead of instantly. */
    displayTopologyChanged?(): Promise<void>;
    /** Let the peer reach files on this machine, or revoke with null.
     *
     *  Separate from the session itself on purpose: agreeing to share a screen
     *  is not agreeing to hand over the disk. The agent refuses every file
     *  request until this has been called, and confines all of them to the
     *  scope given. */
    setFileAccess?(sessionId: string, scope: FileScopeRequest | null): Promise<void>;
}

/**
 * What the host is granting.
 *
 * `folder` is the interactive grant: somebody at this machine answered a prompt
 * and picked it. `policy` is the unattended grant — fixed drives minus the
 * system and secret-bearing locations — and is only ever sent for a host that is
 * ARMED and whose controller proved the passphrase, because there is nobody at
 * the keyboard to pick a folder in that case.
 *
 * `policy` deliberately carries NO paths. The agent resolves the denylist itself
 * so the scope cannot be argued with over the pipe: a scope the app could
 * enumerate is a scope the app could widen, and the app is the only thing
 * between this and a remote peer.
 */
export type FileScopeRequest =
    | { kind: 'folder'; root: string }
    | { kind: 'policy' };

/**
 * A backend for platforms that cannot host at all — every browser, every phone,
 * and (until the agent exists) Linux.
 *
 * It reports `capture: false` with a REASON rather than throwing, so the UI can
 * explain why "control this device" is unavailable instead of offering a button
 * that fails. A device that cannot host is still a perfectly good controller.
 */
function nullBackend(limitation: string): HostBackend {
    return {
        kind: 'none',
        async capabilities() {
            return {
                capture: false, unattended: false, input: false, elevated: false,
                clipboard: false, files: false, monitors: [], limitation,
            };
        },
        async startSession() { throw new Error(limitation); },
        async setMonitor() { throw new Error(limitation); },
        async updateStream() { throw new Error(limitation); },
        async stopSession() { /* nothing to stop */ },
        async injectEvent() { throw new Error(limitation); },
        async listMonitors() { return []; },
    };
}

/**
 * The one implementation of `powerAction`, for every backend that runs inside
 * the desktop shell. It goes straight to the Tauri command, NOT through the
 * agent: the shell is the interactive user's process, which is exactly the one
 * that may LockWorkStation and (with SeShutdownPrivilege enabled) shut down.
 * Throws with the OS's reason, which the session's power arm relays.
 *
 * Shared on purpose. It first lived on the agent backend only, so a desktop
 * whose agent probe failed (and fell back to the webview host) refused Lock and
 * Shut down with "this host cannot lock or shut down from here" — false for
 * that machine, whose shell could do both all along.
 */
export async function shellPowerAction(
    action: import('./session').PowerAction,
): Promise<string | void> {
    const { invoke } = await import('@tauri-apps/api/core');
    // The reply is the optional human DETAIL line (keep_primary's
    // per-monitor honesty); lock/shutdown/off/on answer null.
    const detail = await invoke<string | null>('power_action', { action });
    return typeof detail === 'string' && detail ? detail : undefined;
}

/** Session teardown: stop the display keep-off ticker, relight NOTHING —
 *  the stay-as-set rule (display_power.rs). No-op on a shell without the
 *  command (webview host, pre-W4 installer): the catch answers it. */
export async function shellDisplayPowerSessionEnd(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('display_power_session_end').catch(() => undefined);
}

let cached: HostBackend | null = null;

/**
 * Pick the backend for THIS device: the native agent if one is reachable,
 * otherwise the webview host, otherwise a null backend that explains itself.
 *
 * Probing for the agent first (rather than checking the platform) means
 * installing the agent upgrades a machine with no code change here.
 */
export async function getHostBackend(): Promise<HostBackend> {
    if (cached) return cached;

    if (!isTauri()) {
        // A Capacitor phone cannot capture, but it CAN host its files —
        // that backend explains its own limits per capability.
        const { isMobile } = await import('../platform');
        if (isMobile()) {
            const { capacitorHostBackend } = await import('./hostCapacitor');
            cached = capacitorHostBackend();
            return cached;
        }
        cached = nullBackend(
            'This device can control others, but cannot be controlled itself — ' +
            'hosting needs the desktop app.',
        );
        return cached;
    }

    // Prefer the native agent when one is installed. Probing (rather than
    // checking the platform) means installing the agent upgrades a machine with
    // no code change here — which is the whole point of the seam.
    let why = 'agent_probe returned false';
    try {
        const { agentAvailable, agentHostBackend } = await import('./hostAgent');
        if (await agentAvailable()) {
            cached = agentHostBackend();
            await agentLog('[host] using the NATIVE AGENT for this session');
            return cached;
        }
    } catch (e) {
        why = `agent_probe threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // SAY WHY, LOUDLY.
    //
    // This fallback was silent, and it is the single most misleading moment in
    // the whole feature: the visible result is the browser's screen picker,
    // which reads as a deliberate design rather than a fault. Settings can say
    // "Direct capture ready" while THIS decides otherwise seconds later, and
    // until now nothing recorded the disagreement — so five rounds of diagnosis
    // went looking at capture, at the pipe, at ICE, when the agent was simply
    // never chosen.
    //
    // agentDiagnosis() is asked again HERE rather than reusing what Settings
    // showed, because the interesting case is exactly when the two disagree.
    const { agentDiagnosis } = await import('./hostAgent');
    const diag = await agentDiagnosis().catch(() => null);
    const reason = `[host] FELL BACK TO THE WEBVIEW HOST (screen picker). ${why}. `
        + `agent_diagnose says: ${diag ?? '<no answer — this shell predates agent_diagnose>'}`;
    console.warn(reason);
    await agentLog(reason);

    const { webviewHostBackend } = await import('./hostWebview');
    cached = webviewHostBackend();
    return cached;
}

/**
 * Append a line to the agent's log file.
 *
 * The agent writes there already (see agent_ipc.rs), and the decision recorded
 * above is the one thing the agent CANNOT record — it is the decision not to
 * use it. Putting both in one file means "send me agent.log" stays a single
 * request rather than growing a second one, and the ordering between "the app
 * chose X" and "the agent then did Y" is preserved.
 *
 * Best effort: an older shell has no such command, and failing to log must
 * never take a session down.
 */
async function agentLog(line: string): Promise<void> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('agent_log', { line });
    } catch { /* older shell, or not Tauri */ }
}

/**
 * Forget the cached choice.
 *
 * The cache is per page load and was never invalidated, so a probe that failed
 * once — an agent still starting, a pipe briefly held by the previous build —
 * pinned this machine to the screen picker until the app restarted, with no way
 * to retry short of quitting. Called when the Devices screen is opened, which
 * is exactly where someone goes after seeing a picker they did not expect.
 */
export function forgetHostBackendChoice(): void {
    cached = null;
}

/** Test seam — lets a test install a fake backend. */
export function __setHostBackendForTests(b: HostBackend | null): void {
    cached = b;
}
