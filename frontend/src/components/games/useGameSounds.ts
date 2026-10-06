import { useEffect, useRef } from 'react';
import type { HeldTable } from '../../api/games/gamesStore';
import { blackjackTimeline, holdemTimeline, type GameTimeline, type TimedCue } from '../../api/games/gameTimeline';
import type { BlackjackEvent, GameView, HoldemEvent } from '../../api/games/protocol';
import { playGameCues } from '../../api/games/gameSounds';

/** The decision this viewer is being asked for, or '' (for the turn chime).
 *  Hold'em: every decision is a new turn. Blackjack: a hand of yours coming
 *  up is - each hit on it is not (the turn sequence moves on every card). */
export function myTurnKey(v: GameView): string {
    if (!v.legal || !v.turn || v.viewer_seat === null) return '';
    if (v.game === 'holdem') return v.to_act === v.viewer_seat ? `${v.turn.hand_no}:${v.turn.turn_seq}` : '';
    return v.to_act?.seat === v.viewer_seat ? `${v.turn.hand_no}:hand${v.to_act.hand}` : '';
}

/** One table frame's timeline (the same one the board's flips read). */
export function timelineOf(table: HeldTable): GameTimeline {
    const v = table.view;
    return v.game === 'holdem'
        ? holdemTimeline(table.events as HoldemEvent[], v.viewer_seat)
        : blackjackTimeline(table.events as BlackjackEvent[], v.viewer_seat);
}

/**
 * Plays the table's sounds while the table is on screen: each NEW frame's
 * events (never the ones that were already there when the table opened, nor
 * a frame seen again), and a chime when a new decision becomes yours. A frame
 * that arrived after a gap carries no events, so it makes no sound but the
 * chime. Whether anything is audible is gameSounds.ts's call (the setting,
 * deafen, the volume).
 */
export function useGameSounds(table: HeldTable): void {
    const seen = useRef<{ id: number; eventsVersion: number; turn: string } | null>(null);
    useEffect(() => {
        const turn = myTurnKey(table.view);
        const prev = seen.current;
        seen.current = { id: table.table_id, eventsVersion: table.eventsVersion, turn };
        // First sight of this table: what is already on it is not news.
        if (!prev || prev.id !== table.table_id) return;
        const cues: TimedCue[] = [];
        if (table.eventsVersion > prev.eventsVersion && table.events.length > 0) cues.push(...timelineOf(table).cues);
        if (turn && turn !== prev.turn) {
            const after = cues.length ? cues[cues.length - 1].at + 0.2 : 0;
            cues.push({ cue: 'turn', at: after });
        }
        if (cues.length) playGameCues(cues);
    }, [table]);
}
