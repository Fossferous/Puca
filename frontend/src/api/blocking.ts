/**
 * Blocked-users client.
 *
 * The backend has enforced blocks for a long time (DM sends, WS relay,
 * conversation creation) — but no frontend code ever called these routes, so
 * the Settings panel showed a hardcoded "You haven't blocked anyone yet" and
 * nothing in the UI could block anyone at all.
 */
import { apiClient } from './client';

export interface BlockedUser {
    user_id: number;
    username: string;
    blocked_at: string;
}

/** Everyone the current user has blocked. */
export function listBlocked(): Promise<BlockedUser[]> {
    return apiClient.get('/blocked');
}

/** Block a user: stops their DMs in both directions, server-enforced. */
export function blockUser(userId: number): Promise<void> {
    return apiClient.post(`/users/${userId}/block`);
}

export function unblockUser(userId: number): Promise<void> {
    return apiClient.delete(`/users/${userId}/block`);
}
