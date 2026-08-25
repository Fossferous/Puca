import { API_BASE_URL } from './config';
import { getToken } from './auth';

// --- Types ---

export interface Profile {
    id: number;
    username: string;
    display_name: string | null;
    email?: string;
    avatar_url: string | null;
    avatar_file_id?: string | null;
    /** Privacy: when false, only accepted friends can DM this user. Server-enforced. */
    allow_dms_from_server_members: boolean;
    /** Privacy: when false, presence reports this user as offline to others. Server-enforced. */
    show_online_status: boolean;
    /** Uploaded clip played to others when you join/leave voice (null = default chime). */
    join_sound_file_id?: string | null;
    leave_sound_file_id?: string | null;
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

// --- Profile API ---

/**
 * Get current user's profile
 */
export async function getProfile(): Promise<Profile> {
    const response = await fetch(`${API_BASE_URL}/profile`, {
        method: 'GET',
        headers: authHeaders(),
    });
    if (!response.ok) throw new Error('Failed to get profile');
    return response.json();
}

/**
 * Update current user's profile
 */
export async function updateProfile(updates: {
    username?: string;
    avatar_file_id?: string;
    display_name?: string;
    allow_dms_from_server_members?: boolean;
    show_online_status?: boolean;
    /** File id of an uploaded audio clip; empty string clears back to the default chime. */
    join_sound_file_id?: string;
    leave_sound_file_id?: string;
}): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/profile`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(updates),
    });
    if (!response.ok) {
        // Surface the server's reason (e.g. "join sound must be an audio file")
        // so the sound-upload UI can show something actionable.
        const detail = await response.text().catch(() => '');
        throw new Error(detail || 'Failed to update profile');
    }
}

/**
 * Update current user's avatar
 */
export async function updateAvatar(avatarFileId: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/profile`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ avatar_file_id: avatarFileId }),
    });
    if (!response.ok) throw new Error('Failed to update avatar');
}
