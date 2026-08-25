import { useEffect, useMemo, useState } from 'react';
import { listChannels, sendChannelMessageEncrypted, type Server, type Channel } from '../api/servers';
import { encryptDMContent, type DMConversation } from '../api/dms';
import { SecureSendError } from '../api/e2ee';
import { wsClient } from '../api/websocket';
import { buildForwardText } from './contextMenuUtils';
import { CloseIcon } from './Icons';
import './ForwardModal.css';

interface ForwardModalProps {
    /** Decrypted content of the message being forwarded. */
    content: string;
    servers: Server[];
    dmConversations: DMConversation[];
    onClose: () => void;
    /** Called after a successful channel forward. Chat drops its own WS
        echoes, so it must append the sent message itself when the target is
        the channel currently on screen. */
    onSentToChannel: (channelId: number, messageId: string, text: string) => void;
}

/**
 * "Forward" destination picker (the familiar chat-app pattern): every text channel of the
 * user's joined servers plus existing DM conversations, with a filter box.
 * Sending reuses the normal composer paths (sendChannelMessageEncrypted /
 * encryptDMContent + WS), so re-encryption for the target happens naturally.
 */
export function ForwardModal({ content, servers, dmConversations, onClose, onSentToChannel }: ForwardModalProps) {
    const [filter, setFilter] = useState('');
    const [channelsByServer, setChannelsByServer] = useState<Map<string, Channel[]>>(new Map());
    const [sendingKey, setSendingKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Load each joined server's channels once. A server whose list fails just
    // contributes no targets — no reason to block the whole modal. Post
    // permission isn't knowable client-side; a forbidden send surfaces as the
    // error banner instead.
    useEffect(() => {
        let cancelled = false;
        Promise.all(
            servers.map(async s => [s.id, await listChannels(s.id).catch(() => [] as Channel[])] as const)
        ).then(entries => {
            if (!cancelled) setChannelsByServer(new Map(entries));
        });
        return () => { cancelled = true; };
    }, [servers]);

    const q = filter.trim().toLowerCase();

    // Text channels only — voice/collections can't hold messages, and
    // checklist channels hide the composer (their feed is a task list).
    const channelTargets = useMemo(() => servers.map(server => ({
        server,
        channels: (channelsByServer.get(server.id) ?? []).filter(c =>
            c.channel_type === 0 && !c.has_checklist &&
            (!q || c.name.toLowerCase().includes(q) || server.name.toLowerCase().includes(q))
        ),
    })).filter(group => group.channels.length > 0), [servers, channelsByServer, q]);

    const dmTargets = useMemo(() => dmConversations.filter(c =>
        !q ||
        (c.other_display_name ?? '').toLowerCase().includes(q) ||
        c.other_username.toLowerCase().includes(q)
    ), [dmConversations, q]);

    const forwardToChannel = async (channel: Channel) => {
        if (sendingKey) return;
        setSendingKey(`ch-${channel.id}`);
        setError(null);
        try {
            const text = buildForwardText(content);
            const sent = await sendChannelMessageEncrypted(channel.id, text);
            onSentToChannel(channel.id, sent.id, text);
            onClose();
        } catch (err) {
            console.error('Failed to forward message:', err);
            // Fail-closed E2EE (audit H4) throws a specific reason — show it.
            setError(err instanceof SecureSendError ? err.message : 'Failed to forward — you may not be able to post there.');
            setSendingKey(null);
        }
    };

    const forwardToDM = async (conv: DMConversation) => {
        if (sendingKey) return;
        setSendingKey(`dm-${conv.id}`);
        setError(null);
        try {
            const text = buildForwardText(content);
            // DMs persist ONLY through the WS path (no REST fallback), and
            // wsClient.send() silently no-ops when the socket isn't OPEN. Guard
            // BEFORE closing so a drop during a reconnect window surfaces as an
            // error instead of a message that vanishes with success UX.
            if (!wsClient.isConnected) {
                setError('Not connected — reconnecting. Try again in a moment.');
                setSendingKey(null);
                return;
            }
            // Same realtime path as the DM composer: encrypt for the partner,
            // send over WS. The server echo updates an open conversation.
            const wire = await encryptDMContent(text, conv.other_user_id);
            if (!wsClient.isConnected) {
                setError('Not connected — reconnecting. Try again in a moment.');
                setSendingKey(null);
                return;
            }
            wsClient.sendDirectMessage(conv.other_user_id, wire);
            onClose();
        } catch (err) {
            console.error('Failed to forward DM:', err);
            setError(err instanceof SecureSendError ? err.message : 'Failed to forward.');
            setSendingKey(null);
        }
    };

    return (
        <div className="forward-modal-overlay" onClick={onClose}>
            <div className="forward-modal" onClick={e => e.stopPropagation()}>
                <button className="forward-modal-close" onClick={onClose} title="Close"><CloseIcon size={18} /></button>
                <h2>Forward message</h2>
                <input
                    type="text"
                    className="forward-filter"
                    placeholder="Search channels and people…"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    autoFocus
                />
                {error && <div className="forward-error">{error}</div>}
                <div className="forward-target-list">
                    {channelTargets.map(({ server, channels }) => (
                        <div key={server.id}>
                            <div className="forward-section-label">{server.name}</div>
                            {channels.map(channel => (
                                <button
                                    key={channel.id}
                                    className="forward-target"
                                    disabled={sendingKey !== null}
                                    onClick={() => forwardToChannel(channel)}
                                >
                                    <span className="ft-hash">#</span>
                                    <span className="ft-name">{channel.name}</span>
                                    {sendingKey === `ch-${channel.id}` && <span className="ft-sending">Sending…</span>}
                                </button>
                            ))}
                        </div>
                    ))}
                    {dmTargets.length > 0 && (
                        <div>
                            <div className="forward-section-label">Direct Messages</div>
                            {dmTargets.map(conv => (
                                <button
                                    key={conv.id}
                                    className="forward-target"
                                    disabled={sendingKey !== null}
                                    onClick={() => forwardToDM(conv)}
                                >
                                    <span className="ft-avatar">
                                        {(conv.other_display_name || conv.other_username)[0]?.toUpperCase()}
                                    </span>
                                    <span className="ft-name">{conv.other_display_name || conv.other_username}</span>
                                    {sendingKey === `dm-${conv.id}` && <span className="ft-sending">Sending…</span>}
                                </button>
                            ))}
                        </div>
                    )}
                    {channelTargets.length === 0 && dmTargets.length === 0 && (
                        <div className="forward-empty">No matching destinations</div>
                    )}
                </div>
            </div>
        </div>
    );
}
