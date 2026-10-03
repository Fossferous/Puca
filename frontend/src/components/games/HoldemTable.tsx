import { useState } from 'react';
import { gameFrames, type GameClientFrame, type HoldemSeat, type HoldemView } from '../../api/games/protocol';
import type { HeldTable } from '../../api/games/gamesStore';
import type { GamesGate } from '../../api/games/gamesGate';
import { clampRaise, holdemBar, holdemBusted, raiseAction, raisePresets, raiseStep } from '../../api/games/holdemActions';
import { CATEGORY_NAMES, chips, eventLine } from '../../api/games/gameWords';
import { CardSlot, PlayingCard } from './PlayingCard';
import { AmountSheet, SeatAvatar, Stepper, TurnClock } from './GameBits';
import { useCountdown } from './useCountdown';

interface HoldemTableProps {
    table: HeldTable & { view: HoldemView };
    gate: GamesGate;
    /** Phone layout (the JS half of the coarse-pointer gate). */
    isPhone: boolean;
    nameOf: (userId: number) => string;
    currentUserId: number;
    /** Take a seat (the parent shows the disclosure first, once). */
    onSit: (seat: number) => void;
    send: (frame: GameClientFrame) => void;
    /** When the last refusal arrived (re-enables the bar after a refused act). */
    refusedAt: number | null;
}

const STREET_LABEL: Record<string, string> = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };

/** The seats to draw in the opponents' strip: the players after the viewer,
 *  clockwise (a spectator: from seat 0), then the open seats — so on a phone
 *  the people at the table are what the strip shows before any scrolling. */
function stripOrder(view: HoldemView): number[] {
    const n = view.seats.length;
    const me = view.viewer_seat;
    const ring = me === null ? [...Array(n).keys()] : [...Array(n - 1).keys()].map(i => (me + 1 + i) % n);
    return [...ring.filter(i => view.seats[i]), ...ring.filter(i => !view.seats[i])];
}

function seatStatus(s: HoldemSeat): string | null {
    if (s.away) return 'Away';
    if (s.leaving) return 'Leaving';
    if (s.status === 'folded') return 'Folded';
    if (s.status === 'all_in') return 'All-in';
    if (s.sitting_out || s.status === 'sitting_out') return 'Sitting out';
    return null;
}

/**
 * The Hold'em table (docs/GAMES.md, *The table on screen*). Everything shown
 * is the server's view for THIS connection: other players' cards are '??'
 * until shown, `legal` exists only when it is the viewer's turn, and the
 * action bar is read straight off it (api/games/holdemActions.ts).
 */
export function HoldemTable({ table, gate, isPhone, nameOf, currentUserId, onSit, send, refusedAt }: HoldemTableProps) {
    const v = table.view;
    const room = table.room_id;
    const id = table.table_id;
    const me = v.viewer_seat === null ? null : v.seats[v.viewer_seat];
    const bar = holdemBar(v);
    const presets = raisePresets(v);
    const turnKey = v.turn ? `${v.turn.hand_no}:${v.turn.turn_seq}` : '';

    // The raise amount, remembered for THIS decision only: a new turn starts
    // at the minimum again. `text` is what is being typed into the desktop
    // field: clamping on every keystroke would turn the "5" of "50" into the
    // minimum before the "0" arrived. It is clamped when it is used.
    const [raise, setRaise] = useState<{ key: string; amount: number; text?: string } | null>(null);
    // The decision we already answered: the bar waits for the next view
    // (or a refusal) rather than letting a second tap send a second action.
    const [sent, setSent] = useState<{ key: string; at: number } | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [shownHand, setShownHand] = useState<number | null>(null);

    const raiseTo = bar?.raise
        ? (raise && raise.key === turnKey ? clampRaise(raise.amount, v.legal!) : bar.raise.min)
        : 0;
    const raiseText = raise && raise.key === turnKey && raise.text !== undefined ? raise.text : String(raiseTo);
    const busy = !!sent && sent.key === turnKey && !(refusedAt !== null && refusedAt > sent.at);

    const act = (action: Parameters<typeof gameFrames.act>[3]) => {
        if (!v.turn || busy) return;
        setSent({ key: turnKey, at: Date.now() });
        setSheetOpen(false);
        send(gameFrames.act(room, id, v.turn, action));
    };

    const nextDeal = useCountdown(v.in_hand ? null : v.next_deal_in_ms, table.receivedAt);
    const seated = v.seats.filter(Boolean).length;
    const centreLine = v.in_hand
        ? (v.street ? STREET_LABEL[v.street] : '')
        : nextDeal !== null
            ? `Next hand in ${Math.ceil(nextDeal / 1000)}s`
            : seated < 2 ? 'Waiting for another player' : 'Waiting for the next hand';

    const seatName = (seat: number) => {
        const s = v.seats[seat];
        if (!s) return `Seat ${seat + 1}`;
        return s.user_id === currentUserId ? 'You' : nameOf(s.user_id);
    };
    const userName = (uid: number) => (uid === currentUserId ? 'You' : nameOf(uid));
    const lines = table.log
        .map(e => eventLine(e, 'holdem', seatName, userName))
        .filter((l): l is string => !!l)
        .slice(isPhone ? -2 : -5);

    // What the viewer's own hand made at the last showdown.
    const lastShowdown = [...table.log].reverse().find(e => e.type === 'showdown');
    const myCategory = lastShowdown && lastShowdown.type === 'showdown' && v.viewer_seat !== null && !v.in_hand
        ? lastShowdown.shown.find(h => h.seat === v.viewer_seat)?.category ?? null
        : null;

    const canShow = !!me && !v.in_hand && v.hand_no > 0 && !!me.cards && me.cards[0] !== '??'
        && shownHand !== v.hand_no && !myCategory;
    const busted = holdemBusted(v);

    const raiseLabel = (amount: number) => (bar?.raise && amount >= bar.raise.max ? `All-in ${chips(amount)}` : `${bar?.raise?.verb ?? 'Raise'} to ${chips(amount)}`);

    return (
        <div className="gtable gtable-holdem">
            <div className="games-scroll">
                <div className="games-opps" role="list" aria-label="Players">
                    {stripOrder(v).map(i => {
                        const s = v.seats[i];
                        if (!s) {
                            return (
                                <div key={i} role="listitem" className="gseat gseat-empty">
                                    <span className="gseat-name">Seat {i + 1}</span>
                                    {gate.canSit && v.viewer_seat === null ? (
                                        <button type="button" className="games-btn games-btn-primary gseat-sit" onClick={() => onSit(i)}>
                                            Sit here
                                        </button>
                                    ) : (
                                        <span className="gseat-meta">Open</span>
                                    )}
                                </div>
                            );
                        }
                        const status = seatStatus(s);
                        const toAct = v.to_act === i && v.in_hand;
                        const name = nameOf(s.user_id);
                        return (
                            <div
                                key={i}
                                role="listitem"
                                className={`gseat${toAct ? ' gseat-turn' : ''}${s.status === 'folded' ? ' gseat-folded' : ''}${s.away ? ' gseat-away' : ''}`}
                                aria-label={`${name}, ${chips(s.stack)} chips${status ? `, ${status}` : ''}${toAct ? ', to act' : ''}`}
                            >
                                <span className="gseat-top">
                                    <SeatAvatar name={name} />
                                    <span className="gseat-name">{name}</span>
                                    {v.button === i && <span className="gbadge gbadge-dealer" title="Dealer button">D</span>}
                                    {v.in_hand && v.small_blind_seat === i && <span className="gbadge" title="Small blind">SB</span>}
                                    {v.in_hand && v.big_blind_seat === i && <span className="gbadge" title="Big blind">BB</span>}
                                </span>
                                <span className="gseat-mid">
                                    <span className="gseat-stack">{chips(s.stack)}</span>
                                    {s.cards && (
                                        <span className="gseat-cards">
                                            {s.cards.map((c, k) => <PlayingCard key={k} code={c} size="sm" muted={s.status === 'folded'} />)}
                                        </span>
                                    )}
                                </span>
                                <span className="gseat-bottom">
                                    {s.street_commit > 0 && <span className="gseat-commit">{chips(s.street_commit)}</span>}
                                    {status && <span className="gseat-status">{status}</span>}
                                </span>
                                {toAct && <TurnClock ms={v.clock_ms} receivedAt={table.receivedAt} totalSecs={v.config.turn_clock_secs} compact />}
                                {gate.canModerate && (
                                    <button
                                        type="button"
                                        className="games-btn games-btn-ghost gseat-remove"
                                        onClick={() => {
                                            if (confirm(`Remove ${name} from the table? Their hand folds and they get up.`)) {
                                                send(gameFrames.removePlayer(room, id, i));
                                            }
                                        }}
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>

                <div className="gcentre">
                    <div className="gboard" aria-label="Board">
                        {[0, 1, 2, 3, 4].map(k => (v.board[k]
                            ? <PlayingCard key={k} code={v.board[k]} size="md" />
                            : <CardSlot key={k} size="md" />))}
                    </div>
                    <div className="gpot">
                        <span>Pot <strong>{chips(v.pot_total)}</strong></span>
                        <span className="gcentre-line">{centreLine}</span>
                    </div>
                </div>

                {me && !bar && (
                    <div className="games-actions-row games-seat-row">
                        {busted && v.config.allow_rebuy && (
                            <button type="button" className="games-btn games-btn-primary" onClick={() => send(gameFrames.rebuy(room, id))}>
                                Rebuy {chips(v.config.starting_stack)}
                            </button>
                        )}
                        {canShow && (
                            <button
                                type="button"
                                className="games-btn"
                                onClick={() => { setShownHand(v.hand_no); send(gameFrames.showCards(room, id)); }}
                            >
                                Show cards
                            </button>
                        )}
                        {me.sitting_out ? (
                            <button type="button" className="games-btn" onClick={() => send(gameFrames.sitIn(room, id))}>Sit back in</button>
                        ) : (
                            <button type="button" className="games-btn games-btn-ghost" onClick={() => send(gameFrames.sitOut(room, id))}>Sit out</button>
                        )}
                        <button
                            type="button"
                            className="games-btn games-btn-ghost"
                            onClick={() => {
                                if (!v.in_hand || me.status === 'folded' || confirm('Stand up now? Your hand folds.')) send(gameFrames.stand(room, id));
                            }}
                        >
                            Stand up
                        </button>
                    </div>
                )}
                {lines.length > 0 && (
                    <ol className="games-log" aria-label="What happened">
                        {lines.map((l, k) => <li key={`${table.version}-${k}`}>{l}</li>)}
                    </ol>
                )}
                {isPhone && me && (
                    <p className="games-phone-note">
                        If you switch away from Púca, your turn still runs out: you check if you can, otherwise you fold.
                    </p>
                )}
            </div>

            <div className="games-footer">
                <div className={`games-me${bar ? ' games-me-turn' : ''}`}>
                    {me ? (
                        <>
                            <span className="games-me-cards">
                                {me.cards
                                    ? me.cards.map((c, k) => <PlayingCard key={k} code={c} size="lg" muted={me.status === 'folded'} />)
                                    : <><CardSlot size="lg" /><CardSlot size="lg" /></>}
                            </span>
                            <span className="games-me-info">
                                <span className="games-me-stack">
                                    {chips(me.stack)} chips
                                    {v.button === v.viewer_seat && <span className="gbadge gbadge-dealer" title="Dealer button">D</span>}
                                </span>
                                {me.street_commit > 0 && <span className="games-me-commit">In: {chips(me.street_commit)}</span>}
                                {myCategory && <span className="games-me-result">{CATEGORY_NAMES[myCategory]}</span>}
                                {seatStatus(me) && <span className="gseat-status">{seatStatus(me)}</span>}
                                {bar
                                    ? <span className="games-me-turnline">Your turn <TurnClock ms={v.clock_ms} receivedAt={table.receivedAt} totalSecs={v.config.turn_clock_secs} /></span>
                                    : v.in_hand && v.to_act !== null && <span className="games-me-wait">{seatName(v.to_act)} to act</span>}
                            </span>
                        </>
                    ) : (
                        <span className="games-watch">
                            {gate.canSit ? 'You are watching. Pick an open seat to play.' : 'You are watching this table.'}
                        </span>
                    )}
                </div>
                {bar ? (
                    <div className="games-actions" aria-label="Your action">
                        <div className="games-actions-row">
                            <button type="button" className="games-btn games-btn-danger" disabled={busy} onClick={() => act({ type: 'fold' })}>
                                Fold
                            </button>
                            {bar.check ? (
                                <button type="button" className="games-btn" disabled={busy} onClick={() => act({ type: 'check' })}>Check</button>
                            ) : (
                                <button type="button" className="games-btn" disabled={busy} onClick={() => act({ type: 'call' })}>
                                    {bar.callIsAllIn ? `Call all-in ${chips(bar.call ?? 0)}` : `Call ${chips(bar.call ?? 0)}`}
                                </button>
                            )}
                            {bar.raise && (
                                <button
                                    type="button"
                                    className="games-btn games-btn-primary"
                                    disabled={busy}
                                    onClick={() => act(raiseAction(raiseTo, v.legal!))}
                                >
                                    {raiseLabel(raiseTo)}
                                </button>
                            )}
                        </div>
                        {bar.raise && !bar.raise.onlyAllIn && (
                            <div className="games-actions-row games-actions-row2">
                                {presets.map(p => (
                                    <button
                                        key={p.id}
                                        type="button"
                                        className={`games-btn games-btn-ghost gpreset${p.amount === raiseTo ? ' gpreset-on' : ''}`}
                                        disabled={busy}
                                        onClick={() => setRaise({ key: turnKey, amount: p.amount })}
                                        aria-label={`${p.label}: ${chips(p.amount)}`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                                <Stepper
                                    label="raise"
                                    onDown={() => setRaise({ key: turnKey, amount: clampRaise(raiseTo - raiseStep(v), v.legal!) })}
                                    onUp={() => setRaise({ key: turnKey, amount: clampRaise(raiseTo + raiseStep(v), v.legal!) })}
                                    downDisabled={busy || raiseTo <= bar.raise.min}
                                    upDisabled={busy || raiseTo >= bar.raise.max}
                                >
                                    {isPhone ? (
                                        <button
                                            type="button"
                                            className="games-btn games-amount-btn"
                                            disabled={busy}
                                            onClick={() => setSheetOpen(true)}
                                            aria-label={`Raise amount ${chips(raiseTo)}, tap to type it`}
                                        >
                                            {chips(raiseTo)}
                                        </button>
                                    ) : (
                                        <input
                                            className="games-amount-input"
                                            type="number"
                                            inputMode="numeric"
                                            min={bar.raise.min}
                                            max={bar.raise.max}
                                            step={raiseStep(v)}
                                            value={raiseText}
                                            disabled={busy}
                                            aria-label="Raise to"
                                            onChange={e => setRaise({ key: turnKey, amount: Number(e.target.value), text: e.target.value })}
                                            onBlur={() => setRaise({ key: turnKey, amount: raiseTo })}
                                            onKeyDown={e => { if (e.key === 'Enter') act(raiseAction(raiseTo, v.legal!)); }}
                                        />
                                    )}
                                </Stepper>
                            </div>
                        )}
                    </div>
                ) : null}
            </div>

            {sheetOpen && bar?.raise && (
                <AmountSheet
                    title={`${bar.raise.verb} to`}
                    value={raiseTo}
                    min={bar.raise.min}
                    max={bar.raise.max}
                    step={raiseStep(v)}
                    presets={presets}
                    confirmLabel={raiseLabel}
                    onConfirm={(amount) => act(raiseAction(amount, v.legal!))}
                    onClose={() => setSheetOpen(false)}
                />
            )}
        </div>
    );
}
