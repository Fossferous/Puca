import { apiClient } from './client';

// --- Types ---

export interface Friend {
    id: number;
    username: string;
    is_online: boolean;
    since: string;
}

export interface FriendRequest {
    id: number;
    sender_id: number;
    sender_username: string;
    created_at: string;
}

export interface OutgoingRequest {
    id: number;
    receiver_id: number;
    receiver_username: string;
    created_at: string;
}

export interface FriendshipStatus {
    is_friend: boolean;
    request_sent: boolean;
    request_received: boolean;
    request_id: number | null;
}

// --- Friends API ---

/**
 * List all friends for the current user
 */
export function listFriends(): Promise<Friend[]> {
    return apiClient.get('/friends');
}

/**
 * Send a friend request to a user
 */
export function sendFriendRequest(userId: number): Promise<void> {
    return apiClient.post('/friends/request', { user_id: userId });
}

/**
 * List incoming friend requests
 */
export function listIncomingRequests(): Promise<FriendRequest[]> {
    return apiClient.get('/friends/requests/incoming');
}

/**
 * List outgoing friend requests
 */
export function listOutgoingRequests(): Promise<OutgoingRequest[]> {
    return apiClient.get('/friends/requests/outgoing');
}

/**
 * Accept a friend request
 */
export function acceptFriendRequest(requestId: number): Promise<void> {
    return apiClient.post(`/friends/requests/${requestId}/accept`);
}

/**
 * Reject/decline a friend request
 */
export function rejectFriendRequest(requestId: number): Promise<void> {
    return apiClient.post(`/friends/requests/${requestId}/reject`);
}

/**
 * Remove a friend
 */
export function removeFriend(userId: number): Promise<void> {
    return apiClient.delete(`/friends/${userId}`);
}

/**
 * Get friendship status with a specific user
 */
export function getFriendshipStatus(userId: number): Promise<FriendshipStatus> {
    return apiClient.get(`/friends/${userId}/status`);
}
