import { API_BASE_URL } from './config';
import { getToken } from './auth';

// --- Types ---

export interface Reaction {
    emoji: string;
    count: number;
    users: { id: number; username: string }[];
}

export interface CustomEmoji {
    id: string;
    name: string;
    url: string;
    /** Who uploaded it — the server lets the uploader (or the owner) delete.
     *  Optional so a client updated ahead of its server degrades to the old
     *  owner-only gating instead of breaking. */
    uploader_id?: number;
}

// --- Helper ---

function authHeaders(): HeadersInit {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
}

// --- Local reaction-change notification ---
//
// The <MessageReactions> strip refreshes on the WS ReactionUpdate echo, but
// that echo only reaches members of the message's channel room. The hover
// toolbar can add a reaction from a view that joined no such room (collection
// view), where the echo never arrives and the strip would never update. This
// lightweight window event lets the adder nudge any mounted strip for the same
// message to refetch — independent of the WS path.
const REACTION_CHANGED_EVENT = 'sovereign:reaction-changed';

export function notifyReactionChanged(messageId: string): void {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(REACTION_CHANGED_EVENT, { detail: { messageId } }));
    }
}

export function onReactionChanged(cb: (messageId: string) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = (e: Event) => {
        const id = (e as CustomEvent<{ messageId: string }>).detail?.messageId;
        if (id) cb(id);
    };
    window.addEventListener(REACTION_CHANGED_EVENT, handler);
    return () => window.removeEventListener(REACTION_CHANGED_EVENT, handler);
}

// --- Reactions API ---

/**
 * Add a reaction to a message
 */
export async function addReaction(messageId: string, emoji: string, isCustom = false): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/messages/${messageId}/reactions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ emoji, is_custom: isCustom }),
    });
    if (!response.ok) throw new Error('Failed to add reaction');
}

/**
 * Remove a reaction from a message
 */
export async function removeReaction(messageId: string, emoji: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
        method: 'DELETE',
        headers: authHeaders(),
    });
    if (!response.ok) throw new Error('Failed to remove reaction');
}

/**
 * Get all reactions for a message
 */
export async function getReactions(messageId: string): Promise<Reaction[]> {
    const response = await fetch(`${API_BASE_URL}/messages/${messageId}/reactions`, {
        method: 'GET',
        headers: authHeaders(),
    });
    if (!response.ok) throw new Error('Failed to get reactions');
    return response.json();
}

// --- Custom Emoji API ---

/**
 * List all custom emojis for a server
 */
export async function listEmojis(serverId: string): Promise<CustomEmoji[]> {
    const response = await fetch(`${API_BASE_URL}/servers/${serverId}/emojis`, {
        method: 'GET',
        headers: authHeaders(),
    });
    if (!response.ok) throw new Error('Failed to list emojis');
    return response.json();
}

/**
 * Create a custom emoji for a server
 */
export async function createEmoji(serverId: string, name: string, fileId: string): Promise<CustomEmoji> {
    const response = await fetch(`${API_BASE_URL}/servers/${serverId}/emojis`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name, file_id: fileId }),
    });
    if (!response.ok) throw new Error('Failed to create emoji');
    return response.json();
}

/**
 * Delete a custom emoji
 */
export async function deleteEmoji(serverId: string, emojiId: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/servers/${serverId}/emojis/${emojiId}`, {
        method: 'DELETE',
        headers: authHeaders(),
    });
    if (!response.ok) throw new Error('Failed to delete emoji');
}
