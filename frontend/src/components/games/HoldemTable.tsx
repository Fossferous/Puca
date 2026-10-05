import { useState, type CSSProperties } from 'react';
import { gameFrames, type GameClientFrame, type HoldemEvent, type HoldemSeat, type HoldemView } from '../../api/games/protocol';
import type { HeldTable } from '../../api/games/gamesStore';
import type { GamesGate } from '../../api/games/gamesGate';
import { clampRaise, holdemBar, holdemBusted, raiseAction, raisePresets, raiseStep } from '../../api/games/holdemActions';
import { CATEGORY_NAMES, chips, eventLine, potLabel } from '../../api/games/gameWords';
import { seatSpots } from '../../api/games/tableLayout';
import { CardSlot, FlipCard, PlayingCard } from './PlayingCard';
import { AmountSheet, SeatAvatar, Stepper, TurnClock } from './GameBits';
import { useCountdown } from './useCountdown';
import { timelineOf, useGameSounds } from './useGameSounds';

interface HoldemTableProps {
    table: HeldTable & { view: HoldemView };
    gate: GamesGate;
    /** Phone layout (the JS half of the coarse-pointer gate). */
    isPhone: boolean;
    nameOf: (userId: number) => string;
    /** userId -> avatar file id (absent: initials). */
    avatarOf?: (userId: number) => string | null | undefined;
    currentUserId: number;
    /** Take a seat (the parent shows the disclosure first, once). */
    onSit: (seat: number) => void;
    /** Send a frame; false when it did not go out (the socket is down). */
    send: (frame: GameClientFrame) => boolean;
    /** When the last refusal arrived (re-enables the bar after a refused act). */
    refusedAt: number | null;
}

const STREET_LABEL: Record<string, string> = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };

/** The pots awarded in hand `handNo` (the pot_awarded events just before its
 *  hand_ended), for the result shown on the felt between hands. Empty when
 *  this client did not see that hand end - after a gap the log may hold an
 *  OLDER hand's awards, which must not be shown as this one's. */
function lastAwards(log: readonly { type: string }[], handNo: number): Extract<HoldemEvent, { type: 'pot_awarded' }>[] {
    const out: Extract<HoldemEvent, { type: 'pot_awarded' }>[] = [];
    let i = log.length - 1;
    for (; i >= 0; i--) {
        const e = log[i] as HoldemEvent;
        if (e.type === 'hand_ended') break;
    }
    if (i < 0 || (log[i] as Extract<HoldemEvent, { type: 'hand_ended' }>).hand_no !== handNo) return out;
    for (i--; i >= 0; i--) {
        const e = log[i] as HoldemEvent;
        if (e.type === 'hand_started' || e.type === 'hand_ended') break;
        if (e.type === 'pot_awarded') out.unshift(e);
    }
    return out;
}

/** The order the other seats are READ in (the list's DOM order; where each is
 *  DRAWN is tableLayout's): the players after the viewer, clockwise (a
 *  spectator: from seat 0), then the open seats. */
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
export function HoldemTable({ table, gate, isPhone, nameOf, avatarOf, currentUserId, onSit, send, refusedAt }: HoldemTableProps) {
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
    // Held for the VIEW it answered, not only the turn: a resync after a
    // reconnect shows the same turn again (the server never got the action),
    // and that new view must give the bar back - a duplicate is a harmless
    // stale_turn, a bar locked until the clock folds you is not.
    const [sent, setSent] = useState<{ key: string; view: HeldTable; at: number } | null>(null);
    // The raise sheet, for the decision it was opened for only: left open
    // when the turn passed, it must not come back (and grab the phone's
    // keyboard) by itself at the next turn.
    const [sheetFor, setSheetFor] = useState<string | null>(null);
    const sheetOpen = sheetFor !== null && sheetFor === turnKey;
    const [shownHand, setShownHand] = useState<number | null>(null);
    // What was on the board when the table opened: those cards are already
    // face up, not news, and do not flip again.
    const [opened] = useState(() => ({ hand: v.hand_no, board: v.board.length }));
    useGameSounds(table);
    const reveals = timelineOf(table).reveals;

    const raiseTo = bar?.raise
        ? (raise && raise.key === turnKey ? clampRaise(raise.amount, v.legal!) : bar.raise.min)
        : 0;
    const raiseText = raise && raise.key === turnKey && raise.text !== undefined ? raise.text : String(raiseTo);
    const busy = !!sent && sent.key === turnKey && sent.view === table && !(refusedAt !== null && refusedAt > sent.at);

    const act = (action: Parameters<typeof gameFrames.act>[3]) => {
        if (!v.turn || busy) return;
        setSheetFor(null);
        // Only an action that went out holds the bar.
        if (send(gameFrames.act(room, id, v.turn, action))) setSent({ key: turnKey, view: table, at: Date.now() });
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

    const spots = seatSpots(v.seats.length, v.viewer_seat);
    // The middle of the felt: the live main pot and side pots (a server that
    // predates them sends only the total), or, between hands, who won what.
    const seatLabel = (seat: number) => (seat === v.viewer_seat ? 'You' : v.seats[seat] ? nameOf(v.seats[seat]!.user_id) : `Seat ${seat + 1}`);
    const awards = !v.in_hand && v.hand_no > 0 ? lastAwards(table.log, v.hand_no) : [];
    const potCount = awards.reduce((n, a) => Math.max(n, a.pot + 1), 0);
    const meIn = (eligible: number[]) => v.viewer_seat === null || eligible.includes(v.viewer_seat);
    const potsAdded = v.pots.reduce((a, p) => a + p.amount, 0);
    const pots = v.in_hand && v.pots.length > 1 ? (
        <>
            {v.pots.map((p, k) => (
                <span key={k} className={`gpot-pill${meIn(p.eligible) ? '' : ' gpot-out'}`}>
                    {potLabel(k, v.pots.length)} <strong>{chips(p.amount)}</strong>
                    {!meIn(p.eligible) && <span className="sr-only"> (you are not in this pot)</span>}
                </span>
            ))}
            {v.pot_total > potsAdded && <span className="gpot-total">Total {chips(v.pot_total)}</span>}
        </>
    ) : v.in_hand || awards.length === 0 ? (
        <span>Pot <strong>{chips(v.pot_total)}</strong></span>
    ) : (
        awards.map((a, k) => (
            <span key={k} className="gpot-pill gpot-won">
                {potLabel(a.pot, potCount)} <strong>{chips(a.amount)}</strong>
                {' '}{a.shares.map(sh => seatLabel(sh.seat)).join(', ')}
            </span>
        ))
    );

    const raiseLabel = (amount: number) => (bar?.raise && amount >= bar.raise.max ? `All-in ${chips(amount)}` : `${bar?.raise?.verb ?? 'Raise'} to ${chips(amount)}`);

    return (
        <div className="gtable gtable-holdem">
            <div className="games-scroll">
                <div className={`gtable-oval${v.viewer_seat !== null ? ' gtable-oval-seated' : ''}`}>
                    <div className="gtable-rail">
                        <div className="gcentre">
                            <div className="gpot">
                                {pots}
                            </div>
                            <div className="gboard" role="group" aria-label="Board">
                                {[0, 1, 2, 3, 4].map(k => {
                                    const code = v.board[k];
                                    if (code) {
                                        const old = v.hand_no === opened.hand && k < opened.board;
                                        return <FlipCard key={`${v.hand_no}-${k}-${code}`} code={code} delay={reveals[code] ?? 0} animate={!old} />;
                                    }
                                    // Not dealt yet: a plain back with no card in it.
                                    return v.in_hand
                                        ? <PlayingCard key={`${v.hand_no}-${k}-down`} code="??" size="md" />
                                        : <CardSlot key={`${v.hand_no}-${k}-slot`} size="md" />;
                                })}
                            </div>
                            <span className="gcentre-line">{centreLine}</span>
                        </div>
                    </div>
                    <ul className="games-opps" aria-label="Players">
                        {[...(v.viewer_seat !== null ? [v.viewer_seat] : []), ...stripOrder(v)].map(i => {
                            const spot = spots[i];
                            const style = { '--gx': `${spot.x}%`, '--gy': `${spot.y}%` } as CSSProperties;
                            const s = v.seats[i];
                            if (!s) {
                                return (
                                    <li key={i} className={`gseat gseat-empty gseat-side-${spot.side}`} style={style}>
                                        <span className="gseat-name">Seat {i + 1}</span>
                                        {gate.canSit && v.viewer_seat === null ? (
                                            <button type="button" className="games-btn games-btn-primary gseat-sit" onClick={() => onSit(i)}>
                                                Sit here
                                            </button>
                                        ) : (
                                            <span className="gseat-meta">Open</span>
                                        )}
                                    </li>
                                );
                            }
                            const status = seatStatus(s);
                            const toAct = v.to_act === i && v.in_hand;
                            const mine = i === v.viewer_seat;
                            const realName = nameOf(s.user_id);
                            const name = mine ? 'You' : realName;
                            return (
                                <li
                                    key={i}
                                    className={`gseat gseat-side-${spot.side}${mine ? ' gseat-me' : ''}${toAct ? ' gseat-turn' : ''}${s.status === 'folded' ? ' gseat-folded' : ''}${s.status === 'all_in' ? ' gseat-allin' : ''}${s.away ? ' gseat-away' : ''}`}
                                    style={style}
                                    aria-label={`${name}, ${chips(s.stack)} chips${s.street_commit > 0 ? `, ${chips(s.street_commit)} bet` : ''}${v.button === i ? ', dealer' : ''}${status ? `, ${status}` : ''}${toAct ? ', to act' : ''}`}
                                >
                                    <span className="gseat-top">
                                        <SeatAvatar name={realName} userId={s.user_id} fileId={avatarOf?.(s.user_id)} />
                                        <span className="gseat-name">{name}</span>
                                        {v.button === i && <span className="gbadge gbadge-dealer" title="Dealer button">D</span>}
                                        {v.in_hand && v.small_blind_seat === i && <span className="gbadge" title="Small blind">SB</span>}
                                        {v.in_hand && v.big_blind_seat === i && <span className="gbadge" title="Big blind">BB</span>}
                                    </span>
                                    <span className="gseat-mid">
                                        <span className="gseat-stack">{chips(s.stack)}</span>
                                        {s.cards && !mine && (
                                            <span className="gseat-cards">
                                                {s.cards.map((c, k) => <PlayingCard key={k} code={c} size="sm" muted={s.status === 'folded'} />)}
                                            </span>
                                        )}
                                    </span>
                                    {status && <span className={`gseat-status${s.status === 'all_in' ? ' gseat-status-allin' : ''}`}>{status}</span>}
                                    {toAct && <TurnClock ms={v.clock_ms} receivedAt={table.receivedAt} totalSecs={v.config.turn_clock_secs} compact />}
                                    {s.street_commit > 0 && (
                                        <span className="gseat-bet" aria-hidden="true">
                                            <span className="gchip" />
                                            {chips(s.street_commit)}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>

                {gate.canModerate && v.seats.some((s, i) => s && i !== v.viewer_seat) && (
                    <div className="games-actions-row games-mod-row" role="group" aria-label="Moderate the table">
                        {v.seats.map((s, i) => {
                            if (!s || i === v.viewer_seat) return null;
                            const name = nameOf(s.user_id);
                            return (
                                <button
                                    key={i}
                                    type="button"
                                    className="games-btn games-btn-ghost gseat-remove"
                                    onClick={() => {
                                        if (confirm(`Remove ${name} from the table? Their hand folds and they get up.`)) {
                                            send(gameFrames.removePlayer(room, id, i));
                                        }
                                    }}
                                >
                                    Remove {name}
                                </button>
                            );
                        })}
                    </div>
                )}

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
                                            onClick={() => setSheetFor(turnKey)}
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
                    onClose={() => setSheetFor(null)}
                />
            )}
        </div>
    );
}
