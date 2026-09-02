/**
 * Webview host backend — capture and injection using the existing desktop shell.
 *
 * Deliberately does NOT reuse `getScreenShareStream` from rtc/media.ts. That
 * function is built for voice-channel screen sharing and carries behaviour a
 * device session must not inherit: `systemAudio: 'include'` (a remote-desktop
 * session should not silently stream the machine's audio), a shared
 * `screenShareStream` singleton (so starting a device session would stop an
 * in-progress voice share), and `contentHint: 'motion'` tuned for gameplay
 * rather than for reading text.
 *
 * The honest limit, stated in `capabilities()` and not worked around here: a
 * webview host cannot begin a capture with nobody present. Spike S1 settled WHY,
 * and it is not the reason first assumed.
 *
 * Transient activation is NOT the blocker. Blink checks it synchronously and
 * throws InvalidStateError immediately when it fails — a fast rejection, never a
 * hang. The blocker is the PICKER: WebView2 renders it as an in-control dialog
 * bounded by the webview, so on a hidden or offscreen host window it is
 * unpresentable, and `getDisplayMedia` waits forever for a human who is not
 * there. Neither resolving nor rejecting is the signature.
 *
 * And it cannot be worked around. WebView2 has NO permission kind for screen
 * capture, so `getDisplayMedia` never raises PermissionRequested; the dedicated
 * `ScreenCaptureStarting` event is veto-or-defer only, with no way to approve a
 * source. Edge's ScreenCaptureWithoutGestureAllowedForOrigins policy does not
 * apply to WebView2 — and would address activation, which was never the problem.
 *
 * So unattended hosting is the native agent's job (Phase 6), not a flag away.
 */
import { invoke } from '@tauri-apps/api/core';
import { hideCaptureBar, releaseCaptureBar } from '../captureBar';
import { holdStreamBoost, releaseStreamBoost } from '../streamBoost';
import { holdStreamDiag, releaseStreamDiag } from '../streamDiag';
import type {
    HostBackend, HostCapabilities, HostTransport, MonitorInfo, StartSessionOptions,
} from './hostBackend';
import { shellPowerAction } from './hostBackend';

/** One entry of the native `list_monitors` command's `monitors` array. */
interface NativeMonitor {
    index: number;
    left: number;
    top: number;
    width: number;
    height: number;
    primary: boolean;
}

/**
 * What `list_monitors` actually returns: an OBJECT carrying the monitor array
 * plus the virtual-desktop bounds — `puca_input::MonitorList`, not an
 * array.
 *
 * It was decoded here as `NativeMonitor[]`, so the `Array.isArray` guard threw
 * every result away and this host advertised zero screens for its whole life.
 */
interface NativeMonitorList {
    monitors: NativeMonitor[];
    virt_left: number;
    virt_top: number;
    virt_width: number;
    virt_height: number;
}

async function nativeMonitorList(): Promise<NativeMonitorList | null> {
    try {
        const raw = await invoke<NativeMonitorList>('list_monitors');
        if (!raw || !Array.isArray(raw.monitors)) return null;
        return raw;
    } catch {
        return null;
    }
}

/** One live capture, so stopSession can actually stop it. */
const captures = new Map<string, MediaStream>();

/**
 * Monitors, via the native enumerator built for remote control.
 *
 * Shapes are read defensively: this is an existing command with its own field
 * names, and a rename there should degrade to a usable list rather than crash
 * the capability probe the whole Devices UI waits on.
 */
async function listMonitors(): Promise<MonitorInfo[]> {
    const raw = await nativeMonitorList();
    if (!raw) return [];
    return raw.monitors.map((m, i) => ({
        id: m.index ?? i,
        label: m.primary ? 'Main display' : `Display ${i + 1}`,
        width: m.width ?? 0,
        height: m.height ?? 0,
        primary: m.primary ?? i === 0,
    }));
}

/**
 * Capture the screen for a device session.
 *
 * `contentHint: 'detail'` — the opposite of the voice-share path's 'motion'.
 * Remote desktop is mostly text and UI, where a sharp still frame beats a
 * smooth blurry one; gameplay is the case that wants motion, and that is the
 * other feature.
 */
/** How long to wait for someone at the HOST to answer the screen picker.
 *
 *  Not unlimited, which is what shipped in 0.8.0 and produced the only bug found
 *  in real use: the controller sat on "Waiting for the device's screen…" forever
 *  because the host was blocked in getDisplayMedia and never answered the connect
 *  request at all. A refusal with a reason is far better than silence — the
 *  person holding the phone can act on it. */
const PICKER_TIMEOUT_MS = 45_000;

/** Bring this window to the front before asking for a screen.
 *
 *  REQUIRED, not cosmetic. The picker is an in-control dialog bounded by the
 *  webview (spike S1), so on a window that is hidden in the tray — which is the
 *  NORMAL state for an always-on host — it can be unpresentable. Nobody can
 *  answer a dialog they cannot see, and the capture then hangs forever.
 *
 *  Best-effort: if the window cannot be raised we still try the picker, because
 *  a visible-but-unfocused window is a perfectly answerable case. */
async function raiseForPicker(): Promise<void> {
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        await w.unminimize().catch(() => {});
        await w.show().catch(() => {});
        await w.setFocus().catch(() => {});
    } catch {
        // Not Tauri, or the API moved. The picker attempt below is still worth
        // making; it simply may not be presentable.
    }
}

async function captureDisplay(): Promise<MediaStream> {
    await raiseForPicker();

    const picker = navigator.mediaDevices.getDisplayMedia({
        video: {
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
        },
        // No audio: a remote-desktop session must not quietly stream whatever
        // the machine is playing. If that is ever wanted it should be a
        // separate, visible control.
        audio: false,
    });

    // Race the picker. getDisplayMedia neither resolves nor rejects while a
    // picker waits, so without this the caller cannot tell "thinking about it"
    // from "wedged" — the exact ambiguity that made spike S1 take a day.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(
                'this computer did not confirm screen sharing in time — someone needs to '
                + 'approve it there, or install the agent for unattended access',
            )),
            PICKER_TIMEOUT_MS,
        );
    });

    let stream: MediaStream;
    try {
        stream = await Promise.race([picker, timeout]);
    } catch (e) {
        // A picker that resolves AFTER we gave up would otherwise leave a live
        // capture running with nothing consuming it — the screen stays shared
        // with no session to show for it.
        void picker.then(late => late.getTracks().forEach(t => t.stop())).catch(() => {});
        throw e;
    } finally {
        clearTimeout(timer);
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
        try { track.contentHint = 'detail'; } catch { /* not fatal */ }
    }
    // Hide WebView2's "… is sharing" bar, same as the voice-share path. One
    // holder for all device captures: the bar must stay hidden while ANY
    // session is live, and the clip ring / voice share are separate holders.
    hideCaptureBar('device-host');
    // A controller is watching this capture live — same starvation, same fix
    // as the voice share (streamBoost.ts), and the same unattended log
    // sampler (streamDiag.ts).
    holdStreamBoost('device-host');
    holdStreamDiag('device-host');
    return stream;
}

/** Input events the native injector accepts. Mirrors ControlInput in Rust. */
interface InjectableEvent {
    t?: string;
}

export function webviewHostBackend(): HostBackend {
    return {
        kind: 'webview',

        /** Lock / shut down are SHELL capabilities, so the webview fallback
         *  has them exactly as the agent backend does — this backend only ever
         *  runs inside the desktop shell (getHostBackend hands phones and
         *  browsers a different one). */
        powerAction: shellPowerAction,

        async capabilities(): Promise<HostCapabilities> {
            const monitors = await listMonitors();
            // Injection is Windows-only: remote_control.rs is a hard error
            // everywhere else, so claiming input on Linux/macOS would offer a
            // session that connects and then ignores every click.
            const input = /Windows/i.test(navigator.userAgent);
            return {
                capture: true,
                // NOT a placeholder — see the file header. Until S1 says
                // otherwise, a webview host needs a person present.
                unattended: false,
                input,
                elevated: false,
                clipboard: false,
                files: false,
                monitors,
                limitation: input
                    ? 'This device must be unlocked and running Púca to be controlled. ' +
                      'It cannot wake itself into a session, and cannot be driven through ' +
                      'UAC prompts or the lock screen.'
                    : 'Screen sharing works, but keyboard and mouse control is Windows-only ' +
                      'for now.',
            };
        },

        async startSession(opts: StartSessionOptions): Promise<HostTransport> {
            // Replacing an existing capture for the same id would leak the old
            // stream's tracks and leave the camera light (or capture bar) on.
            await this.stopSession(opts.sessionId);

            const stream = await captureDisplay();
            captures.set(opts.sessionId, stream);

            const track = stream.getVideoTracks()[0];
            const settings = track?.getSettings?.() ?? {};

            // The user stopping the share from the OS bar must end the session,
            // not leave a black rectangle the controller keeps clicking into.
            if (track) {
                track.addEventListener('ended', () => {
                    window.dispatchEvent(new CustomEvent('device-capture-ended', {
                        detail: { sessionId: opts.sessionId },
                    }));
                });
            }

            // Map the capture onto the right monitor for absolute pointer moves.
            // Without this a secondary monitor (which legitimately has NEGATIVE
            // virtual-desktop coordinates) puts the cursor on the wrong screen.
            //
            // `set_control_monitor` takes the monitor's GEOMETRY, not its id —
            // passing the number meant the argument never deserialised and this
            // path silently sent nothing but null, so injection always landed on
            // the primary display however the picker was answered. The matching
            // rule mirrors remoteControl.ts, tolerance included: a capture is
            // occasionally reported a pixel or two off the panel's mode.
            try {
                const raw = await nativeMonitorList();
                const near = (a: number, b: number) => Math.abs(a - b) <= 2;
                const chosen = raw
                    ? (settings.width && settings.height
                        ? raw.monitors.find(m => near(m.width, settings.width!) && near(m.height, settings.height!))
                        : undefined)
                        ?? raw.monitors.find(m => m.primary)
                        ?? raw.monitors[0]
                    : undefined;
                const target = raw && chosen
                    ? {
                        left: chosen.left, top: chosen.top,
                        width: chosen.width, height: chosen.height,
                        virt_left: raw.virt_left, virt_top: raw.virt_top,
                        virt_width: raw.virt_width, virt_height: raw.virt_height,
                    }
                    : null;
                await invoke('set_control_monitor', { target });
            } catch {
                // Falls back to the primary monitor, which is the common case.
            }

            return {
                kind: 'webview-pc',
                stream,
                width: settings.width ?? 1920,
                height: settings.height ?? 1080,
            };
        },

        async setMonitor(): Promise<void> {
            // getDisplayMedia fixed the source when the user answered the picker
            // and there is no API to change it without asking again. Say so
            // plainly — the controller shows this to the viewer, and "nothing
            // happened" would send them hunting a bug that is really a platform
            // limit, fixed by installing the build that ships the agent.
            throw new Error(
                'This computer cannot switch screens mid-session. Update its '
                + 'desktop app so it can capture directly, or reconnect and pick '
                + 'the other screen.',
            );
        },

        async stopSession(sessionId: string): Promise<void> {
            const stream = captures.get(sessionId);
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
                captures.delete(sessionId);
            }
            // Stop the retry loop that hides WebView2's sharing bar; leaving it
            // running would keep poking at windows for a session that is over.
            // The priority boost and diagnostic sampler drop with it — no
            // viewer, no boost, no more log lines.
            if (captures.size === 0) {
                releaseCaptureBar('device-host');
                releaseStreamBoost('device-host');
                releaseStreamDiag('device-host');
            }
            // Release anything the controller was holding down. A session that
            // ends mid-keypress must not strand a key in the target app —
            // exactly the failure remote_control.rs already guards against.
            try { await invoke('release_control_input'); } catch { /* not fatal */ }
        },

        async releaseInput(): Promise<void> {
            try { await invoke('release_control_input'); } catch { /* not fatal */ }
        },

        async injectEvent(sessionId: string, event: string): Promise<void> {
            // Refuse input for a session we are not actually capturing. Without
            // this, a stale event arriving after teardown would still be
            // injected into whatever is now on screen.
            if (!captures.has(sessionId)) return;

            let parsed: InjectableEvent;
            try { parsed = JSON.parse(event) as InjectableEvent; } catch { return; }
            if (!parsed || typeof parsed.t !== 'string') return;

            await invoke('inject_input', { event: parsed });
        },

        listMonitors,
        
        async updateStream(): Promise<void> {
            // THROW, do not resolve. getDisplayMedia fixed the encoding when
            // the user answered the picker and there is no API to change it
            // without asking again. Resolving quietly made the host ack
            // `applied: true`, so the controller's UI moved to a quality the
            // stream was never using.
            throw new Error('this host cannot change stream quality while sharing');
        },
    };
}
