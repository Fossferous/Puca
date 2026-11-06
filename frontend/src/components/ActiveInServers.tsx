/**
 * "Active in your servers": under the member list, every voice channel in any of your servers
 * that has somebody in it, grouped by server (activeServers.ts). A row goes to that server, where
 * the voice row is, and never joins the call: joining opens a microphone, and that is a press on the
 * voice row itself, as it always was. Rest a mouse on a row, or Tab to it, for everyone in the room.
 *
 * Off with Settings > Appearance > "Show active voice channels from all servers". Its fold is the
 * chevron, remembered on this device (sidebarCollapseStore).
 */
import { ChevronDownIcon, ChevronRightIcon, SpeakerIcon } from './Icons';
import { VoiceRosterTip, type RosterPerson } from './VoiceRosterCard';
import { activePeople, type ActiveServer } from './activeServers';
import './ActiveInServers.css';

/** The names a row shows before it says "+ n more". */
const NAMES_SHOWN = 2;

export function ActiveInServers({ view, collapsed, onToggle, onGo, nameOf, personOf }: {
    view: readonly ActiveServer[];
    collapsed: boolean;
    onToggle: () => void;
    onGo: (serverId: string, channelId: number) => void;
    /** The name to show for somebody in a server's room. */
    nameOf: (serverId: string, userId: number, username: string) => string;
    /** Their state in the room, for the card. */
    personOf: (serverId: string, channelId: number, userId: number, username: string) => RosterPerson;
}) {
    const people = activePeople(view);
    return (
        <section className="active-panel" aria-labelledby="active-panel-title" data-testid="active-panel">
            <h4 className="member-section-title active-panel-title" id="active-panel-title">
                <button
                    type="button"
                    className="active-panel-toggle"
                    aria-expanded={!collapsed}
                    aria-controls="active-panel-body"
                    onClick={onToggle}
                >
                    {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                    <span>Active in your servers</span>
                    {people > 0 && <span className="active-panel-count">{people}</span>}
                </button>
            </h4>
            {!collapsed && (
                <div id="active-panel-body" className="active-panel-body">
                    {view.length === 0 ? (
                        <p className="active-panel-empty">Nobody is in a voice channel in any of your servers.</p>
                    ) : (
                        <ul className="active-servers">
                            {view.map(server => (
                                <li key={server.serverId} className="active-server" data-server-id={server.serverId}>
                                    <div className="active-server-name">
                                        <span className="active-server-text">{server.serverName}</span>
                                        {server.isCurrent && <span className="active-server-here">this server</span>}
                                    </div>
                                    <ul className="active-rooms">
                                        {server.rooms.map(room => {
                                            const names = room.users.map(u => nameOf(server.serverId, u.id, u.username));
                                            const shown = names.slice(0, NAMES_SHOWN).join(', ');
                                            const more = names.length - NAMES_SHOWN;
                                            return (
                                                <li key={room.channelId}>
                                                    <button
                                                        type="button"
                                                        className="active-room"
                                                        data-channel-id={room.channelId}
                                                        onClick={() => onGo(server.serverId, room.channelId)}
                                                        aria-label={`${room.name} in ${server.serverName}, ${room.users.length} in the channel: ${names.join(', ')}. Go to this server`}
                                                    >
                                                        <span className="active-room-icon"><SpeakerIcon /></span>
                                                        <span className="active-room-text">
                                                            <span className="active-room-name">{room.name}</span>
                                                            <span className="active-room-who">{more > 0 ? `${shown} + ${more} more` : shown}</span>
                                                        </span>
                                                        <VoiceRosterTip
                                                            title={`${room.name}, ${server.serverName}`}
                                                            people={room.users.map(u => personOf(server.serverId, room.channelId, u.id, u.username))}
                                                        />
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
}
