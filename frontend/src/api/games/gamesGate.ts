/**
 * Who sees what of the games (docs/GAMES.md, *Capability* and *Gating and
 * permissions*). One pure function so every surface — the VoiceStage header,
 * the VoicePanel's controls, the table view — asks the same question.
 *
 * A table is offered only when ALL of these hold:
 *   - this socket's server confirmed `games` (ServerFeatures; a reconnect can
 *     reach an older host, so it is per socket);
 *   - the voice channel's server has `games_enabled` (the owner's switch, off
 *     by default; absent on a server that predates games);
 *   - the person is in that call;
 *   - for OPENING and SITTING: `CONNECT` and `PLAY_GAMES` in that channel.
 *
 * Watching needs only the first three: GAMES.md, "PLAY_GAMES gates opening
 * and sitting, not watching" — a spectator sees the public table.
 *
 * The permission bits must be PRESENT for anything that acts. hasPerm()
 * fails open on a missing bitset (right for showing content on a pre-
 * permissions server), but every server that plays games sends
 * my_permissions, so a missing set here is a malformed row, not an old
 * server — offering a seat the server would refuse helps nobody.
 */
import { PERM, hasPerm } from '../permissionBits';

export interface GamesGateInput {
    /** This socket's server confirmed `games`. */
    feature: boolean;
    /** The voice channel's server's games_enabled (undefined: predates games). */
    gamesEnabled: boolean | undefined;
    /** The voice channel's my_permissions. */
    perms: number | null | undefined;
    /** The person is in the call (`voice_<id>` joined). */
    inCall: boolean;
    /** The call already has a table this client knows of. */
    hasTable: boolean;
}

export type GamesUnavailable = 'no_feature' | 'disabled' | 'not_in_call' | 'no_permission';

export interface GamesGate {
    /** Show the Games entry points at all. */
    available: boolean;
    /** May open a table (when the call has none). */
    canOpen: boolean;
    /** May take a seat. */
    canSit: boolean;
    /** May close the table / remove a player (MOVE_MEMBERS). */
    canModerate: boolean;
    /** Why `available`/`canOpen` is false, for the words on screen. */
    why: GamesUnavailable | null;
}

const has = (perms: number | null | undefined, bit: number) => perms !== null && perms !== undefined && hasPerm(perms, bit);

export function gamesGate(i: GamesGateInput): GamesGate {
    const off = (why: GamesUnavailable): GamesGate => ({ available: false, canOpen: false, canSit: false, canModerate: false, why });
    if (!i.feature) return off('no_feature');
    if (i.gamesEnabled !== true) return off('disabled');
    if (!i.inCall) return off('not_in_call');
    const play = has(i.perms, PERM.CONNECT) && has(i.perms, PERM.PLAY_GAMES);
    const canModerate = has(i.perms, PERM.MOVE_MEMBERS);
    // Without PLAY_GAMES there is still something to show when a table is
    // open (watching); with no table, there is nothing to offer.
    if (!play && !i.hasTable) return off('no_permission');
    return {
        available: true,
        canOpen: play && !i.hasTable,
        canSit: play,
        canModerate,
        why: play ? null : 'no_permission',
    };
}
