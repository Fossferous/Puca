/**
 * "The server listed someone who is not a member as able to read #channel."
 *
 * Shown when channelKeys.ts refused to give a channel's key to an id the
 * server listed for that channel (GET /channels/:id/member-keys) that is not
 * in the server's member list people see (audit 2026-10, F-2). The refusal
 * already protected the channel; this says it happened, and where, because a
 * server that does it may be trying to read the channel, and only the people
 * in it can tell the owner.
 *
 * Driven by channelKeys.ts's in-memory record for this session, so it
 * survives the channel being left and comes back when a refusal is new.
 */
import { useEffect, useState } from 'react';
import { hiddenRecipientNotices, onHiddenRecipientsChange, type HiddenRecipientNotice } from '../api/channelKeys';
import { CloseIcon, WarningIcon } from './Icons';
import './HiddenRecipientBanner.css';

/** What a notice is, for "dismissed": a refusal that grows is shown again. */
const noticeTag = (n: HiddenRecipientNotice) => `${n.channelId}:${n.userIds.join(',')}`;

function where(n: HiddenRecipientNotice): string {
    const channel = n.channelName ? `#${n.channelName}` : `a channel (id ${n.channelId})`;
    return n.serverName ? `${channel} in ${n.serverName}` : channel;
}

export function HiddenRecipientBanner() {
    const [notices, setNotices] = useState<HiddenRecipientNotice[]>(hiddenRecipientNotices);
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

    useEffect(() => onHiddenRecipientsChange(() => setNotices(hiddenRecipientNotices())), []);

    const shown = notices.filter((n) => !dismissed.has(noticeTag(n)));
    if (shown.length === 0) return null;
    const first = shown[0];
    const others = shown.length - 1;
    const count = first.userIds.length;

    return (
        <div className="hidden-recipient-banner" role="alert" data-testid="hidden-recipient-banner">
            <span className="hidden-recipient-icon"><WarningIcon /></span>
            <div className="hidden-recipient-text">
                <strong>The server listed {count === 1 ? 'someone who is not a member' : `${count} people who are not members`} as able to read {where(first)}.</strong>
                <span>
                    {' '}Púca did not give them the channel's key. If you did not expect this, tell the server's owner.
                    {others > 0 && ` The same happened in ${others === 1 ? 'one other channel' : `${others} other channels`}: ${shown.slice(1).map(where).join(', ')}.`}
                </span>
            </div>
            <button
                className="hidden-recipient-dismiss"
                aria-label="Dismiss"
                onClick={() => setDismissed((d) => new Set([...d, ...shown.map(noticeTag)]))}
            >
                <CloseIcon size={16} />
            </button>
        </div>
    );
}
