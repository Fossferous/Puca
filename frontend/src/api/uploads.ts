import { API_BASE_URL } from './config';


// --- Types ---

export interface UploadedFile {
    id: string;
    original_name: string;
    mime_type: string;
    size_bytes: number;
    url: string;
    /** Per-file capability (base64url), present only when the upload asked
     *  for one and the server is new enough to mint it. Carried inside the
     *  encrypted message next to the file key; presented on fetch. */
    cap?: string;
}

// --- Upload API ---

import { apiClient } from './client';

/**
 * Server-enforced cap (upload_handlers.rs). Mirrored here ONLY to fail fast with
 * a message that names the real numbers — the server stays the authority.
 *
 * Without this the client encrypts the whole file, pushes it up a residential
 * uplink, waits, and only then collects a 413. For anything large that is a long
 * wait to be told "no".
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Bytes AES-GCM adds to an encrypted attachment: a 12-byte nonce prefix plus the
 * 16-byte tag. Small, but it decides the boundary case — a file of exactly the
 * cap encrypts to cap+28 and the server rejects it, so the plaintext budget has
 * to be that much smaller.
 */
export const ENCRYPTED_OVERHEAD_BYTES = 28;

/** Thrown before any bytes move. Message is safe to show to the user verbatim. */
export class FileTooLargeError extends Error {
    readonly file: File;

    constructor(file: File, budget: number) {
        super(
            `"${file.name}" is ${formatFileSize(file.size)} — the limit is `
            + `${formatFileSize(budget)}.`
        );
        this.name = 'FileTooLargeError';
        this.file = file;
    }
}

/**
 * Reject an oversized file before spending time encrypting and sending it.
 * `overhead` is what the caller will add to these bytes before upload.
 */
export function assertUploadable(file: File, overhead = 0): void {
    const budget = MAX_UPLOAD_BYTES - overhead;
    if (file.size > budget) throw new FileTooLargeError(file, budget);
}

/**
 * Upload a file
 */
export function uploadFile(file: File, opts?: { wantCap?: boolean }): Promise<UploadedFile> {
    assertUploadable(file);

    const formData = new FormData();
    formData.append('file', file);

    // A HEADER, not a multipart field: an older server's field loop treats
    // any unknown field as the file body, whereas an unknown header is simply
    // ignored — so a new client uploads fine against an old server and just
    // gets no capability back.
    return apiClient.post('/upload', formData, opts?.wantCap ? { headers: { 'X-Puca-Want-Cap': '1' } } : undefined);
}

/**
 * Get the full URL for a file
 */
export function getFileUrl(fileId: string): string {
    return `${API_BASE_URL}/files/${fileId}`;
}

/**
 * Check if a mime type is an image
 */
export function isImageType(mimeType: string): boolean {
    return mimeType.startsWith('image/');
}

/**
 * Check if a mime type is audio (custom join/leave clips)
 */
export function isAudioType(mimeType: string): boolean {
    return mimeType.startsWith('audio/');
}

/**
 * Server-enforced cap for custom join/leave sound clips (handlers.rs
 * MAX_SOUND_BYTES). Mirrored to fail fast client-side; the server stays the
 * authority.
 */
export const MAX_SOUND_BYTES = 1024 * 1024;

/**
 * Throw away an upload we just made and are not going to use.
 *
 * Every uploaded blob counts against the uploader's storage quota forever, and
 * until DELETE /files/:id existed nothing could give that space back. The paths
 * that upload BEFORE knowing whether the surrounding action will succeed (an
 * emoji whose name turns out to be taken, a server icon picked and then not
 * saved) were leaking quota on every failure.
 *
 * Fire-and-forget on purpose: reclaiming is housekeeping, and it must never
 * turn into a second error on top of whatever already went wrong. A failed
 * discard just leaves the orphan that would have been there anyway.
 */
export function discardUpload(fileId: string): void {
    void apiClient.delete(`/files/${fileId}`).catch(() => { /* best effort */ });
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    // Device downloads and P2P transfers routinely exceed a gigabyte; without
    // this tier a 2 GB file reads as "2048.0 MB".
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
