import type { GameKind } from '../../api/games/protocol';
import { PlayingCard } from './PlayingCard';

/**
 * The picture on an activity's card and tile (docs/GAMES.md, *Activities*):
 * a little felt with two fanned cards drawn by PlayingCard (SVG suits from
 * Icons.tsx), plus a stack of chips for Poker. Decorative - the name beside
 * it says what it is - so it is hidden from assistive technology.
 */
export function ActivityArt({ kind }: { kind: GameKind }) {
    return (
        <span className={`activity-art activity-art-${kind}`} aria-hidden="true">
            <span className="activity-art-cards">
                {kind === 'holdem' ? (
                    <>
                        <PlayingCard code="Ah" size="sm" decorative />
                        <PlayingCard code="Ks" size="sm" decorative />
                    </>
                ) : (
                    <>
                        <PlayingCard code="As" size="sm" decorative />
                        <PlayingCard code="Jd" size="sm" decorative />
                    </>
                )}
            </span>
            {kind === 'holdem' ? (
                <svg className="activity-art-chips" viewBox="0 0 24 24" width="22" height="22" focusable="false">
                    <ellipse cx="12" cy="17" rx="8" ry="3.2" fill="#c0162c" stroke="#fff" strokeWidth="1.2" />
                    <ellipse cx="12" cy="13" rx="8" ry="3.2" fill="#16171a" stroke="#fff" strokeWidth="1.2" />
                    <ellipse cx="12" cy="9" rx="8" ry="3.2" fill="#2457c5" stroke="#fff" strokeWidth="1.2" />
                </svg>
            ) : (
                <svg className="activity-art-chips" viewBox="0 0 24 24" width="22" height="22" focusable="false">
                    <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#ffffff">21</text>
                </svg>
            )}
        </span>
    );
}
