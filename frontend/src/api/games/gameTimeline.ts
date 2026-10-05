/**
 * One frame of game events as a short timeline: which sounds to play and
 * when, and when each newly dealt board card turns face up. The table's flip
 * animation and the sounds read the SAME timeline, so a card is heard the
 * moment it is seen to turn.
 *
 * Only events the server sent are read: a card is in `reveals` because a
 * `board_dealt` named it. Nothing here can know a card early - the face-down
 * board slots the table draws before then are placeholders with no card in
 * them at all.
 */
import type { BlackjackEvent, HoldemEvent } from './protocol';

export type GameCue = 'deal' | 'flip' | 'chips' | 'check' | 'fold' | 'win' | 'turn';

export interface TimedCue {
    cue: GameCue;
    /** Seconds after the frame arrived. */
    at: number;
}

export interface GameTimeline {
    cues: TimedCue[];
    /** Board card code -> seconds after the frame arrived when it turns. */
    reveals: Record<string, number>;
}

/** Between two sounds that follow each other in a frame. */
const STEP = 0.14;
/** Between two cards of one street turning. */
const FLIP_STEP = 0.18;
/** Extra pause between streets when the board runs out in one frame. */
const STREET_GAP = 0.45;
/** The most sounds one frame may make (a run-out is busy enough). */
const MAX_CUES = 10;
const MAX_DEAL_SOUNDS_HOLDEM = 4;
const MAX_DEAL_SOUNDS_BLACKJACK = 6;

class Builder {
    cues: TimedCue[] = [];
    reveals: Record<string, number> = {};
    t = 0;
    private streets = 0;

    /** A sound now, then move on. The same chips/check sound twice in a row
     *  (two blinds posted) is one sound. */
    add(cue: GameCue, coalesce = cue === 'chips') {
        const last = this.cues[this.cues.length - 1];
        if (coalesce && last && last.cue === cue) return;
        this.cues.push({ cue, at: round(this.t) });
        this.t += STEP;
    }

    /** Board cards turning, one after another; a later street waits a beat. */
    flipBoard(cards: string[]) {
        if (this.streets > 0) this.t += STREET_GAP;
        this.streets++;
        cards.forEach((code, i) => {
            const at = round(this.t + i * FLIP_STEP);
            this.reveals[code] = at;
            this.cues.push({ cue: 'flip', at });
        });
        this.t += cards.length * FLIP_STEP;
    }

    done(): GameTimeline {
        return { cues: this.cues.slice(0, MAX_CUES), reveals: this.reveals };
    }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function holdemTimeline(events: HoldemEvent[], viewerSeat: number | null): GameTimeline {
    const b = new Builder();
    let settled = false;
    for (const e of events) {
        switch (e.type) {
            case 'hand_started':
                for (let i = 0; i < Math.min(e.dealt.length, MAX_DEAL_SOUNDS_HOLDEM); i++) b.add('deal', false);
                break;
            case 'blind_posted':
                b.add('chips');
                break;
            case 'acted':
                b.add(e.kind === 'fold' ? 'fold' : e.kind === 'check' ? 'check' : 'chips', false);
                break;
            case 'board_dealt':
                b.flipBoard(e.cards);
                break;
            case 'showdown':
            case 'shown':
                b.add('flip', false);
                break;
            case 'pot_awarded': {
                // One sound for the whole settlement, however many pots.
                if (settled) break;
                settled = true;
                const won = viewerSeat !== null && events.some(x => x.type === 'pot_awarded' && x.shares.some(s => s.seat === viewerSeat));
                b.add(won ? 'win' : 'chips', false);
                break;
            }
            default:
                break;
        }
    }
    return b.done();
}

export function blackjackTimeline(events: BlackjackEvent[], viewerSeat: number | null): GameTimeline {
    const b = new Builder();
    let deals = 0;
    let won = false;
    for (const e of events) {
        switch (e.type) {
            case 'card_dealt':
                if (deals++ < MAX_DEAL_SOUNDS_BLACKJACK) b.add('deal', false);
                break;
            case 'dealer_revealed':
                b.add('flip', false);
                break;
            case 'bet_placed':
            case 'bet_cleared':
                b.add('chips');
                break;
            case 'acted':
                if (e.action === 'stand') b.add('check', false);
                else if (e.action === 'double' || e.action === 'split') b.add('chips', false);
                break;
            case 'hand_settled':
                if (!won && viewerSeat !== null && e.seat === viewerSeat && (e.outcome === 'win' || e.outcome === 'blackjack')) {
                    won = true;
                    b.add('win', false);
                }
                break;
            default:
                break;
        }
    }
    return b.done();
}
