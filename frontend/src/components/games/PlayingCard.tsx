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
}

/**
 * One card face, drawn with the SVG suits from Icons.tsx — never a Unicode
 * suit (the host font's glyph, sometimes an emoji). The face is a fixed light
 * surface with fixed ink in every theme (PlayingCard.css), because a card's
 * legibility must not depend on which of the eight themes is on.
 */
export function PlayingCard({ code, size = 'md', muted = false }: PlayingCardProps) {
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
            role="img"
            aria-label={cardName(code)}
            data-card={code}
        >
            <span className="pcard-rank" aria-hidden="true">{rankLabel(code)}</span>
            <span className="pcard-suit" aria-hidden="true">{Suit ? <Suit /> : null}</span>
        </span>
    );
}

/** An empty card slot (the board before the flop). */
export function CardSlot({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
    return <span className={`pcard pcard-${size} pcard-slot`} aria-hidden="true" />;
}
