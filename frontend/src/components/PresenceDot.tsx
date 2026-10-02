/**
 * The presence dot: green online, the idle colour for idle, a "zz" badge in
 * that same colour for away, grey offline. Every surface that shows whether
 * someone is around draws THIS, fed from the presence store
 * (api/presenceStore.ts), so the member list, the friends panel and the DM
 * search can never disagree about one person.
 *
 * Colour is never the only signal: the dot carries its spoken name ("Idle",
 * "Away") as its accessible name and tooltip, and away changes SHAPE as well
 * as colour, so it reads in high contrast and to a colour-blind eye.
 *
 * Placement stays with the caller: pass the context's positioning class
 * (`status-dot` beside an avatar) as `className`; this component owns only
 * the colour and the badge.
 */
import { AwayIcon } from './Icons';
import { PRESENCE_LABEL, type PresenceStatus } from '../api/presenceStore';
import './PresenceDot.css';

interface Props {
    status: PresenceStatus;
    className?: string;
}

export function PresenceDot({ status, className }: Props) {
    const label = PRESENCE_LABEL[status];
    return (
        <span
            className={`presence-dot is-${status}${className ? ` ${className}` : ''}`}
            role="img"
            aria-label={label}
            title={label}
        >
            {status === 'away' ? <AwayIcon size={14} className="presence-dot-badge" /> : null}
        </span>
    );
}
