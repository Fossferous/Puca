import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useGames } from '../../api/games/useGames';
import { clearGamesNotice, sendGame } from '../../api/games/gamesStore';
import type { GamesGate } from '../../api/games/gamesGate';
import { GAME_NAMES, GAMES_DISCLOSURE, chips, endText, refusalText } from '../../api/games/gameWords';
import { disclosureSeen, markDisclosureSeen } from '../../api/games/gamesDisclosure';
import { configFor, defaultForm, formProblem, type OpenTableForm } from '../../api/games/openTableConfig';
import { gameFrames, type BlackjackView, type GameClientFrame, type GameKind, type HoldemView } from '../../api/games/protocol';
import type { HeldTable } from '../../api/games/gamesStore';
import { ArrowLeftIcon, CardsIcon, CloseIcon, InfoIcon, WarningIcon } from '../Icons';
import { HoldemTable } from './HoldemTable';
import { BlackjackTable } from './BlackjackTable';
import './PlayingCard.css';
import './GamesView.css';

interface GamesViewProps {
    /** The call: `voice_<channel_id>`. */
    roomId: string;
    /** The voice channel's server (the disclosure is remembered per server). */
    serverId: string;
    channelName: string;
    currentUserId: number;
    /** userId -> the name to show (server nickname / display name). */
    memberNames: Map<number, string>;
    gate: GamesGate;
    /** The JS half of the coarse-pointer gate (DESIGN_PHILOSOPHY §2). */
    isPhone: boolean;
    /** Back to the call's stage. Never touches the call itself. */
    onBack: () => void;
}

function NumberField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (n: number) => void }) {
    return (
        <label className="games-field" htmlFor={id}>
            <span>{label}</span>
            <input
                id={id}
                className="games-amount-input"
                type="number"
                inputMode="numeric"
                min={1}
                value={Number.isFinite(value) ? value : ''}
                onChange={e => onChange(e.target.value === '' ? NaN : Math.floor(Number(e.target.value)))}
            />
        </label>
    );
}

/** "Open a table": pick the game, then (before the first hand, the only time
 *  they can be set) the stack and stakes. */
function OpenTablePanel({ busy, onOpen }: { busy: boolean; onOpen: (kind: GameKind, f: OpenTableForm) => void }) {
    const [kind, setKind] = useState<GameKind>('holdem');
    const [form, setForm] = useState<OpenTableForm>(defaultForm);
    const problem = formProblem(kind, form);
    const set = (k: keyof OpenTableForm) => (n: number) => setForm(f => ({ ...f, [k]: n }));
    return (
        <div className="games-open">
            <h3 className="games-open-title">Open a table in this call</h3>
            <div className="games-open-kinds" role="radiogroup" aria-label="Game">
                {(['holdem', 'blackjack'] as const).map(k => (
                    <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={kind === k}
                        className={`games-kind${kind === k ? ' games-kind-on' : ''}`}
                        onClick={() => setKind(k)}
                    >
                        <strong>{GAME_NAMES[k]}</strong>
                        <span>{k === 'holdem' ? 'No-limit Texas Hold’em, up to 6 players' : 'Against the house: 6 decks, dealer stands on soft 17, blackjack pays 3:2'}</span>
                    </button>
                ))}
            </div>
            <div className="games-open-fields">
                <NumberField id="games-stack" label="Starting chips" value={form.starting_stack} onChange={set('starting_stack')} />
                {kind === 'holdem' ? (
                    <>
                        <NumberField id="games-sb" label="Small blind" value={form.small_blind} onChange={set('small_blind')} />
                        <NumberField id="games-bb" label="Big blind" value={form.big_blind} onChange={set('big_blind')} />
                    </>
                ) : (
                    <>
                        <NumberField id="games-minbet" label="Minimum bet" value={form.min_bet} onChange={set('min_bet')} />
                        <NumberField id="games-maxbet" label="Maximum bet" value={form.max_bet} onChange={set('max_bet')} />
                    </>
                )}
            </div>
            <p className="games-help">
                Everyone who sits down gets the same free chips. They are worth nothing and disappear when the table closes.
                These settings are fixed once the table opens.
            </p>
            {problem && <p className="games-problem" role="alert"><WarningIcon size={14} /> {problem}</p>}
            <button
                type="button"
                className="games-btn games-btn-primary games-open-go"
                disabled={!!problem || busy}
                onClick={() => onOpen(kind, form)}
            >
                {busy ? 'Opening…' : `Open a ${GAME_NAMES[kind]} table`}
            </button>
        </div>
    );
}

/**
 * The card table in the main area (`viewMode: 'table'`), next to VoiceStage
 * inside .chat-main. Like VoiceStage it is presentation only: mounting or
 * leaving it never touches the call. The table itself lives in the games
 * store (api/games/gamesStore.ts), so closing this view loses nothing.
 */
export function GamesView({ roomId, serverId, channelName, currentUserId, memberNames, gate, isPhone, onBack }: GamesViewProps) {
    const g = useGames();
    const table = g.table && g.table.room_id === roomId ? g.table : null;
    const notice = g.notice && g.notice.room_id === roomId ? g.notice : null;
    const [createdAt, setCreatedAt] = useState<number | null>(null);
    const [pendingSit, setPendingSit] = useState<number | null>(null);
    const [offline, setOffline] = useState(false);

    const send = (frame: GameClientFrame) => {
        const ok = sendGame(frame);
        setOffline(!ok);
        return ok;
    };
    const nameOf = (uid: number) => memberNames.get(uid) ?? `Player ${uid}`;
    const sit = (seat: number) => {
        if (!table) return;
        if (!disclosureSeen(currentUserId, serverId)) { setPendingSit(seat); return; }
        send(gameFrames.sit(roomId, table.table_id, seat));
    };
    const refusedAt = g.lastRefusalAt;
    // "Opening…" until the table (or a refusal of the create) arrives. A table
    // that arrived and has since ended answered it too: without that the
    // opener's button stayed "Opening…" after their table closed.
    const creating = createdAt !== null && !table
        && !((g.lastRefusalAt ?? 0) >= createdAt)
        && !((g.lastTableAt ?? 0) >= createdAt);

    const kind: GameKind | null = table ? table.view.game : null;
    const stakes = !table ? null
        : table.view.game === 'holdem'
            ? `Blinds ${chips(table.view.config.small_blind)}/${chips(table.view.config.big_blind)}`
            : `Bets ${chips(table.view.config.min_bet)}–${chips(table.view.config.max_bet)}`;

    return (
        <div className={`games-view${isPhone ? ' games-view-phone' : ''}`} data-game={kind ?? 'none'}>
            <div className="games-header">
                <div className="games-title">
                    <span className="games-title-icon"><CardsIcon /></span>
                    <span className="games-title-name">{kind ? GAME_NAMES[kind] : 'Games'}</span>
                    <span className="games-title-meta">{stakes ? `${stakes} · ` : ''}{channelName}</span>
                </div>
                <div className="games-header-controls">
                    {table && gate.canModerate && (
                        <button
                            type="button"
                            className="games-btn games-btn-ghost games-header-btn"
                            onClick={() => {
                                if (confirm('Close this table for everyone? Every hand in play ends and all chips are gone.')) {
                                    send(gameFrames.close(roomId, table.table_id));
                                }
                            }}
                        >
                            Close table
                        </button>
                    )}
                    <button type="button" className="games-btn games-btn-ghost games-header-btn" onClick={onBack} aria-label="Back to the call">
                        <ArrowLeftIcon /> {isPhone ? 'Call' : 'Back to the call'}
                    </button>
                </div>
            </div>

            {(notice || offline) && (
                <div className={`games-notice${notice?.kind === 'ended' ? ' games-notice-ended' : ''}`} role="status">
                    <span className="games-notice-icon"><InfoIcon /></span>
                    <span className="games-notice-text">
                        {offline && !notice
                            ? 'Not connected — that didn’t reach the table. Try again in a moment.'
                            : notice!.kind === 'ended'
                                ? endText(notice!.reason)
                                : refusalText(notice!.op, notice!.refusal, kind)}
                    </span>
                    <button
                        type="button"
                        className="games-btn games-btn-ghost games-notice-close"
                        aria-label="Dismiss"
                        onClick={() => { clearGamesNotice(); setOffline(false); }}
                    >
                        <CloseIcon />
                    </button>
                </div>
            )}

            {table && table.view.game === 'holdem' ? (
                <HoldemTable
                    table={table as HeldTable & { view: HoldemView }}
                    gate={gate}
                    isPhone={isPhone}
                    nameOf={nameOf}
                    currentUserId={currentUserId}
                    onSit={sit}
                    send={send}
                    refusedAt={refusedAt}
                />
            ) : table && table.view.game === 'blackjack' ? (
                <BlackjackTable
                    table={table as HeldTable & { view: BlackjackView }}
                    gate={gate}
                    isPhone={isPhone}
                    nameOf={nameOf}
                    currentUserId={currentUserId}
                    onSit={sit}
                    send={send}
                    refusedAt={refusedAt}
                />
            ) : (
                <div className="games-scroll games-empty">
                    {gate.canOpen ? (
                        <OpenTablePanel
                            busy={creating}
                            onOpen={(k, f) => {
                                if (send(gameFrames.create(roomId, k, configFor(k, f)))) {
                                    clearGamesNotice();
                                    setCreatedAt(Date.now());
                                }
                            }}
                        />
                    ) : (
                        <p className="games-watch">No table is open in this call.</p>
                    )}
                </div>
            )}

            {pendingSit !== null && table && createPortal(
                <div className="games-sheet-scrim games-disclosure-scrim" onClick={() => setPendingSit(null)}>
                    <div
                        className="games-disclosure"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="games-disclosure-title"
                        onClick={e => e.stopPropagation()}
                    >
                        <h3 id="games-disclosure-title">Before you sit down</h3>
                        <p>{GAMES_DISCLOSURE}</p>
                        <div className="games-sheet-actions">
                            <button type="button" className="games-btn games-btn-ghost" onClick={() => setPendingSit(null)}>Cancel</button>
                            <button
                                type="button"
                                className="games-btn games-btn-primary"
                                autoFocus
                                onClick={() => {
                                    markDisclosureSeen(currentUserId, serverId);
                                    send(gameFrames.sit(roomId, table.table_id, pendingSit));
                                    setPendingSit(null);
                                }}
                            >
                                Sit down
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
