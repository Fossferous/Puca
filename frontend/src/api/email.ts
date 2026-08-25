// Email-related API functions

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export interface MessageResponse {
    message: string;
}

export interface ValidateTokenResponse {
    valid: boolean;
    username?: string;
    message?: string;
}

/**
 * Request a password reset email
 */
export async function forgotPassword(email: string): Promise<MessageResponse> {
    const response = await fetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });

    return response.json();
}

/**
 * Validate a password reset token
 */
export async function validateResetToken(token: string): Promise<ValidateTokenResponse> {
    const response = await fetch(`${API_URL}/auth/validate-reset-token?token=${encodeURIComponent(token)}`);
    return response.json();
}

/**
 * Reset password using a token
 */
export async function resetPassword(
    token: string,
    username: string,
    salt: string,
    verifier: string
): Promise<MessageResponse> {
    const response = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username, salt, verifier }),
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to reset password');
    }

    return response.json();
}

/**
 * Verify email with token
 */
export async function verifyEmail(token: string): Promise<MessageResponse> {
    const response = await fetch(`${API_URL}/auth/verify-email?token=${encodeURIComponent(token)}`);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to verify email');
    }

    return response.json();
}
