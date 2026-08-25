/**
 * Server-wide "All checklists" view: every checklist channel in the current
 * server, each rendered as its own Keep-style board in a scrollable grid. Each
 * board reuses ChecklistBody, so items stay E2EE (decrypted per channel) and
 * fully interactive (add / check / reorder) right from the aggregated view.
 */
import type { Channel } from '../api/servers';
import { ChecklistBody } from './ChecklistBody';
import { ChecklistIcon } from './Icons';
import './AllChecklistsView.css';

interface AllChecklistsViewProps {
    serverName: string;
    channels: Channel[];
    onOpenChannel?: (channel: Channel) => void;
    /** Caller's user id, for creator-only task actions on each board. */
    currentUserId?: number;
    /** Attribution: user id → display name (this server's members). */
    resolveUserName?: (id: number) => string | undefined;
}

export function AllChecklistsView({ serverName, channels, onOpenChannel, currentUserId, resolveUserName }: AllChecklistsViewProps) {
    const checklistChannels = channels.filter(c => c.has_checklist);

    return (
        <div className="all-checklists">
            <div className="all-checklists-header">
                <h2><ChecklistIcon /> All checklists</h2>
                <span className="all-checklists-sub">{serverName} · {checklistChannels.length} checklist{checklistChannels.length === 1 ? '' : 's'}</span>
            </div>

            {checklistChannels.length === 0 ? (
                <div className="all-checklists-empty">
                    No checklist channels in this server yet. Create one with the
                    <strong> Checklist</strong> option when adding a channel, or turn an existing
                    text channel into a checklist from its edit menu.
                </div>
            ) : (
                <div className="all-checklists-grid">
                    {checklistChannels.map(ch => (
                        <section className="checklist-card" key={ch.id}>
                            <header
                                className="checklist-card-header"
                                onClick={onOpenChannel ? () => onOpenChannel(ch) : undefined}
                                role={onOpenChannel ? 'button' : undefined}
                                title={onOpenChannel ? 'Open this channel' : undefined}
                            >
                                <ChecklistIcon /> {ch.name}
                            </header>
                            <ChecklistBody
                                channelId={ch.id}
                                compact
                                subscribeRoom
                                myPerms={ch.my_permissions}
                                currentUserId={currentUserId}
                                resolveUserName={resolveUserName}
                            />
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
}
