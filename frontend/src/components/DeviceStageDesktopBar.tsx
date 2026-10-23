/**
 * The DESKTOP remote-control bar: everything the phone's toolbar, menus and
 * keyboard bar offer, in a desktop shape — a row of menus over the picture,
 * keyboard shortcuts for the actions you reach for mid-task, fullscreen, and
 * the live numbers.
 *
 * It used to be a flat row (Screen, Quality, Resolution, Game mode, Pause,
 * Send clipboard, Displays, Files, Disconnect), and the phone had grown far
 * past it: Ctrl+Alt+Del, Alt+Tab, Alt+F4, Lock, Shut down, privacy mode, Copy
 * diagnostics and typing text were all phone-only, and the security-screen
 * banner told desktop users to use a "More menu" they did not have. The owner's
 * words (2026-10-23): "Android to desktop control is much better with so many
 * more options."
 *
 * The bar sits OUTSIDE the input surface, so nothing pressed here can reach the
 * remote machine as a click. Its menus close on an outside press through a
 * backdrop for the same reason the Displays popover always did: a press that
 * fell through to the surface would click the remote desktop. While a menu is
 * open the stage forwards no keys (`onMenuOpenChange`), and Escape closes it.
 *
 * Every action that injects is hidden for a view-only share and while control
 * is paused — "a control that says it is off has to be off" (the phone's rule).
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
    ALL_DISPLAYS, endSession, requestMonitor, sendInput, sendPowerAction, sendStreamQuality, setPrivacyMode,
    type DeviceControlSession, type PowerAction,
} from '../api/devices/session';
import { sendChord } from '../api/devices/chords';
import { STAGE_SHORTCUTS } from '../api/devices/stageShortcuts';
import { STREAM_QUALITY_PRESETS, parsePresetValue, presetValue } from '../api/devices/streamQualityPresets';
import type { FitResolution } from '../api/devices/viewSize';
import type { TunnelStatus } from '../api/devices/tunnel';
import type { LiveStats } from '../api/devices/liveStats';
import type { LatencyReading } from '../api/devices/useLatencyProbe';
import { FPS_SENS_MAX, FPS_SENS_MIN, FPS_SENS_STEP, fmtSens } from '../utils/fpsSens';
import {
    ActivityIcon, ChatIcon, ChevronDownIcon, CopyIcon, CrosshairIcon, DisconnectIcon, FolderIcon, ForwardIcon,
    FullscreenExitIcon, FullscreenIcon, KeyboardIcon, LiveDotIcon, LockIcon, MinusIcon, MonitorIcon,
    MoreIcon, MouseIcon, PauseIcon, PlayIcon, PlusIcon, PowerIcon, SlidersIcon,
} from './Icons';

type MenuId = 'screen' | 'quality' | 'keys' | 'mouse' | 'more';

export interface DesktopBarProps {
    session: DeviceControlSession;
    controlEnabled: boolean;
    onSetControl: (on: boolean) => void;
    fpsMode: boolean;
    onSetGameMode: (on: boolean) => void;
    fpsSens: number;
    onAdjustSens: (delta: number) => void;
    /** Draw the pointer here, with no delay (the host reports its shape). */
    instantPointer: boolean;
    onSetInstantPointer: (on: boolean) => void;
    fitResolution: FitResolution;
    onSetFit: (next: FitResolution) => void;
    qualityValue: string;
    qualityPending: boolean;
    zoom: number;
    onZoom: (op: 'in' | 'out' | 'reset') => void;
    fullscreen: boolean;
    onToggleFullscreen: () => void;
    showStats: boolean;
    onToggleStats: () => void;
    stats: LiveStats | null;
    /** The measured input-to-picture time (the latency probe), when there is one. */
    latency: LatencyReading | null;
    tunnels: TunnelStatus | null;
    onOpenFiles: () => void;
    onMinimize: () => void;
    onCopyDiagnostics: () => void;
    onSendClipboard: () => void;
    clipboardBusy: boolean;
    onTypeText: () => void;
    onTypeClipboard: () => void;
    /** A moment's feedback for an action, shown in the bar's note slot. */
    onNotice: (message: string) => void;
    /** A menu opened or closed: the stage stops forwarding keys meanwhile. */
    onMenuOpenChange: (open: boolean) => void;
    /** The bar's notes and errors, rendered after the menus. */
    notes?: ReactNode;
}

/** One row of a menu. */
function Item({ icon, label, hint, onClick, checked, radio, danger, disabled }: {
    icon?: ReactNode;
    label: string;
    hint?: string;
    onClick: () => void;
    /** Set for a checkbox or radio row. */
    checked?: boolean;
    radio?: boolean;
    danger?: boolean;
    disabled?: boolean;
}) {
    const role = checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox';
    return (
        <button
            type="button"
            role={role}
            aria-checked={checked === undefined ? undefined : checked}
            className={`dsb-item${danger ? ' danger' : ''}${checked ? ' checked' : ''}`}
            disabled={disabled}
            onClick={onClick}
        >
            <span className="dsb-item-icon" aria-hidden="true">{icon}</span>
            <span className="dsb-item-label">{label}</span>
            {hint && <span className="dsb-item-hint">{hint}</span>}
        </button>
    );
}

const Sep = () => <div className="dsb-sep" role="separator" />;

/** The chip's latency figure: the measured input-to-picture time when the
 *  host answers the probe, else this end's share (a floor, shown with ~). */
function latencyText(stats: LiveStats, latency: LatencyReading | null): string | null {
    if (latency?.totalMs != null) return `${Math.round(latency.totalMs)} ms`;
    if (stats.hereMs === null) return null;
    return `~${stats.hereMs} ms`;
}

function statsTitle(stats: LiveStats, latency: LatencyReading | null): string {
    const rows = [
        latency?.totalMs != null && `Input to picture, measured: ${Math.round(latency.totalMs)} ms${latency.hostMs != null ? ` (that computer: ${Math.round(latency.hostMs)} ms)` : ''}`,
        stats.frame && `Picture ${stats.frame}${stats.fps !== null ? ` at ${stats.fps} fps` : ''}`,
        stats.path && `Path ${stats.path === 'relay' ? 'via a relay (TURN)' : 'direct'}${stats.protocol ? ` over ${stats.protocol.toUpperCase()}` : ''}`,
        stats.rttMs !== null && `Round trip ${stats.rttMs} ms`,
        stats.bufferMs !== null && `Waiting to show ${stats.bufferMs} ms`,
        stats.decodeMs !== null && `Decoding ${stats.decodeMs} ms`,
        stats.hereMs !== null && `This end's share of the delay: about ${stats.hereMs} ms (the other computer's capture and encode come on top)`,
        stats.inputLane && `Your input goes ${stats.inputLane === 'channel' ? 'straight to that computer' : 'through the server'}`,
    ];
    return rows.filter(Boolean).join('\n');
}

export function DeviceStageDesktopBar(p: DesktopBarProps) {
    const { session } = p;
    const [open, setOpen] = useState<MenuId | null>(null);
    const [confirmShutdown, setConfirmShutdown] = useState(false);
    const canControl = p.controlEnabled && !session.viewOnly;

    const { onMenuOpenChange } = p;
    useEffect(() => { onMenuOpenChange(open !== null); }, [open, onMenuOpenChange]);
    // Closing the bar's menus must not survive the bar.
    useEffect(() => () => onMenuOpenChange(false), [onMenuOpenChange]);

    // Escape closes the open menu — the stage forwards no keys while one is
    // open, so this is the only listener that hears it.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.type !== 'keydown') return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(null);
            setConfirmShutdown(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open]);

    const close = () => { setOpen(null); setConfirmShutdown(false); };
    const toggle = (id: MenuId) => {
        setConfirmShutdown(false);
        setOpen(cur => (cur === id ? null : id));
    };
    /** Run an action and close the menu. */
    const act = (fn: () => void) => () => { fn(); close(); };
    const notSent = (what: string) => p.onNotice(`Not connected — ${what} was not sent`);
    const chord = (mods: string[], key: string, what: string) =>
        act(() => { if (!sendChord(session.id, mods, key)) notSent(what); });
    const power = (action: PowerAction, doing: string, failed: string) => act(() => {
        if (!sendPowerAction(session.id, action)) p.onNotice(`Not connected — ${failed}`);
        else p.onNotice(doing);
    });

    const active = session.activeMonitor ?? session.monitors[0]?.id;
    const menuButton = (id: MenuId, icon: ReactNode, label: string) => (
        <button
            type="button"
            className={`device-stage-btn dsb-menu-btn${open === id ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === id}
            onClick={() => toggle(id)}
        >
            {icon} {label} <ChevronDownIcon />
        </button>
    );

    const stats = p.stats;
    const latency = stats ? latencyText(stats, p.latency) : null;

    return (
        <div className="device-stage-bar dsb">
            {open && (
                <span
                    className="dsb-backdrop"
                    onPointerDown={e => { e.preventDefault(); e.stopPropagation(); }}
                    onPointerUp={e => { e.preventDefault(); e.stopPropagation(); close(); }}
                />
            )}
            <span className="device-stage-title">
                <LiveDotIcon />{' '}
                {session.phase === 'connecting'
                    ? 'Connecting…'
                    : `Controlling ${session.peerName?.trim() || 'a device'}`}
            </span>
            {!!p.tunnels?.listeners.length && (
                <span
                    className="device-stage-tunnels"
                    title={p.tunnels.listeners
                        .map(l => `127.0.0.1:${l.local_port} → ${l.target_host}:${l.target_port}`)
                        .join('\n')}
                >
                    <ForwardIcon />
                    {` ${p.tunnels.listeners.length} forward${p.tunnels.listeners.length === 1 ? '' : 's'}`}
                    {p.tunnels.active_streams > 0 && ` · ${p.tunnels.active_streams} active`}
                </span>
            )}

            <span className="dsb-menu-wrap">
                {menuButton('screen', <MonitorIcon />, 'Screen')}
                {open === 'screen' && (
                    <div className="dsb-menu" role="menu" aria-label="Screen">
                        {session.monitors.length > 1 && (
                            <>
                                {session.monitors.map(m => (
                                    <Item
                                        key={m.id}
                                        label={m.label}
                                        checked={active === m.id}
                                        radio
                                        onClick={act(() => requestMonitor(session.id, m.id))}
                                    />
                                ))}
                                <Item
                                    label="All displays"
                                    checked={active === ALL_DISPLAYS}
                                    radio
                                    onClick={act(() => requestMonitor(session.id, ALL_DISPLAYS))}
                                />
                                <Sep />
                            </>
                        )}
                        <Item
                            label="Fit the picture to this window (less lag)"
                            checked={p.fitResolution === 'fit'}
                            onClick={act(() => p.onSetFit(p.fitResolution === 'fit' ? 'full' : 'fit'))}
                        />
                        <Item
                            icon={p.fullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
                            label="Fullscreen"
                            hint="Ctrl+Alt+Enter"
                            checked={p.fullscreen}
                            onClick={act(p.onToggleFullscreen)}
                        />
                        <div className="dsb-row" role="group" aria-label="Zoom">
                            <span className="dsb-row-label">Zoom</span>
                            <button type="button" className="device-stage-btn dsb-icon-btn" aria-label="Zoom out" disabled={p.zoom <= 1} onClick={() => p.onZoom('out')}><MinusIcon /></button>
                            <span className="dsb-zoom-value">{Math.round(p.zoom * 100)}%</span>
                            <button type="button" className="device-stage-btn dsb-icon-btn" aria-label="Zoom in" onClick={() => p.onZoom('in')}><PlusIcon /></button>
                            <button type="button" className="device-stage-btn" disabled={p.zoom <= 1} onClick={() => p.onZoom('reset')}>Fit</button>
                        </div>
                        <Item
                            icon={<ActivityIcon />}
                            label="Show stats"
                            checked={p.showStats}
                            onClick={act(p.onToggleStats)}
                        />
                        {canControl && (
                            <>
                                <Sep />
                                {/* The host acks privacy mode, so the tick is
                                    what that computer confirmed, never the click
                                    (session.privacyActive). */}
                                <Item
                                    label="Privacy mode (blank that computer's screen)"
                                    checked={session.privacyActive}
                                    onClick={act(() => setPrivacyMode(session.id, !session.privacyActive))}
                                />
                                <Sep />
                                <Item icon={<MonitorIcon />} label="Turn displays off" onClick={power('displays_off', 'Turning displays off…', 'displays unchanged')} />
                                <Item icon={<MonitorIcon />} label="Turn displays off, keep primary" onClick={power('displays_off_keep_primary', 'Turning other displays off…', 'displays unchanged')} />
                                <Item icon={<MonitorIcon />} label="Turn displays on" onClick={power('displays_on', 'Turning displays on…', 'displays unchanged')} />
                                <Item icon={<MonitorIcon />} label="Disable other displays" onClick={power('displays_detach_others', 'Disabling other displays…', 'displays unchanged')} />
                                <Item icon={<MonitorIcon />} label="Re-enable displays" onClick={power('displays_reattach', 'Re-enabling displays…', 'displays unchanged')} />
                            </>
                        )}
                    </div>
                )}
            </span>

            <span className="dsb-menu-wrap">
                {menuButton('quality', <SlidersIcon />, 'Quality')}
                {open === 'quality' && (
                    <div className="dsb-menu" role="menu" aria-label="Quality">
                        {/* CONTROLLED off the store: the tick is what the host
                            confirmed, so a refused change snaps back. */}
                        {[...STREAM_QUALITY_PRESETS].reverse().map(preset => {
                            const value = presetValue(preset);
                            return (
                                <Item
                                    key={value}
                                    label={preset.label}
                                    checked={p.qualityValue === value}
                                    radio
                                    disabled={p.qualityPending}
                                    onClick={act(() => {
                                        const parsed = parsePresetValue(value);
                                        if (parsed) sendStreamQuality(session.id, parsed.fps, parsed.bitrateKbps);
                                    })}
                                />
                            );
                        })}
                    </div>
                )}
            </span>

            {canControl && (
                <span className="dsb-menu-wrap">
                    {menuButton('keys', <KeyboardIcon />, 'Keyboard')}
                    {open === 'keys' && (
                        <div className="dsb-menu" role="menu" aria-label="Keyboard">
                            {/* ONE frame, `{t:'sas'}`: Windows ignores injected
                                keys for the secure attention sequence, so the
                                host asks its system service (chords.ts). */}
                            <Item
                                label="Ctrl + Alt + Del"
                                hint="Ctrl+Alt+End"
                                onClick={act(() => {
                                    if (!sendInput(session.id, { t: 'sas' })) notSent('Ctrl+Alt+Del');
                                    else p.onNotice('Ctrl+Alt+Del sent');
                                })}
                            />
                            <Item label="Alt + Tab" onClick={chord(['AltLeft'], 'Tab', 'Alt+Tab')} />
                            <Item label="Alt + F4" onClick={chord(['AltLeft'], 'F4', 'Alt+F4')} />
                            <Item label="Esc" onClick={chord([], 'Escape', 'Esc')} />
                            <Item label="Windows key" onClick={chord([], 'MetaLeft', 'the Windows key')} />
                            <Item label="Windows + D (show the desktop)" onClick={chord(['MetaLeft'], 'KeyD', 'Windows+D')} />
                            <Item label="Ctrl + Shift + Esc (Task Manager)" onClick={chord(['ControlLeft', 'ShiftLeft'], 'Escape', 'Ctrl+Shift+Esc')} />
                            <Item label="Print Screen" onClick={chord([], 'PrintScreen', 'Print Screen')} />
                            <Sep />
                            <Item icon={<KeyboardIcon />} label="Type text…" onClick={act(p.onTypeText)} />
                            <Item icon={<CopyIcon />} label="Type this computer's clipboard" onClick={act(p.onTypeClipboard)} />
                            <Item
                                icon={<CopyIcon />}
                                label={p.clipboardBusy ? 'Sending the clipboard…' : 'Send the clipboard (paste it over there)'}
                                disabled={p.clipboardBusy}
                                onClick={act(p.onSendClipboard)}
                            />
                            <Sep />
                            <div className="dsb-shortcuts" aria-label="Shortcuts">
                                {STAGE_SHORTCUTS.map(s => (
                                    <div key={s.keys} className="dsb-shortcut">
                                        <kbd>{s.keys}</kbd><span>{s.what}</span>
                                    </div>
                                ))}
                                <div className="dsb-shortcut dsb-shortcut-note">
                                    Every other key, Esc included, goes to that computer.
                                </div>
                            </div>
                        </div>
                    )}
                </span>
            )}

            {canControl && (
                <span className="dsb-menu-wrap">
                    {menuButton('mouse', <MouseIcon />, 'Mouse')}
                    {open === 'mouse' && (
                        <div className="dsb-menu" role="menu" aria-label="Mouse">
                            <Item
                                icon={<MouseIcon />}
                                label="Draw the pointer here (no delay)"
                                checked={p.instantPointer}
                                onClick={act(() => p.onSetInstantPointer(!p.instantPointer))}
                            />
                            <Item
                                icon={<CrosshairIcon />}
                                label="Game mode (send mouse movement, for games)"
                                checked={p.fpsMode}
                                onClick={act(() => p.onSetGameMode(!p.fpsMode))}
                            />
                            <div className="dsb-row" role="group" aria-label="Game mode sensitivity">
                                <span className="dsb-row-label">Sensitivity</span>
                                <button type="button" className="device-stage-btn dsb-icon-btn" aria-label="Lower Game-mode sensitivity" disabled={p.fpsSens <= FPS_SENS_MIN} onClick={() => p.onAdjustSens(-FPS_SENS_STEP)}><MinusIcon /></button>
                                <span className="dsb-zoom-value">{fmtSens(p.fpsSens)}</span>
                                <button type="button" className="device-stage-btn dsb-icon-btn" aria-label="Raise Game-mode sensitivity" disabled={p.fpsSens >= FPS_SENS_MAX} onClick={() => p.onAdjustSens(FPS_SENS_STEP)}><PlusIcon /></button>
                            </div>
                        </div>
                    )}
                </span>
            )}

            <button type="button" className="device-stage-btn" onClick={p.onOpenFiles}>
                <FolderIcon /> Files
            </button>

            <span className="dsb-menu-wrap">
                <button
                    type="button"
                    className={`device-stage-btn dsb-menu-btn${open === 'more' ? ' open' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={open === 'more'}
                    aria-label="More"
                    onClick={() => toggle('more')}
                >
                    <MoreIcon />
                </button>
                {open === 'more' && !confirmShutdown && (
                    <div className="dsb-menu dsb-menu-end" role="menu" aria-label="More">
                        {canControl && (
                            <>
                                <Item icon={<LockIcon />} label="Lock" onClick={power('lock', 'Locking the computer you are controlling…', 'could not lock')} />
                                <Item icon={<PowerIcon />} label="Shut down…" danger onClick={() => setConfirmShutdown(true)} />
                                <Sep />
                            </>
                        )}
                        <Item icon={<ActivityIcon />} label="Copy diagnostics" onClick={act(p.onCopyDiagnostics)} />
                        <Item icon={<ChatIcon />} label="Back to Púca (keep the session)" onClick={act(p.onMinimize)} />
                    </div>
                )}
                {open === 'more' && confirmShutdown && (
                    <div className="dsb-menu dsb-menu-end dsb-confirm" role="alertdialog" aria-labelledby="dsb-confirm-title">
                        <strong id="dsb-confirm-title">Shut down the computer you are controlling?</strong>
                        <span>It will power off and this session will end. Anything unsaved on it may be lost.</span>
                        <div className="dsb-confirm-actions">
                            <button type="button" className="device-stage-btn" onClick={close}>Cancel</button>
                            <button
                                type="button"
                                className="device-stage-btn device-stage-btn-danger"
                                onClick={power('shutdown', 'Shutting down…', 'could not shut down')}
                            >
                                Shut down
                            </button>
                        </div>
                    </div>
                )}
            </span>

            {p.notes}

            <span className="dsb-spacer" />

            {stats && (
                <button
                    type="button"
                    className={`dsb-stats-chip${stats.path === 'relay' ? ' relay' : ''}`}
                    title={statsTitle(stats, p.latency)}
                    aria-label="Show stats"
                    aria-pressed={p.showStats}
                    onClick={p.onToggleStats}
                >
                    <ActivityIcon />
                    {stats.fps !== null && <span>{Math.round(stats.fps)} fps</span>}
                    {latency && <span>{latency}</span>}
                    {stats.path === 'relay' && <span>relay</span>}
                </button>
            )}
            <button
                type="button"
                className="device-stage-btn dsb-icon-btn"
                aria-label={p.fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
                title={`${p.fullscreen ? 'Leave fullscreen' : 'Fullscreen'} (Ctrl+Alt+Enter)`}
                aria-pressed={p.fullscreen}
                onClick={p.onToggleFullscreen}
            >
                {p.fullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
            </button>
            {!session.viewOnly && (
                <button
                    type="button"
                    className="device-stage-btn"
                    aria-pressed={p.controlEnabled}
                    title="Pause or resume control (Ctrl+Alt+Home)"
                    onClick={() => p.onSetControl(!p.controlEnabled)}
                >
                    {p.controlEnabled ? <><PauseIcon /> Pause control</> : <><PlayIcon /> Resume control</>}
                </button>
            )}
            <button
                type="button"
                className="device-stage-btn device-stage-btn-danger"
                onClick={() => endSession(session.id, 'you disconnected')}
            >
                <DisconnectIcon /> Disconnect
            </button>
        </div>
    );
}
