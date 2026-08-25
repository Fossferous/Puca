/**
 * Search the open conversation, client-side.
 *
 * There is no server-side alternative and there cannot be one: message content
 * is stored end-to-end encrypted, so the database column holds ciphertext. (A
 * `LIKE` endpoint existed and was deleted — because the envelope is JSON,
 * substrings of the WRAPPER matched every row, so it answered `ch`, `epoch` or
 * `v` with the entire channel as confident false positives.)
 *
 * So: fetch, decrypt, filter. At this deployment's scale a whole conversation
 * is a few dozen requests and tens of kilobytes, which is exactly why no
 * persistent index is worth its cost — an index of decrypted plaintext would
 * be a new at-rest exposure to defend a corpus that fits in one round of
 * requests.
 *
 * Two things are deliberately excluded from results:
 *  - content that could not be decrypted, or searching "encrypted" or "key"
 *    matches every message the user cannot read;
 *  - blocked authors, because search is a THIRD delivery path for their text
 *    alongside the message list and reply previews, and it was open.
 */
import { getMessages, decryptChannelMessages } from './servers';
import { getDMMessages, decryptDMMessages } from './dms';
import { isUndecryptable } from './decryptMarkers';
import { parseServerTimestamp } from '../utils/serverTime';

export interface SearchHit {
    id: string;
    senderId: number;
    senderName: string;
    content: string;
    timestamp: number;
}

export interface SearchOutcome {
    hits: SearchHit[];
    /** How many messages were actually examined — shown to the user, because
     *  "no results" means something different at 40 messages than at 4000. */
    searched: number;
    /** Examined but unreadable, so genuinely outside the search. */
    undecryptable: number;
    /** True when we stopped before reaching the start of the conversation. */
    truncated: boolean;
}

/** Page size per request when walking back through a channel. */
const PAGE = 100;
/** Ceiling on total messages examined, so a huge channel cannot hang the UI. */
const MAX_SCANNED = 2000;
/** DM history has no `before` cursor server-side; this is the server's own
 *  clamp, so it is as far back as a DM search can currently see. */
const DM_MAX = 200;

const matches = (content: string, needle: string) =>
    content.toLowerCase().includes(needle);

/**
 * Walk a channel backwards through its history, newest first.
 * `isBlocked` is injected rather than imported so this module stays testable
 * without the block store's browser dependencies.
 */
export async function searchChannel(
    channelId: number,
    query: string,
    isBlocked: (userId: number) => boolean,
    signal?: { aborted: boolean },
): Promise<SearchOutcome> {
    const needle = query.trim().toLowerCase();
    const hits: SearchHit[] = [];
    let searched = 0;
    let undecryptable = 0;
    let before: string | undefined;
    let truncated = false;

    while (searched < MAX_SCANNED) {
        if (signal?.aborted) { truncated = true; break; }
        const raw = await getMessages(channelId, PAGE, before);
        if (raw.length === 0) break;

        const decrypted = await decryptChannelMessages(channelId, raw);
        for (const m of decrypted) {
            searched++;
            if (isUndecryptable(m.content)) { undecryptable++; continue; }
            if (isBlocked(m.user_id)) continue;
            if (matches(m.content, needle)) {
                hits.push({
                    id: m.id,
                    senderId: m.user_id,
                    senderName: m.username,
                    content: m.content,
                    timestamp: parseServerTimestamp(m.created_at),
                });
            }
        }

        // Page back from the OLDEST row of this page. Fewer rows than asked
        // for means we reached the beginning.
        if (raw.length < PAGE) break;
        const oldest = raw[0];
        const cursor = oldest?.created_at;
        if (!cursor || cursor === before) break;   // no progress — stop rather than loop
        before = cursor;
    }
    if (searched >= MAX_SCANNED) truncated = true;

    return { hits, searched, undecryptable, truncated };
}

/**
 * Search a DM conversation. Capped at the server's own limit because the DM
 * endpoint has no `before` cursor — so this genuinely cannot see further back,
 * and the caller must say so rather than implying a complete search.
 */
export async function searchDM(
    conversationId: string,
    partnerUserId: number,
    query: string,
    isBlocked: (userId: number) => boolean,
): Promise<SearchOutcome> {
    const needle = query.trim().toLowerCase();
    const raw = await getDMMessages(conversationId, DM_MAX);
    const decrypted = await decryptDMMessages(raw, partnerUserId);

    const hits: SearchHit[] = [];
    let undecryptable = 0;
    for (const m of decrypted) {
        if (isUndecryptable(m.content)) { undecryptable++; continue; }
        if (isBlocked(m.sender_id)) continue;
        if (matches(m.content, needle)) {
            hits.push({
                id: m.id,
                senderId: m.sender_id,
                senderName: m.sender_username,
                content: m.content,
                timestamp: parseServerTimestamp(m.created_at),
            });
        }
    }
    return {
        hits,
        searched: decrypted.length,
        undecryptable,
        // A full page back means there is probably more we cannot reach.
        truncated: raw.length >= DM_MAX,
    };
}
