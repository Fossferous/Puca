/**
 * "Send to Púca…" — post a note into one of your channels or to someone in a
 * direct message.
 *
 * It is a SNAPSHOT, not a share: the message is an ordinary chat message from
 * this moment on, it creates no membership and no live link, and editing the
 * note afterwards changes nothing that was sent. That is why the sheet always
 * asks first and names where the text is going — a channel note becomes
 * readable by everyone in that channel, and there is no unsend.
 *
 * Both sends go through the paths the composer already uses, so the note's
 * text is re-encrypted for the destination: `sendChannelMessageEncrypted`
 * under the channel group key, `encryptDMContent` for the partner. Neither
 * touches the WebSocket — the DM rides `POST /dms/:id/messages` — because
 * Notes never opens a socket (notesQueries.ts's header; guarded by
 * tests/notesNoSocket.test.ts).
 *
 * One send at a time, and no way out of the dialog while one is in flight
 * (`busy`): closing does not cancel the request, so a second confirm would
 * post the note twice — and the whole confirm step exists because a chat
 * message cannot be unsent.
 */
import { useMemo, useState } from 'react';
import { sendChannelMessageEncrypted } from '../../api/servers';
import { encryptDMContent, sendDMMessageRest, type DMConversation } from '../../api/dms';
import { SecureSendError } from '../../api/e2ee';
import { ApiError, isNetworkError } from '../../api/client';
import { type NoteCard } from '../model/notesModel';
import { MAX_MESSAGE_BYTES, noteToMessage, sealedMessageBytes } from '../model/noteText';
import { useSendTargets, type SendChannelTarget } from '../model/notesQueries';
// The dialog shell moved to components/ when Púca grew the same views.
import { NotesDialog } from '../../components/NotesDialog';

type Target =
    | { kind: 'channel'; t: SendChannelTarget }
    | { kind: 'dm'; conv: DMConversation };

/** Said in both places it can be discovered: before the send, from the size
 *  the text will seal to, and after one, from the server's 413. */
const TOO_LONG = 'This note is too long to post as one message — sending it would go over what a single message can hold. Shorten it, or send part of it.';

function targetName(t: Target): string {
    return t.kind === 'channel' ? `#${t.t.channel.name}` : (t.conv.other_display_name || t.conv.other_username);
}

interface SendToPucaSheetProps {
    card: NoteCard;
    onClose: () => void;
    /** Sent — the caller shows the toast (it owns the toast bus). */
    onSent: (where: string) => void;
}

export function SendToPucaSheet({ card, onClose, onSent }: SendToPucaSheetProps) {
    const [filter, setFilter] = useState('');
    const [picked, setPicked] = useState<Target | null>(null);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { channels, dms, loading } = useSendTargets(true);

    // Built once per note: the confirm step quotes its counts, and rebuilding
    // it at send time could disagree with what the user was shown.
    const message = useMemo(() => noteToMessage(card), [card]);

    const q = filter.trim().toLowerCase();
    const channelGroups = useMemo(() => {
        const byServer = new Map<string, { name: string; rows: SendChannelTarget[] }>();
        for (const t of channels) {
            if (q && !t.channel.name.toLowerCase().includes(q) && !t.server.name.toLowerCase().includes(q)) continue;
            const g = byServer.get(t.server.id) ?? { name: t.server.name, rows: [] };
            g.rows.push(t);
            byServer.set(t.server.id, g);
        }
        return [...byServer.entries()].map(([id, g]) => ({ id, ...g }));
    }, [channels, q]);
    const dmRows = useMemo(() => dms.filter(c =>
        !q || (c.other_display_name ?? '').toLowerCase().includes(q) || c.other_username.toLowerCase().includes(q),
    ), [dms, q]);

    // What the server will measure, as closely as it can be known before the
    // seal. Shown in the confirm step rather than discovered as a failure.
    const tooLong = sealedMessageBytes(message.text) > MAX_MESSAGE_BYTES;

    const send = async () => {
        if (!picked || sending || tooLong) return;
        setSending(true);
        setError(null);
        try {
            if (picked.kind === 'channel') {
                await sendChannelMessageEncrypted(picked.t.channel.id, message.text);
            } else {
                // Seal for the partner first — a failure here must not leave a
                // half-sent message — then hand the SEALED wire to REST.
                const wire = await encryptDMContent(message.text, picked.conv.other_user_id);
                // Only knowable here: a v4 DM wraps the message key to every
                // device they have, so the same text can fit a channel and not
                // a DM. Refuse before the POST rather than read it back as a
                // generic error.
                if (wire.length > MAX_MESSAGE_BYTES) {
                    setError(TOO_LONG);
                    setSending(false);
                    return;
                }
                await sendDMMessageRest(picked.conv.id, wire);
            }
            onSent(targetName(picked));
            onClose();
        } catch (err) {
            console.error('[notes] send to Púca failed:', err);
            // Fail-closed E2EE says exactly why; show it verbatim.
            if (err instanceof SecureSendError) setError(err.message);
            else if (isNetworkError(err)) setError('Couldn’t reach the server — nothing was sent.');
            else if (err instanceof ApiError && err.status === 403) setError('You can’t post there.');
            else if (err instanceof ApiError && err.status === 413) setError(TOO_LONG);
            else setError('Couldn’t send it — nothing was posted.');
            setSending(false);
        }
    };

    return (
        <NotesDialog title={picked ? 'Send this note?' : 'Send to Púca'} onClose={onClose} busy={sending}>
            {error && <div className="notes-send-error" role="alert">{error}</div>}
            {picked ? (
                <div className="notes-send-confirm">
                    <p>
                        Send “{card.title}” to <strong>{targetName(picked)}</strong>
                        {picked.kind === 'channel' ? ` in ${picked.t.server.name}` : ''}?
                    </p>
                    <p className="notes-labels-hint">
                        {picked.kind === 'channel'
                            ? 'Everyone in that channel will be able to read it, and a message can’t be unsent. Your note stays encrypted to you; the message is encrypted for them.'
                            : 'They will be able to read it, and a message can’t be unsent. Your note stays encrypted to you; the message is encrypted for them.'}
                    </p>
                    <p className="notes-labels-hint">
                        This posts a copy of the note as it is now. It does not share the note — later changes don’t follow it.
                    </p>
                    {message.omitted > 0 && (
                        <p className="notes-labels-hint">
                            {message.omitted} thing{message.omitted === 1 ? '' : 's'} this device can’t read {message.omitted === 1 ? 'was' : 'were'} left out rather than guessed.
                        </p>
                    )}
                    {message.pictures.length > 0 && (
                        <p className="notes-labels-hint">
                            Pictures are not sent — they stay in the note, and the message lists them by name.
                        </p>
                    )}
                    {tooLong && (
                        <p className="notes-send-error" role="alert">{TOO_LONG}</p>
                    )}
                    <pre className="notes-send-preview">{message.text}</pre>
                    <div className="notes-send-actions">
                        <button type="button" className="notes-textbtn" disabled={sending} onClick={() => { setPicked(null); setError(null); }}>Back</button>
                        <button type="button" className="notes-send-go" disabled={sending || tooLong || !message.text} onClick={() => { void send(); }}>
                            {sending ? 'Sending…' : 'Send'}
                        </button>
                    </div>
                    {!message.text && <p className="notes-labels-hint">There is nothing readable in this note to send.</p>}
                </div>
            ) : (
                <>
                    <input
                        type="text"
                        className="notes-send-filter"
                        placeholder="Search channels and people…"
                        aria-label="Search channels and people"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        autoFocus
                    />
                    <div className="notes-send-list">
                        {channelGroups.map(g => (
                            <div key={g.id}>
                                <div className="notes-send-section">{g.name}</div>
                                {g.rows.map(t => (
                                    <button
                                        key={t.channel.id}
                                        type="button"
                                        className="notes-send-target"
                                        onClick={() => setPicked({ kind: 'channel', t })}
                                    >
                                        <span className="notes-send-hash">#</span>
                                        <span className="notes-send-name">{t.channel.name}</span>
                                    </button>
                                ))}
                            </div>
                        ))}
                        {dmRows.length > 0 && (
                            <div>
                                <div className="notes-send-section">Direct messages</div>
                                {dmRows.map(conv => (
                                    <button
                                        key={conv.id}
                                        type="button"
                                        className="notes-send-target"
                                        onClick={() => setPicked({ kind: 'dm', conv })}
                                    >
                                        <span className="notes-send-avatar">{(conv.other_display_name || conv.other_username)[0]?.toUpperCase()}</span>
                                        <span className="notes-send-name">{conv.other_display_name || conv.other_username}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        {channelGroups.length === 0 && dmRows.length === 0 && (
                            <div className="notes-send-empty">
                                {loading ? 'Loading…' : q ? 'Nothing matches that.' : 'No channels you can post in, and no conversations yet.'}
                            </div>
                        )}
                    </div>
                    <p className="notes-labels-hint">
                        Posting a note sends a copy of its text as a message. Pictures stay here.
                    </p>
                </>
            )}
        </NotesDialog>
    );
}
