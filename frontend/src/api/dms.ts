import { apiClient } from './client';

// --- Types ---

export interface DMConversation {
    id: string;
    other_user_id: number;
    other_username: string;
    other_display_name: string | null;
    last_message: string | null;
    last_message_at: string | null;
    created_at: string;
}

export interface DMMessage {
    id: string;
    conversation_id: string;
    sender_id: number;
    sender_username: string;
    sender_display_name: string | null;
    content: string;
    created_at: string;
    /** E2EE state of `content`, set by decryptDMMessages / the WS append path.
     *  `legacy` = the server sent plaintext (never encrypted) — the UI flags it
     *  so an injected cleartext message is distinguishable from a decrypted one
     *  (audit H-1). Undefined on optimistic local bubbles (treated as secure). */
    encState?: MessageEncState;
}

// --- User Search API ---

export interface SearchUserResult {
    id: number;
    username: string;
    display_name: string | null;
    is_online: boolean;
}

/**
 * Search users by username (for DM creation)
 */
export function searchUsers(query: string): Promise<SearchUserResult[]> {
    if (!query || query.length < 1) return Promise.resolve([]);

    return apiClient.get(`/users/search?q=${encodeURIComponent(query)}`);
}

// --- DM API ---

/**
 * List all DM conversations for the current user
 * Sorted by most recent message
 */
export function listDMConversations(): Promise<DMConversation[]> {
    return apiClient.get('/dms');
}

/**
 * Start a new DM conversation with a user, or get existing one
 */
export function startDMConversation(userId: number): Promise<DMConversation> {
    return apiClient.post('/dms', { user_id: userId });
}

/**
 * Get messages from a DM conversation
 */
export function getDMMessages(conversationId: string, limit: number = 50): Promise<DMMessage[]> {
    return apiClient.get(`/dms/${conversationId}/messages?limit=${limit}`);
}

/**
 * Send a message in a DM conversation
 */
// --- E2EE Support (pairwise) ---

import {
    getActiveIdentity,
    encryptDM,
    decryptDM,
    encryptSelf,
    decryptSelf,
    parseEnvelopeEx,
    serializeEnvelope,
    SecureSendError,
    messageEncState,
    type MessageEncState,
} from './e2ee';
import { resolvePinnedIdentityKey } from './keyVerification';
import { currentUserIdFromToken } from './auth';
import { ENC_SIGN_IN, ENC_UNVERIFIED_SENDER, ENC_CANNOT_DECRYPT, ENC_CONTEXT_MISMATCH, ENC_UNSUPPORTED_VERSION } from './decryptMarkers';

/** Signed-in user id, straight from the JWT (no verification needed here —
 *  this only decides which key shape to use for our OWN conversation). */
function currentUserId(): number | null {
    return currentUserIdFromToken();
}

/**
 * Fetch a user's public key for E2EE
 */
async function getUserPublicKey(userId: number): Promise<string | null> {
    try {
        const data: { public_key?: string } = await apiClient.get(`/users/${userId}/public-key`);
        return data.public_key || null;
    } catch {
        return null;
    }
}

// Cache public keys
const publicKeyCache = new Map<number, string>();

/**
 * Get public key with caching. Exported so other pairwise-crypto features
 * (e.g. the remote-control channel) can resolve peer keys through the same cache.
 */
export async function getCachedPublicKey(userId: number): Promise<string | null> {
    if (publicKeyCache.has(userId)) {
        return publicKeyCache.get(userId)!;
    }
    const key = await getUserPublicKey(userId);
    if (key) {
        publicKeyCache.set(userId, key);
    }
    return key;
}

/**
 * Encrypt DM content for a recipient, returning the wire envelope string to
 * send. Both the REST and WebSocket send paths use this so stored and realtime
 * content match.
 *
 * The DM key is symmetric between the two participants, so the recipient — and
 * the sender themselves, on reload — decrypt with the *partner's* public key.
 *
 * FAIL CLOSED (audit H4): the recipient key is resolved through the TOFU-pin /
 * verification path, NOT the raw server value. If the identity is missing, the
 * server withholds the key, or the pinned/verified key changed, we THROW a
 * SecureSendError rather than emit plaintext — a malicious server (the E2EE
 * adversary) must not be able to force a silent plaintext downgrade or slip in a
 * substituted key. Callers surface the message and block the send.
 */
export async function encryptDMContent(content: string, recipientUserId: number): Promise<string> {
    const identity = getActiveIdentity();
    if (!identity) {
        throw new SecureSendError("Can't send securely — your encryption identity is unavailable. Sign in again to restore it.");
    }
    // Messaging YOURSELF uses the dedicated self key (HKDF over your own
    // private key), not the pairwise DM exchange. ECDH against your own public
    // key would technically round-trip, but it makes the message's readability
    // depend on the SERVER handing back your own public key correctly — for
    // something only you can ever read. The self key needs no key exchange at
    // all and follows your identity through password changes.
    if (recipientUserId === currentUserId()) {
        return serializeEnvelope(await encryptSelf(identity, content));
    }
    const recipientPublicKey = await resolvePinnedIdentityKey(recipientUserId);
    if (!recipientPublicKey) {
        throw new SecureSendError("Can't send securely — this person's encryption key is unavailable or has changed. Verify their safety number before messaging.");
    }
    const me = currentUserId();
    if (me === null) throw new SecureSendError("Can't send securely — you appear to be signed out. Sign in again.");
    const env = await encryptDM(identity, recipientPublicKey, content, { senderId: me, recipientId: recipientUserId });
    if (!env) {
        throw new SecureSendError("Can't send securely — encryption failed. Please try again.");
    }
    return serializeEnvelope(env);
}

/**
 * Decrypt a DM message. `partnerUserId` is the *other* participant of the
 * conversation (not necessarily the message sender) — the shared key is the
 * same in both directions, so this lets a sender read their own messages too.
 */
export async function decryptDMContent(content: string, partnerUserId: number, senderId: number): Promise<string> {
    const parsed = parseEnvelopeEx(content);
    if (parsed.kind === 'unsupported-version') return ENC_UNSUPPORTED_VERSION;
    // Accept BOTH shapes: 'self' for your own conversation, 'dm' for everyone
    // else. Anything unrecognised passes through as-is (legacy plaintext).
    if (parsed.kind !== 'envelope' || (parsed.env.t !== 'dm' && parsed.env.t !== 'self')) return content;
    const env = parsed.env;

    const identity = getActiveIdentity();
    if (!identity) return ENC_SIGN_IN;

    if (env.t === 'self') {
        // A 'self' envelope is legitimate ONLY in your OWN notes-to-self
        // conversation. Accepting it in a conversation with someone else lets a
        // malicious operator replay one of your self-encrypted notes into a peer
        // thread and have it render as content of that thread. Outside the
        // self-DM there is no honest 'self' message, so refuse to decrypt one.
        if (partnerUserId !== currentUserId()) return ENC_CANNOT_DECRYPT;
        const mine = await decryptSelf(identity, env);
        return mine ?? ENC_CANNOT_DECRYPT;
    }

    // Resolve the partner's key through the SAME TOFU-pin / verification path
    // the send side uses (resolvePinnedIdentityKey), NOT the raw server cache.
    // Decrypting a 'dm' envelope requires the shared secret X25519(myPriv,
    // partnerPub); if the server substitutes partnerPub it can forge a message
    // that decrypts as authentic and render it under the peer's name. The send
    // path already fails closed on a pin/verify mismatch — the receive path must
    // mirror it, or the mitigation only covers one half of the pair. A key that
    // changed from the pinned/verified value returns null here: show the
    // "sender key unverified" marker instead of decrypting with it.
    const partnerKey = await resolvePinnedIdentityKey(partnerUserId);
    if (!partnerKey) return ENC_UNVERIFIED_SENDER;

    // The row's sender must be one of the two people in this conversation;
    // that decides the DIRECTION the v3 tag was sealed under. A pairwise key
    // is symmetric, so this is exactly what the key does not authenticate.
    const me = currentUserId();
    if (env.v === 3) {
        if (me === null) return ENC_SIGN_IN;
        if (senderId !== me && senderId !== partnerUserId) return ENC_CONTEXT_MISMATCH;
    }
    // v2 ignores the context entirely; the fallback below only keeps the
    // call well-typed when no token is present (a test rig, never the app).
    const recipientId = senderId === me ? partnerUserId : (me ?? partnerUserId);
    const plain = await decryptDM(identity, partnerKey, env, { senderId, recipientId });
    if (plain !== null) return plain;
    return env.v === 3 ? ENC_CONTEXT_MISMATCH : ENC_CANNOT_DECRYPT;
}

/**
 * Process an array of DM messages, decrypting as needed. `partnerUserId` is the
 * other participant in the conversation.
 */
export async function decryptDMMessages(messages: DMMessage[], partnerUserId: number): Promise<DMMessage[]> {
    return Promise.all(
        messages.map(async (msg) => {
            const wire = msg.content;
            const text = await decryptDMContent(wire, partnerUserId, msg.sender_id);
            return { ...msg, content: text, encState: messageEncState(wire, text) };
        })
    );
}
