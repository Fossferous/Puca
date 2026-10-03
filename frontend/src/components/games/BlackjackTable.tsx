import { useState } from 'react';
import { gameFrames, type BlackjackHand, type BlackjackView, type GameClientFrame } from '../../api/games/protocol';
import type { HeldTable } from '../../api/games/gamesStore';
import type { GamesGate } from '../../api/games/gamesGate';
import { betPresets, betRange, blackjackBusted, blackjackMyTurn, clampBet } from '../../api/games/blackjackActions';
import { chips, eventLine } from '../../api/games/gameWords';
import { PlayingCard } from './PlayingCard';
import { AmountSheet, SeatAvatar, Stepper, TurnClock } from './GameBits';
import { useCountdown } from './useCountdown';

interface BlackjackTableProps {
    table: HeldTable & { view: BlackjackView };
    gate: GamesGate;
    isPhone: boolean;
    nameOf: (userId: number) => string;
    currentUserId: number;
    onSit: (seat: number) => void;
    send: (frame: GameClientFrame) => void;
    refusedAt: number | null;
}

const OUTCOME: Record<string, string> = { blackjack: 'Blackjack', win: 'Win', push: 'Push', lose: 'Lose' };

function handTotal(h: BlackjackHand): string {
    if (h.cards.length === 0) return '';
    return h.soft && h.total <= 21 ? `soft ${h.total}` : String(h.total);
}

function HandView({ hand, size, active }: { hand: BlackjackHand; size: 'sm' | 'lg'; active: boolean }) {
    const bust = hand.total > 21;
    return (
        <span className={`bj-hand${active ? ' bj-hand-active' : ''}${hand.outcome ? ` bj-hand-${hand.outcome}` : ''}`}>
            <span className="bj-hand-cards">
                {hand.cards.map((c, k) => <PlayingCard key={k} code={c} size={size} muted={bust || hand.outcome === 'lose'} />)}
            </span>
            <span className="bj-hand-meta">
                <span className="bj-hand-total">{bust ? `Bust ${hand.total}` : handTotal(hand)}</span>
                <span className="bj-hand-bet">Bet {chips(hand.bet)}{hand.doubled ? ' (doubled)' : ''}</span>
                {hand.outcome && (
                    <span className="bj-hand-outcome">
                        {OUTCOME[hand.outcome]}{hand.returned !== null && hand.outcome !== 'lose' ? ` +${chips(hand.returned - hand.bet)}` : ''}
                    </span>
                )}
            </span>
        </span>
    );
}

/**
 * The Blackjack table: the house against everyone seated. Bets go between
 * rounds; the round deals when every seated player has bet (or 15 s after
 * the first bet — the server's timer). The dealer's hole card is '??' until
 * the server turns it.
 */
export function BlackjackTable({ table, gate, isPhone, nameOf, currentUserId, onSit, send, refusedAt }: BlackjackTableProps) {
    const v = table.view;
    const room = table.room_id;
    const id = table.table_id;
    const me = v.viewer_seat === null ? null : v.seats[v.viewer_seat];
    const myTurn = blackjackMyTurn(v);
    const range = betRange(v);
    const presets = betPresets(v);
    const busted = blackjackBusted(v);
    const turnKey = v.turn ? `${v.turn.hand_no}:${v.turn.turn_seq}` : '';

    // `text`: what is being typed into the desktop field, clamped when used
    // (see HoldemTable's raise).
    const [bet, setBet] = useState<{ round: number; amount: number; text?: string } | null>(null);
    const [sent, setSent] = useState<{ key: string; at: number } | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);

    const betAmount = bet && bet.round === v.round_no ? clampBet(bet.amount, range) : clampBet(me?.pending_bet || range.min, range);
    const busy = !!sent && sent.key === turnKey && !(refusedAt !== null && refusedAt > sent.at);
    const betText = bet && bet.round === v.round_no && bet.text !== undefined ? bet.text : String(betAmount);

    const act = (type: 'hit' | 'stand' | 'double' | 'split') => {
        if (!v.turn || busy) return;
        setSent({ key: turnKey, at: Date.now() });
        send(gameFrames.act(room, id, v.turn, { type }));
    };
    const placeBet = (amount: number) => {
        setSheetOpen(false);
        send(gameFrames.bet(room, id, clampBet(amount, range)));
    };

    const nextDeal = useCountdown(v.in_round ? null : v.next_deal_in_ms, table.receivedAt);
    const seatName = (seat: number) => {
        const s = v.seats[seat];
        if (!s) return `Seat ${seat + 1}`;
        return s.user_id === currentUserId ? 'You' : nameOf(s.user_id);
    };
    const userName = (uid: number) => (uid === currentUserId ? 'You' : nameOf(uid));
    const lines = table.log
        .map(e => eventLine(e, 'blackjack', seatName, userName))
        .filter((l): l is string => !!l)
        .slice(isPhone ? -2 : -5);

    // Players first, then the open seats (see HoldemTable's stripOrder).
    const others = [...v.seats.keys()].filter(i => i !== v.viewer_seat).sort((x, y) => Number(!v.seats[x]) - Number(!v.seats[y]));
    const dealerLine = v.dealer_total !== null ? `Dealer ${v.dealer_total > 21 ? `busts ${v.dealer_total}` : v.dealer_total}` : 'Dealer';
    const status = v.in_round
        ? (myTurn ? null : v.to_act ? `${seatName(v.to_act.seat)} to act` : 'Dealer’s turn')
        : nextDeal !== null ? `Dealing in ${Math.ceil(nextDeal / 1000)}s` : 'Place your bets';

    return (
        <div className="gtable gtable-blackjack">
            <div className="games-scroll">
                <div className="bj-dealer" aria-label="Dealer">
                    <span className="bj-dealer-label">{dealerLine}</span>
                    <span className="bj-hand-cards">
                        {v.dealer.length ? v.dealer.map((c, k) => <PlayingCard key={k} code={c} size="md" />) : null}
                    </span>
                    <span className="gcentre-line">{status}{v.reshuffle_due ? ' · shuffle after this round' : ''}</span>
                </div>

                <div className="games-opps" role="list" aria-label="Players">
                    {others.map(i => {
                        const s = v.seats[i];
                        if (!s) {
                            return (
                                <div key={i} role="listitem" className="gseat gseat-empty">
                                    <span className="gseat-name">Seat {i + 1}</span>
                                    {gate.canSit && v.viewer_seat === null ? (
                                        <button type="button" className="games-btn games-btn-primary gseat-sit" onClick={() => onSit(i)}>Sit here</button>
                                    ) : (
                                        <span className="gseat-meta">Open</span>
                                    )}
                                </div>
                            );
                        }
                        const name = nameOf(s.user_id);
                        const toAct = v.to_act?.seat === i;
                        return (
                            <div key={i} role="listitem" className={`gseat${toAct ? ' gseat-turn' : ''}${s.away ? ' gseat-away' : ''}`}>
                                <span className="gseat-top">
                                    <SeatAvatar name={name} />
                                    <span className="gseat-name">{name}</span>
                                </span>
                                <span className="gseat-mid">
                                    <span className="gseat-stack">{chips(s.stack)}</span>
                                    {s.pending_bet > 0 && <span className="gseat-commit">{chips(s.pending_bet)}</span>}
                                </span>
                                {s.hands.map((h, k) => (
                                    <HandView key={k} hand={h} size="sm" active={toAct && v.to_act?.hand === k} />
                                ))}
                                {(s.away || s.sitting_out || s.leaving) && (
                                    <span className="gseat-status">{s.away ? 'Away' : s.leaving ? 'Leaving' : 'Sitting out'}</span>
                                )}
                                {toAct && <TurnClock ms={v.clock_ms} receivedAt={table.receivedAt} totalSecs={v.config.turn_clock_secs} compact />}
                                {gate.canModerate && (
                                    <button
                                        type="button"
                                        className="games-btn games-btn-ghost gseat-remove"
                                        onClick={() => {
                                            if (confirm(`Remove ${name} from the table?`)) send(gameFrames.removePlayer(room, id, i));
                                        }}
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>

                {me && !myTurn && (
                    <div className="games-actions-row games-seat-row">
                        {busted && v.config.allow_rebuy && (
                            <button type="button" className="games-btn games-btn-primary" onClick={() => send(gameFrames.rebuy(room, id))}>
                                Rebuy {chips(v.config.starting_stack)}
                            </button>
                        )}
                        {me.sitting_out ? (
                            <button type="button" className="games-btn" onClick={() => send(gameFrames.sitIn(room, id))}>Sit back in</button>
                        ) : !v.in_round && (
                            <button type="button" className="games-btn games-btn-ghost" onClick={() => send(gameFrames.sitOut(room, id))}>Sit out</button>
                        )}
                        <button
                            type="button"
                            className="games-btn games-btn-ghost"
                            onClick={() => {
                                if (!v.in_round || me.hands.length === 0 || confirm('Stand up now? Your hands stand and settle with this round.')) send(gameFrames.stand(room, id));
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
                    <p className="games-phone-note">If you switch away from Púca, your turn still runs out and your hand stands.</p>
                )}
            </div>

            <div className="games-footer">
                <div className={`games-me bj-me${myTurn ? ' games-me-turn' : ''}`}>
                    {me ? (
                        <>
                            <span className="bj-me-hands">
                                {me.hands.length
                                    ? me.hands.map((h, k) => <HandView key={k} hand={h} size="lg" active={!!myTurn && myTurn.hand === k} />)
                                    : <span className="games-watch">{me.pending_bet > 0 ? `Your bet: ${chips(me.pending_bet)}` : 'No bet yet'}</span>}
                            </span>
                            <span className="games-me-info">
                                <span className="games-me-stack">{chips(me.stack)} chips</span>
                                {me.sitting_out && <span className="gseat-status">Sitting out</span>}
                                {myTurn && (
                                    <span className="games-me-turnline">
                                        Your turn{me.hands.length > 1 ? ` (hand ${myTurn.hand + 1})` : ''} <TurnClock ms={v.clock_ms} receivedAt={table.receivedAt} totalSecs={v.config.turn_clock_secs} />
                                    </span>
                                )}
                            </span>
                        </>
                    ) : (
                        <span className="games-watch">
                            {gate.canSit ? 'You are watching. Pick an open seat to play.' : 'You are watching this table.'}
                        </span>
                    )}
                </div>
                {myTurn && v.legal ? (
                    <div className="games-actions" aria-label="Your action">
                        <div className="games-actions-row">
                            <button type="button" className="games-btn games-btn-primary" disabled={busy || !v.legal.can_hit} onClick={() => act('hit')}>Hit</button>
                            <button type="button" className="games-btn" disabled={busy || !v.legal.can_stand} onClick={() => act('stand')}>Stand</button>
                        </div>
                        <div className="games-actions-row games-actions-row2">
                            <button type="button" className="games-btn" disabled={busy || !v.legal.can_double} onClick={() => act('double')}>Double</button>
                            <button type="button" className="games-btn" disabled={busy || !v.legal.can_split} onClick={() => act('split')}>Split</button>
                        </div>
                    </div>
                ) : me && range.open ? (
                    <div className="games-actions" aria-label="Your bet">
                        <div className="games-actions-row">
                            <button type="button" className="games-btn games-btn-primary" onClick={() => placeBet(betAmount)}>
                                {me.pending_bet > 0 ? `Change bet to ${chips(betAmount)}` : `Bet ${chips(betAmount)}`}
                            </button>
                            {me.pending_bet > 0 && (
                                <button type="button" className="games-btn games-btn-ghost" onClick={() => send(gameFrames.clearBet(room, id))}>Clear bet</button>
                            )}
                        </div>
                        <div className="games-actions-row games-actions-row2">
                            {presets.map(p => (
                                <button
                                    key={p}
                                    type="button"
                                    className={`games-btn games-btn-ghost gpreset${p === betAmount ? ' gpreset-on' : ''}`}
                                    onClick={() => setBet({ round: v.round_no, amount: p })}
                                >
                                    {chips(p)}
                                </button>
                            ))}
                            <Stepper
                                label="bet"
                                onDown={() => setBet({ round: v.round_no, amount: clampBet(betAmount - range.min, range) })}
                                onUp={() => setBet({ round: v.round_no, amount: clampBet(betAmount + range.min, range) })}
                                downDisabled={betAmount <= range.min}
                                upDisabled={betAmount >= range.max}
                            >
                                {isPhone ? (
                                    <button type="button" className="games-btn games-amount-btn" onClick={() => setSheetOpen(true)} aria-label={`Bet amount ${chips(betAmount)}, tap to type it`}>
                                        {chips(betAmount)}
                                    </button>
                                ) : (
                                    <input
                                        className="games-amount-input"
                                        type="number"
                                        inputMode="numeric"
                                        min={range.min}
                                        max={range.max}
                                        step={range.min}
                                        value={betText}
                                        aria-label="Bet"
                                        onChange={e => setBet({ round: v.round_no, amount: Number(e.target.value), text: e.target.value })}
                                        onBlur={() => setBet({ round: v.round_no, amount: betAmount })}
                                        onKeyDown={e => { if (e.key === 'Enter') placeBet(betAmount); }}
                                    />
                                )}
                            </Stepper>
                        </div>
                    </div>
                ) : null}
            </div>

            {sheetOpen && range.open && (
                <AmountSheet
                    title="Bet"
                    value={betAmount}
                    min={range.min}
                    max={range.max}
                    step={range.min}
                    presets={presets.map(p => ({ label: chips(p), amount: p }))}
                    confirmLabel={(a) => `Bet ${chips(a)}`}
                    onConfirm={placeBet}
                    onClose={() => setSheetOpen(false)}
                />
            )}
        </div>
    );
}
