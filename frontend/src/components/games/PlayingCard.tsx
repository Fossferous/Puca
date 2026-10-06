import { useState, type CSSProperties } from 'react';
import { SuitClubIcon, SuitDiamondIcon, SuitHeartIcon, SuitSpadeIcon } from '../Icons';
import { cardName, rankLabel } from '../../api/games/gameWords';
import { HIDDEN_CARD, type CardCode } from '../../api/games/protocol';
import './PlayingCard.css';

const SUIT = {
    s: SuitSpadeIcon,
    h: SuitHeartIcon,
    d: SuitDiamondIcon,
    c: SuitClubIcon,
} as const;

interface PlayingCardProps {
    code: CardCode;
    /** sm: opponents / dealer strip; md: board; lg: your own hand. */
    size?: 'sm' | 'md' | 'lg';
    /** Dim it (a folded hand, a busted Blackjack hand). */
    muted?: boolean;
    /** A picture, not a card in play (the activity art): no `data-card`, no
     *  accessible name - nothing that reads as a dealt card. */
    decorative?: boolean;
}

/**
 * One card face, drawn with the SVG suits from Icons.tsx — never a Unicode
 * suit (the host font's glyph, sometimes an emoji). The face is a fixed light
 * surface with fixed ink in every theme (PlayingCard.css), because a card's
 * legibility must not depend on which of the eight themes is on.
 */
export function PlayingCard({ code, size = 'md', muted = false, decorative = false }: PlayingCardProps) {
    if (code === HIDDEN_CARD) {
        return (
            <span className={`pcard pcard-${size} pcard-back${muted ? ' pcard-muted' : ''}`} role="img" aria-label={cardName(code)} />
        );
    }
    const suit = code[1] as keyof typeof SUIT;
    const Suit = SUIT[suit];
    const red = suit === 'h' || suit === 'd';
    return (
        <span
            className={`pcard pcard-${size}${red ? ' pcard-red' : ' pcard-black'}${muted ? ' pcard-muted' : ''}`}
            {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': cardName(code), 'data-card': code })}
        >
            <span className="pcard-rank" aria-hidden="true">{rankLabel(code)}</span>
            <span className="pcard-suit" aria-hidden="true">{Suit ? <Suit /> : null}</span>
        </span>
    );
}

/**
 * A board card the server has dealt, turning face up. It is drawn only once
 * its code has arrived - before that the board shows plain face-down backs
 * that carry no card at all - so the flip cannot give anything away early.
 *
 * `delay` (seconds) and `animate` are taken at MOUNT and kept: later views
 * re-render the card without restarting or shifting a flip in progress. The
 * resting state is face up, so with the animation off (prefers-reduced-motion,
 * or Settings > Enable Animations) the card is simply there.
 */
export function FlipCard({ code, delay, animate, size = 'md' }: { code: CardCode; delay: number; animate: boolean; size?: 'sm' | 'md' | 'lg' }) {
    const [d] = useState(delay);
    const [anim] = useState(animate);
    return (
        <span className={`pflip${anim ? ' pflip-anim' : ''}`} style={{ '--pflip-delay': `${Math.max(0, d)}s` } as CSSProperties}>
            <span className="pflip-inner">
                <PlayingCard code={code} size={size} />
                <span className={`pcard pcard-${size} pcard-back pflip-back`} aria-hidden="true" />
            </span>
        </span>
    );
}

/** An empty card slot (the board before the flop). */
export function CardSlot({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
    return <span className={`pcard pcard-${size} pcard-slot`} aria-hidden="true" />;
}
