/**
 * PINNED KEYS on the remote-control stage: keys and shortcuts the user chose
 * (pinnedKeys.ts) as buttons over the picture, beside the virtual mouse's
 * L / M / R and built the same way — one draggable cluster with a grip,
 * parked and remembered by the same hook (usePadPos), 46 px buttons, the same
 * fixed dark palette as the rest of the stage chrome.
 *
 * PRESS SEMANTICS ARE A PHYSICAL KEY'S, like the mouse pad's buttons: pointer
 * DOWN presses the pin's modifiers and then its key on the host, UP releases
 * them in reverse. A tap is a keystroke; a hold is a hold (a game's W, a
 * held Shift). Two thumbs on two pins that share a modifier (Ctrl+C and
 * Ctrl+V) keep that modifier down until the LAST of them lets go — state is
 * keyed by pointer, for the reason the mouse pad's header gives.
 *
 * Ctrl+Alt+Del is the exception: it is a frame (`{t:'sas'}`), not keys, and
 * a single stray touch must not send it, so it fires on a completed click.
 *
 * Owns no wire knowledge: the stage passes onKey/onSas and keeps its own
 * record of what is held, so its blur / backgrounding / session-end release
 * covers these too. The cluster's own duty is releasing what IT pressed when
 * it unmounts mid-hold.
 *
 * THE EDITOR (DeviceStagePinnedKeysEditor) pins, unpins and reorders, and
 * marks up to three for the Android notification (shadeKeys.ts). It says
 * plainly what cannot be pinned: media and volume keys, which Púca on the
 * computer does not type.
 */
import { useEffect, useRef, useState } from 'react';
import {
    KEY_CATALOG,
    MAX_PINS,
    MAX_SHADE,
    MOD_LABEL,
    MOD_ORDER,
    SAS_CODE,
    canonicalPin,
    makePin,
    movePin,
    pinCodes,
    pinLabel,
    pinName,
    refusedChord,
    samePin,
    setShade,
    type PinMod,
    type PinnedKey,
} from '../api/devices/pinnedKeys';
import { capture, usePadPos } from '../api/devices/usePadPos';
import { shadeKeysAvailable } from '../api/devices/shadeKeys';
import { mobileNotificationStatus } from '../api/mobileApp';
import {
    ChevronDownIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    GripIcon,
    TrashIcon,
} from './Icons';

const PINS_POS_KEY = 'device-stage-pinned-keys-pos';
/** Grip strip + a row of 46 px buttons, padding included (a first guess
 *  before the cluster is measured; usePadPos re-clamps against the real one). */
const PINS_ESTIMATE = { width: 230, height: 60 };

/** The arrows read better as arrows; everything else as its label. */
const ARROW_ICON: Record<string, () => React.ReactElement> = {
    ArrowUp: () => <ChevronUpIcon />,
    ArrowDown: () => <ChevronDownIcon />,
    ArrowLeft: () => <ChevronLeftIcon />,
    ArrowRight: () => <ChevronRightIcon />,
};

function PinFace({ pin }: { pin: PinnedKey }) {
    const icon = pin.mods.length === 0 ? ARROW_ICON[pin.code] : undefined;
    return icon ? icon() : <>{pinLabel(pin)}</>;
}

export function DeviceStagePinnedKeys({ pins, onKey, onSas }: {
    pins: readonly PinnedKey[];
    /** One key code down or up on the host. */
    onKey: (code: string, down: boolean) => void;
    /** Ctrl+Alt+Del, the host's Secure Attention frame. */
    onSas: () => void;
}) {
    const clusterRef = useRef<HTMLDivElement>(null);
    const pad = usePadPos(PINS_POS_KEY, clusterRef, PINS_ESTIMATE, pins.length);

    const onKeyRef = useRef(onKey);
    useEffect(() => { onKeyRef.current = onKey; }, [onKey]);

    /** Which pointer holds which pin's codes (press order). The host's key is
     *  down while AT LEAST one pointer holds it; the ref is the truth, the
     *  state is the paint. */
    const held = useRef<Map<number, { id: string; codes: string[] }>>(new Map());
    const [heldView, setHeldView] = useState<ReadonlySet<string>>(new Set());
    const heldCodes = () => new Set([...held.current.values()].flatMap(h => h.codes));
    const paint = () => setHeldView(new Set([...held.current.values()].map(h => h.id)));

    const press = (pointerId: number, pin: PinnedKey) => {
        const codes = pinCodes(pin);
        if (!codes || held.current.has(pointerId)) return;
        const down = heldCodes();
        held.current.set(pointerId, { id: pin.id, codes });
        paint();
        for (const code of codes) {
            if (down.has(code)) continue;
            down.add(code);
            onKeyRef.current(code, true);
        }
    };
    const release = (pointerId: number) => {
        const h = held.current.get(pointerId);
        if (!h) return;
        held.current.delete(pointerId);
        paint();
        // Only the LAST finger off a code releases it on the host, and the
        // key goes up before its modifiers, as fingers leave a real keyboard.
        const still = heldCodes();
        for (const code of [...h.codes].reverse()) {
            if (!still.has(code)) onKeyRef.current(code, false);
        }
    };
    // The stage lets go of everything held when the window loses focus or the
    // app is hidden (its releaseAll, which covers pinned keys). Forget those
    // presses here too, or a finger still resting on Ctrl + C would make a
    // second pin sharing Ctrl skip its Ctrl down afterwards. A finger that
    // lifts later then releases nothing (an unmatched up is a no-op anyway).
    useEffect(() => {
        const forget = () => {
            if (held.current.size === 0) return;
            held.current.clear();
            setHeldView(new Set());
        };
        const onHidden = () => { if (document.hidden) forget(); };
        window.addEventListener('blur', forget);
        document.addEventListener('visibilitychange', onHidden);
        return () => {
            window.removeEventListener('blur', forget);
            document.removeEventListener('visibilitychange', onHidden);
        };
    }, []);
    // Unmounting mid-hold (the stage hidden, the pins turned off, the
    // session ending) must not strand a key down on the host.
    useEffect(() => () => {
        const codes = [...held.current.values()].flatMap(h => [...h.codes].reverse());
        held.current.clear();
        const sent = new Set<string>();
        for (const code of codes) {
            if (sent.has(code)) continue;
            sent.add(code);
            onKeyRef.current(code, false);
        }
    }, []);

    if (pins.length === 0) return null;
    return (
        <div
            ref={clusterRef}
            className="device-stage-virtual-mouse vm-cluster-pins"
            style={pad.style}
            data-testid="pinned-keys"
        >
            <div className="vm-grip" aria-label="Move the pinned keys" {...pad.gripHandlers}>
                <GripIcon />
            </div>
            <div className="vm-pin-keys">
                {pins.map(pin => (
                    <button
                        key={pin.id}
                        type="button"
                        // No focus: on a phone a focused button would take the
                        // keyboard bar's field (and the soft keyboard) away,
                        // and on a desktop every physical key already goes to
                        // that computer.
                        tabIndex={-1}
                        className={`vm-btn vm-pin${heldView.has(pin.id) ? ' vm-held' : ''}`}
                        aria-label={pinName(pin)}
                        title={pinName(pin)}
                        data-pin={pin.id}
                        onPointerDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (pin.code === SAS_CODE) return;
                            capture(e);
                            press(e.pointerId, pin);
                        }}
                        onPointerUp={e => { e.stopPropagation(); release(e.pointerId); }}
                        onPointerCancel={e => release(e.pointerId)}
                        onClick={pin.code === SAS_CODE ? onSas : undefined}
                    >
                        <PinFace pin={pin} />
                    </button>
                ))}
            </div>
        </div>
    );
}

/** The phone's notification permission, as the editor needs to say it. */
type NotifyState = 'unknown' | 'ok' | 'off';

export function DeviceStagePinnedKeysEditor({ pins, onChange, show, onShow, peerName, onClose }: {
    pins: readonly PinnedKey[];
    onChange: (next: PinnedKey[]) => void;
    /** "Show pinned keys on the screen". */
    show: boolean;
    onShow: (on: boolean) => void;
    peerName: string | null;
    onClose: () => void;
}) {
    const [mods, setMods] = useState<PinMod[]>([]);
    const [code, setCode] = useState('F5');
    const shadeOk = shadeKeysAvailable();
    const [notify, setNotify] = useState<NotifyState>('unknown');
    useEffect(() => {
        if (!shadeOk) return;
        let live = true;
        void mobileNotificationStatus().then(s => {
            if (!live) return;
            setNotify(s && s.granted && !s.blocked ? 'ok' : s ? 'off' : 'unknown');
        });
        return () => { live = false; };
    }, [shadeOk]);

    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => { dialogRef.current?.focus(); }, []);
    // ESCAPE CLOSES IT WHEREVER THE FOCUS IS. The dialog's own handler hears
    // only what is typed inside it, and a press that disables the button it
    // landed on ("Pin it", once that key is pinned) drops the focus to the
    // page — after which Escape reached nothing and the editor would not
    // close. The stage forwards nothing while the editor is open.
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.type !== 'keydown') return;
            e.preventDefault();
            e.stopPropagation();
            onCloseRef.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    const draft = canonicalPin(code, mods);
    const duplicate = pins.some(p => samePin(p, draft));
    const full = pins.length >= MAX_PINS;
    const refused = refusedChord(code, mods);
    const shadeCount = pins.filter(p => p.shade).length;
    const pc = peerName?.trim() || 'that computer';

    const toggleMod = (m: PinMod) => setMods(cur => (cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]));
    const add = () => {
        if (duplicate || full || refused) return;
        onChange([...pins, makePin(code, mods, pins)]);
        // "Pin it" is about to be disabled (that key is pinned now), and a
        // disabled button loses the focus to the page: keep it in the dialog.
        dialogRef.current?.focus();
    };

    return (
        <div
            className="device-stage-typetext-backdrop dspk-backdrop"
            onPointerDown={e => {
                e.stopPropagation();
                if (e.target === e.currentTarget) { e.preventDefault(); onClose(); }
            }}
            onPointerUp={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
        >
            <div
                ref={dialogRef}
                className="device-stage-typetext dspk-editor"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dspk-title"
                data-owns-keys=""
                tabIndex={-1}
            >
                <strong id="dspk-title">Pinned keys</strong>
                <span className="device-stage-typetext-help">
                    Buttons over the screen that press a key or a shortcut on {pc}. Hold one to hold the key down.
                </span>

                <label className="dspk-check">
                    <input type="checkbox" checked={show} onChange={e => onShow(e.target.checked)} />
                    Show pinned keys on the screen
                </label>

                {pins.length === 0 ? (
                    <span className="device-stage-typetext-help">Nothing is pinned yet.</span>
                ) : (
                    <ul className="dspk-list" aria-label="Pinned keys">
                        {pins.map((pin, i) => {
                            const name = pinName(pin);
                            const shadeBlocked = !pin.shade && shadeCount >= MAX_SHADE;
                            return (
                                <li key={pin.id} className="dspk-row" data-pin={pin.id}>
                                    <span className="dspk-name">{name}</span>
                                    {shadeOk && (
                                        <label className="dspk-check dspk-shade" title={shadeBlocked ? `Only ${MAX_SHADE} fit in the notification` : undefined}>
                                            <input
                                                type="checkbox"
                                                checked={pin.shade}
                                                disabled={shadeBlocked}
                                                onChange={e => onChange(setShade(pins, pin.id, e.target.checked))}
                                            />
                                            In the notification
                                        </label>
                                    )}
                                    <span className="dspk-row-actions">
                                        <button
                                            type="button"
                                            className="device-stage-btn dspk-icon"
                                            aria-label={`Move ${name} up`}
                                            disabled={i === 0}
                                            onClick={() => onChange(movePin(pins, i, -1))}
                                        >
                                            <ChevronUpIcon />
                                        </button>
                                        <button
                                            type="button"
                                            className="device-stage-btn dspk-icon"
                                            aria-label={`Move ${name} down`}
                                            disabled={i === pins.length - 1}
                                            onClick={() => onChange(movePin(pins, i, 1))}
                                        >
                                            <ChevronDownIcon />
                                        </button>
                                        <button
                                            type="button"
                                            className="device-stage-btn dspk-icon"
                                            aria-label={`Unpin ${name}`}
                                            onClick={() => onChange(pins.filter(p => p.id !== pin.id))}
                                        >
                                            <TrashIcon />
                                        </button>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}

                <fieldset className="dspk-add">
                    <legend>Pin a key</legend>
                    <div className="dspk-mods" role="group" aria-label="Held with it">
                        {MOD_ORDER.map(m => (
                            <label key={m} className="dspk-check">
                                <input
                                    type="checkbox"
                                    checked={code !== SAS_CODE && mods.includes(m)}
                                    disabled={code === SAS_CODE}
                                    onChange={() => toggleMod(m)}
                                />
                                {MOD_LABEL[m]}
                            </label>
                        ))}
                    </div>
                    <select aria-label="Key" value={code} onChange={e => setCode(e.target.value)}>
                        {KEY_CATALOG.map(g => (
                            <optgroup key={g.group} label={g.group}>
                                {g.keys.map(key => <option key={key.code} value={key.code}>{key.name}</option>)}
                            </optgroup>
                        ))}
                    </select>
                    <div className="dspk-add-row">
                        <span className="dspk-preview" aria-live="polite">{pinName(draft)}</span>
                        <button
                            type="button"
                            className="device-stage-btn device-stage-btn-primary"
                            disabled={duplicate || full || refused !== null}
                            onClick={add}
                        >
                            Pin it
                        </button>
                    </div>
                    {refused && <span className="device-stage-typetext-help">{refused}</span>}
                    {draft.code === SAS_CODE && code !== SAS_CODE && (
                        <span className="device-stage-typetext-help">Windows only takes this one from the Púca service, so it is pinned as Ctrl + Alt + Del.</span>
                    )}
                    {duplicate && <span className="device-stage-typetext-help">That one is already pinned.</span>}
                    {full && <span className="device-stage-typetext-help">{MAX_PINS} keys are pinned, the most there is room for. Unpin one first.</span>}
                </fieldset>

                {shadeOk && (
                    <span className="device-stage-typetext-help">
                        Keys marked &ldquo;In the notification&rdquo; (up to {MAX_SHADE}) are buttons on Púca&rsquo;s
                        notification while you control {pc}, so you can press them from other apps.
                        They work only with this phone unlocked, and go away when the session ends.
                        {notify === 'off' && ' Notifications are turned off for Púca, so they cannot show: turn them on in Android Settings.'}
                    </span>
                )}
                <span className="device-stage-typetext-help">
                    Media and volume keys cannot be pinned: Púca on the computer cannot press them yet.
                    {' '}Ctrl + Alt + Del goes through the Púca service on that computer, as in the More menu.
                    {' '}On a Linux computer, Print Screen, Scroll Lock, Num Lock and Menu do nothing.
                </span>
                <div className="device-stage-typetext-actions">
                    <button type="button" className="device-stage-btn device-stage-btn-primary" onClick={onClose}>Done</button>
                </div>
            </div>
        </div>
    );
}
