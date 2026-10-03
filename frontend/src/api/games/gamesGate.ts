/**
 * Who sees what of the games (docs/GAMES.md, *Capability* and *Gating and
 * permissions*). One pure function so every surface — the VoiceStage header,
 * the VoicePanel's controls, the table view — asks the same question.
 *
 * A table is offered only when ALL of these hold:
 *   - this socket's server confirmed `games` (ServerFeatures; a reconnect can
 *     reach an older host, so it is per socket);
 *   - the voice channel's server has `games_enabled` (the owner's switch, off
 *     by default; absent on a server that predates games) — or the server
 *     has already sent a table for this call, which outranks a stale row;
 *   - the person is in that call;
 *   - for OPENING and SITTING: `CONNECT` and `PLAY_GAMES` in that channel.
 *
 * Watching needs only the first three: GAMES.md, "PLAY_GAMES gates opening
 * and sitting, not watching" — a spectator sees the public table.
 *
 * The LAUNCHER (the Activities button in the call's controls, docs/GAMES.md
 * *Activities*) is for someone who may PLAY here: with no table it starts
 * one, with a table it offers Join. Someone who may only watch reaches a
 * running table through its tile and the notice, never the launcher.
 *
 * The permission bits must be PRESENT for anything that acts. hasPerm()
 * fails open on a missing bitset (right for showing content on a pre-
 * permissions server), but every server that plays games sends
 * my_permissions, so a missing set here is a malformed row, not an old
 * server — offering a seat the server would refuse helps nobody.
 */
import { PERM, hasPerm } from '../permissionBits';
import type { GamesNotice } from './gamesStore';

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
    /** Show the Games entry points at all (the table's tile, the notice). */
    available: boolean;
    /** Show the Activities launcher: in the call, games on, may play here. */
    launcher: boolean;
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
    const off = (why: GamesUnavailable): GamesGate => ({ available: false, launcher: false, canOpen: false, canSit: false, canModerate: false, why });
    if (!i.feature) return off('no_feature');
    // The server row is fetched once and nothing pushes a change to it, so a
    // person online when the owner switched games on still holds `false`. A
    // table the server sent for this call is its own word that the call plays
    // games (switching games off ends every table), so it wins over the row.
    // With no table the row still decides: there is nothing to open on a
    // server whose owner has games off.
    if (i.gamesEnabled !== true && !i.hasTable) return off('disabled');
    if (!i.inCall) return off('not_in_call');
    const play = has(i.perms, PERM.CONNECT) && has(i.perms, PERM.PLAY_GAMES);
    const canModerate = has(i.perms, PERM.MOVE_MEMBERS);
    // Without PLAY_GAMES there is still something to show when a table is
    // open (watching); with no table, there is nothing to offer.
    if (!play && !i.hasTable) return off('no_permission');
    return {
        available: true,
        launcher: play,
        canOpen: play && !i.hasTable,
        canSit: play,
        canModerate,
        why: play ? null : 'no_permission',
    };
}

/**
 * Whether the server's own games frames contradict the cached server row's
 * `games_enabled` for the call on screen. Nothing pushes a changed server row
 * (the owner's save refreshes only the owner's copy), so a member online when
 * games were switched ON holds `false`, and one online when they were switched
 * OFF holds `true` and is still offered "Open a table". The frames are the
 * server's word:
 *   - a table in this call means games are on here;
 *   - an ending or a refusal with `disabled` means they are off.
 * Chat refetches the server rows when this is true. The gate itself already
 * lets a table outrank a stale `false` (above), so this only has to bring the
 * row back in line for what comes after the table.
 */
export function gamesRowContradicted(
    gamesEnabled: boolean | undefined,
    s: { table: { room_id: string } | null; notice: GamesNotice | null },
    room: string | null,
): boolean {
    if (!room) return false;
    if (s.table && s.table.room_id === room && gamesEnabled !== true) return true;
    const n = s.notice;
    if (!n || n.room_id !== room || gamesEnabled !== true) return false;
    return (n.kind === 'ended' && n.reason === 'disabled') || (n.kind === 'refused' && n.refusal.code === 'disabled');
}
