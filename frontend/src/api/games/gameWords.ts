/**
 * Every games code worded on the client (docs/GAMES.md: "No free text
 * anywhere: card codes, enum names and numbers. The client words every code
 * itself; nothing is rendered as HTML").
 */
import type { BlackjackEvent, CardCode, GameEndReason, GameKind, GameOp, GameRefusal, HandCategory, HoldemEvent } from './protocol';

export const GAME_NAMES: Record<GameKind, string> = { holdem: 'Poker', blackjack: 'Blackjack' };

/** The owner's disclosure, shown before a person's first GameSit. */
export const GAMES_DISCLOSURE = 'Chips are free and worth nothing. This server deals the cards and its operator could see them.';

/** What a refusal means, in words; `kind` is the table's game when known. */
export function refusalText(op: GameOp | 'other', r: GameRefusal, kind: GameKind | null): string {
    switch (r.code) {
        case 'disabled': return 'Games are switched off on this server.';
        case 'no_permission':
            return op === 'close' || op === 'remove_player'
                ? 'You need Move Members in this channel to do that.'
                : 'You don’t have permission to play games in this channel.';
        case 'not_in_call': return 'Join the call to play.';
        case 'not_a_voice_room': return 'Games are only played in a voice call.';
        case 'room_has_table': {
            const name = r.kind === 'holdem' ? 'Poker' : 'Blackjack';
            return `A ${name} table is already open in this call; it has to close before another game can start.`;
        }
        case 'too_many_tables': return 'This server has too many tables open right now. Try again later.';
        case 'rate_limited': return op === 'create' ? 'Too many tables opened just now. Wait a few minutes.' : 'Slow down a moment.';
        case 'wrong_game': return 'That isn’t part of this game.';
        case 'not_seated': return 'Take a seat first.';
        case 'invalid_config': return 'Those table settings aren’t allowed.';
        case 'config_locked': return 'The settings can’t change after the first hand.';
        case 'seat_out_of_range': return 'That seat doesn’t exist.';
        case 'seat_taken': return 'Someone just took that seat.';
        case 'seat_empty': return 'Nobody is in that seat.';
        case 'already_seated': return 'You already have a seat.';
        case 'not_your_turn': return 'It isn’t your turn.';
        case 'stale_turn': return 'That turn has passed.';
        case 'no_chips': return 'You have no chips left — rebuy to keep playing.';
        case 'not_busted': return 'You can rebuy only when you have no chips left.';
        case 'rebuy_not_allowed': return 'This table doesn’t allow rebuys.';
        case 'hand_in_progress': return 'Wait for this hand to finish.';
        case 'no_hand_in_progress': return 'No hand is being played.';
        case 'not_enough_players': return 'Waiting for another player.';
        case 'nothing_to_call': return 'There is nothing to call.';
        case 'raise_not_reopened': return 'The betting wasn’t reopened to you: call or fold.';
        case 'nobody_to_raise': return 'Everyone else is all-in: call or fold.';
        case 'not_showable': return 'Those cards can’t be shown now.';
        case 'round_in_progress': return 'Wait for this round to finish.';
        case 'no_round_in_progress': return 'No round is being played.';
        case 'no_bets': return 'Nobody has bet yet.';
        case 'sitting_out': return 'You’re sitting out — sit back in to bet.';
        case 'cannot_hit': return 'You can’t hit on that hand.';
        case 'cannot_double': return 'You can’t double on that hand.';
        case 'cannot_split': return 'You can’t split that hand.';
        case 'bet_below_minimum':
            return kind === 'blackjack' ? `The minimum bet is ${chips(r.min)}.` : `The smallest raise here is to ${chips(r.min)}.`;
        case 'cannot_check': return `You can’t check: ${chips(r.to_call)} to call.`;
        case 'bet_above_stack': return `You can put in at most ${chips(r.max)}.`;
        case 'bet_above_maximum': return `The maximum bet is ${chips(r.max)}.`;
        case 'insufficient_chips': return `You have ${chips(r.stack)} to bet with.`;
        case 'other': return 'The table refused that.';
    }
}

export function endText(reason: GameEndReason | 'other'): string {
    switch (reason) {
        case 'closed': return 'A moderator closed the table.';
        case 'call_ended': return 'The table closed when the call ended.';
        case 'idle': return 'The table closed because nobody was sitting at it.';
        case 'disabled': return 'The server owner switched games off.';
        case 'channel_deleted': return 'The voice channel was deleted.';
        case 'gone': return 'That table is no longer open.';
        case 'other': return 'The table closed.';
    }
}

/** 1,000 — chips are plain counts, never money (no currency sign, ever). */
export function chips(n: number): string {
    return n.toLocaleString('en-US');
}

const RANKS: Record<string, string> = {
    A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2',
};
const SUITS: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

/** "Ace of spades" — the accessible name of a card ("face-down card" for ??). */
export function cardName(code: CardCode): string {
    if (code === '??') return 'face-down card';
    return `${RANKS[code[0]] ?? code[0]} of ${SUITS[code[1]] ?? code[1]}`;
}

/** The rank as printed on a card face: A K Q J 10 9 … 2. */
export function rankLabel(code: CardCode): string {
    return code[0] === 'T' ? '10' : code[0];
}

export const CATEGORY_NAMES: Record<HandCategory, string> = {
    high_card: 'High card',
    one_pair: 'Pair',
    two_pair: 'Two pair',
    three_of_a_kind: 'Three of a kind',
    straight: 'Straight',
    flush: 'Flush',
    full_house: 'Full house',
    four_of_a_kind: 'Four of a kind',
    straight_flush: 'Straight flush',
};

/** The verb for a subject: "You fold" but "Ann folds". */
function says(who: string, third: string, second: string): string {
    return `${who} ${who === 'You' ? second : third}`;
}

/**
 * One line of "what happened" for an event, or null for one not worth a line
 * (each card dealt, the hand's end marker). `seatName` names whoever sits in
 * a seat now ("You" for the viewer); `userName` names a user id (sat / left
 * carry their own).
 */
export function eventLine(
    e: HoldemEvent | BlackjackEvent,
    game: GameKind,
    seatName: (seat: number) => string,
    userName: (userId: number) => string,
): string | null {
    switch (e.type) {
        case 'player_sat': return `${userName(e.user_id)} sat down with ${chips(e.stack)}.`;
        case 'player_left': return `${userName(e.user_id)} left the table.`;
        case 'sat_out': {
            const who = seatName(e.seat);
            return e.reason === 'timeouts' ? `${says(who, 'timed out and is', 'timed out and are')} sitting out.`
                : e.reason === 'busted' ? `${says(who, 'is', 'are')} out of chips.`
                : `${says(who, 'is', 'are')} sitting out.`;
        }
        case 'sat_in': return `${says(seatName(e.seat), 'is', 'are')} back in.`;
        case 'rebought': return `${seatName(e.seat)} took a fresh stack of ${chips(e.stack)}.`;
        case 'shoe_shuffled': return e.mid_round ? 'The discards were shuffled back into the shoe.' : 'The shoe was shuffled.';
        case 'round_started': return `Round ${e.round_no}.`;
        case 'bet_placed': return `${says(seatName(e.seat), 'bets', 'bet')} ${chips(e.amount)}.`;
        case 'bet_cleared': {
            const who = seatName(e.seat);
            return `${who} took back ${who === 'You' ? 'your' : 'their'} bet.`;
        }
        case 'card_dealt':
        case 'dealer_revealed':
        case 'hand_ended':
            return null;
        case 'dealer_peeked': return e.blackjack ? 'The dealer has blackjack.' : null;
        case 'hand_started': return `Hand ${e.hand_no}.`;
        case 'blind_posted': return `${says(seatName(e.seat), 'posts', 'post')} ${chips(e.amount)}${e.all_in ? ' (all-in)' : ''}.`;
        case 'board_dealt':
            return e.street === 'flop' ? 'The flop.' : e.street === 'turn' ? 'The turn.' : e.street === 'river' ? 'The river.' : null;
        case 'uncalled_returned': return `${chips(e.amount)} returned to ${seatName(e.seat)}.`;
        case 'showdown': {
            const shown = e.shown.map(h => `${says(seatName(h.seat), 'shows', 'show')} ${CATEGORY_NAMES[h.category].toLowerCase()}`);
            const mucked = e.mucked.map(s => says(seatName(s), 'mucks', 'muck'));
            return [...shown, ...mucked].join(', ') + '.';
        }
        case 'pot_awarded':
            return e.shares.map(s => `${says(seatName(s.seat), 'wins', 'win')} ${chips(s.amount)}`).join(', ') + '.';
        case 'shown': {
            const who = seatName(e.seat);
            return `${says(who, 'shows', 'show')} ${who === 'You' ? 'your' : 'their'} cards.`;
        }
        case 'hand_settled': {
            const who = seatName(e.seat);
            if (e.outcome === 'push') return `${says(who, 'pushes', 'push')}.`;
            if (e.outcome === 'lose') return `${says(who, 'loses', 'lose')} ${chips(e.bet)}.`;
            return `${says(who, 'wins', 'win')} ${chips(e.returned - e.bet)}${e.outcome === 'blackjack' ? ' with blackjack' : ''}.`;
        }
        case 'round_ended': return e.dealer_bust ? 'The dealer busts.' : `The dealer has ${e.dealer_total}.`;
        case 'acted': {
            const who = seatName(e.seat);
            const timedOut = e.reason === 'timeout';
            const lead = timedOut ? `${who} timed out and` : who;
            // After "timed out and", the verb takes the bare form for anyone.
            const verb = (third: string, base: string) => (timedOut || who === 'You' ? base : third);
            if (game === 'blackjack' && 'action' in e) {
                const forms = { hit: ['hits', 'hit'], stand: ['stands', 'stand'], double: ['doubles', 'double'], split: ['splits', 'split'] }[e.action];
                return `${lead} ${verb(forms[0], forms[1])}.`;
            }
            if (!('kind' in e)) return null;
            const tail = e.all_in ? ' (all-in)' : '';
            switch (e.kind) {
                case 'fold': return `${lead} ${verb('folds', 'fold')}.`;
                case 'check': return `${lead} ${verb('checks', 'check')}.`;
                case 'call': return `${lead} ${verb('calls', 'call')} ${chips(e.added)}${tail}.`;
                case 'bet': return `${lead} ${verb('bets', 'bet')} ${chips(e.street_commit)}${tail}.`;
                case 'raise': return `${lead} ${verb('raises', 'raise')} to ${chips(e.street_commit)}${tail}.`;
            }
        }
    }
    return null;
}
