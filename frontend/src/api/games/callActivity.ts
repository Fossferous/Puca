/**
 * The call's activity as the CALL needs it (docs/GAMES.md, *Activities*): the
 * launcher's gate, the notice, the call-grid tile, the sidebar's playing marks.
 * Only who is seated, which game, and whether this client is in it - never the
 * pot, the turn or the cards.
 *
 * Why a slice: Chat is the whole app, and a hand of poker is a frame every
 * couple of seconds. Subscribed to the whole store, Chat (and the voice panel
 * under it) re-rendered for every bet, for everyone in the call, whether or not
 * they had the table open (the 2026-10-03 client review measured ~1.3 Chat
 * commits per game frame, 14 ms each in a dev build). `useCallActivity`
 * re-renders only when THIS slice changes: a sit or a stand, the table opening
 * or closing, a start announced, the socket's feature or call.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { GameKind } from './protocol';
import { getGamesState, subscribeGames, type GamesState } from './gamesStore';
import { seatedUserIds } from './activities';

export interface CallActivity {
    /** This socket's server confirmed `games`. */
    feature: boolean;
    /** This socket is in the call (`RoomJoined` for it). */
    inCall: boolean;
    /** The call's table, if it has one. */
    table: {
        table_id: number;
        kind: GameKind;
        /** User ids seated, in seat order. */
        seated: number[];
        /** This connection holds a seat. */
        viewerSeated: boolean;
    } | null;
    /** "<who> started <game>" for the call's table, until dismissed. */
    announce: { table_id: number; kind: GameKind; opened_by: number | null } | null;
    /** The server's last word for this call was that games are OFF (an
     *  ending or a refusal of `disabled`), for `gamesRowContradictedBy`. */
    saidDisabled: boolean;
}

/** The slice for `room` (Chat's voice call), or nothing when not in one. */
export function selectCallActivity(s: GamesState, room: string | null): CallActivity {
    const t = room && s.table && s.table.room_id === room ? s.table : null;
    const a = room && s.announce && s.announce.room_id === room ? s.announce : null;
    const n = room && s.notice && s.notice.room_id === room ? s.notice : null;
    return {
        feature: s.feature,
        inCall: !!room && s.joined === room,
        table: t ? {
            table_id: t.table_id,
            kind: t.view.game,
            seated: seatedUserIds(t.view),
            viewerSeated: t.view.viewer_seat !== null,
        } : null,
        announce: a ? { table_id: a.table_id, kind: a.kind, opened_by: a.opened_by } : null,
        saidDisabled: !!n && ((n.kind === 'ended' && n.reason === 'disabled') || (n.kind === 'refused' && n.refusal.code === 'disabled')),
    };
}

/**
 * The call's activity, re-rendering only when the slice changes. The snapshot
 * is the slice's JSON (a string compares by value, so an unchanged slice is
 * the same snapshot however often the store changes), parsed once per change.
 */
export function useCallActivity(room: string | null): CallActivity {
    const snapshot = () => JSON.stringify(selectCallActivity(getGamesState(), room));
    const key = useSyncExternalStore(subscribeGames, snapshot, snapshot);
    return useMemo(() => JSON.parse(key) as CallActivity, [key]);
}
