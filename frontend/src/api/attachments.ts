/**
 * End-to-end encrypted file attachments.
 *
 * The server stores only ciphertext bytes. Each file is encrypted client-side
 * with a fresh random AES-256-GCM key; that key rides INSIDE the (already E2EE)
 * message as part of the attachment's markdown href, so only people who can
 * decrypt the message can decrypt the file. The server never sees the key, the
 * plaintext bytes, the real filename, or the real MIME type (we upload a generic
 * `attachment.enc`).
 *
 * Wire format of the href embedded in a message:
 *   sovereign-enc:<fileId>?k=<base64url key>&m=<url-encoded mime>[&c=<capability>]
 * `c` is the per-file capability the server minted at upload (0.8.134+):
 * presented on fetch, it is what lets the server refuse a blob to someone
 * who merely learned its id, without ever learning which channel the file
 * belongs to. Absent on refs from older clients; those blobs stay fetchable
 * by id, as before.
 * The display name (which may contain spaces) lives in the markdown alt/label.
 * Stored blob = nonce(12) || AES-256-GCM ciphertext.
 */
import { uploadFile, assertUploadable, ENCRYPTED_OVERHEAD_BYTES } from './uploads';
import { API_BASE_URL } from './config';
import { getToken } from './auth';

const PREFIX = 'sovereign-enc:';

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function isEncAttachment(href: string): boolean {
    return href.startsWith(PREFIX);
}

/**
 * Containers Chromium-family media stacks (desktop Chrome/Edge, WebView2,
 * Android WebView) can generally demux, keyed by filename extension.
 *
 * This exists because `File.type` is the OS/browser registry's guess and for
 * .mkv it is routinely EMPTY — the field report that prompted this was a
 * `....mkv` upload rendering as a download chip because its ref said
 * `application/octet-stream`. Extension is the sender's claim exactly like
 * `m=` is; a wrong claim just means the player errors and the renderer falls
 * back to the chip (onError), so this list can afford to be optimistic.
 * Deliberately absent: avi/wmv/flv, which these engines mostly cannot play —
 * a guaranteed-broken player is worse than a chip.
 */
const VIDEO_EXT_MIME: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    ogv: 'video/ogg',
};

/**
 * The video MIME to render `name` under, or null when it is not a video.
 *
 * A real video/* MIME wins. A MISSING or generic MIME falls back to the
 * filename extension — but a concrete non-video type (application/pdf) is
 * respected: that file is not a video wearing a bad label, it is not a video.
 */
export function videoMimeFor(name: string, mime: string): string | null {
    const m = (mime || '').toLowerCase().split(';')[0].trim();
    if (m.startsWith('video/')) return m;
    if (m && m !== 'application/octet-stream') return null;
    const ext = (name || '').toLowerCase().split('.').pop() ?? '';
    return VIDEO_EXT_MIME[ext] ?? null;
}

export function parseEncAttachment(href: string): { id: string; key: string; mime: string; cap?: string } | null {
    if (!href.startsWith(PREFIX)) return null;
    const [id, query = ''] = href.slice(PREFIX.length).split('?');
    const params = new URLSearchParams(query);
    const key = params.get('k');
    if (!id || !key) return null;
    const cap = params.get('c');
    return {
        id,
        key,
        mime: params.get('m') ? decodeURIComponent(params.get('m')!) : 'application/octet-stream',
        ...(cap ? { cap } : {}),
    };
}

/**
 * Encrypt a file, upload the ciphertext, and return the parts of the ref:
 * the sovereign-enc href (carrying id + key + mime), the sanitized display
 * name, and the real mime. Building block for both the chat markdown form
 * (encryptAndUpload) and task attachment refs.
 */
export async function encryptAndUploadRef(file: File, opts?: { channelId?: number }): Promise<{ href: string; name: string; mime: string }> {
    // Check BEFORE reading and encrypting: uploadFile checks too, but by then we
    // have already pulled the whole file into memory and encrypted it. Account
    // for what encryption adds, or a file of exactly the cap fails at the server.
    assertUploadable(file, ENCRYPTED_OVERHEAD_BYTES);
    const raw = new Uint8Array(await file.arrayBuffer());
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, raw as BufferSource));
    const blob = new Blob([nonce, ct], { type: 'application/octet-stream' });
    const uploaded = await uploadFile(new File([blob], 'attachment.enc', { type: 'application/octet-stream' }), { wantCap: true, channelId: opts?.channelId });

    // The browser's guess first; when it has none (mkv famously reports ""),
    // infer video types from the extension so the ref records something the
    // renderer can embed — old refs without this still get the same fallback
    // at render time (videoMimeFor).
    const mime = file.type
        || videoMimeFor(file.name || '', '')
        || 'application/octet-stream';
    const href = `${PREFIX}${uploaded.id}?k=${b64url(keyBytes)}&m=${encodeURIComponent(mime)}`
        + (uploaded.cap ? `&c=${encodeURIComponent(uploaded.cap)}` : '');
    // Strip markdown-breaking chars from the display name (href has the real ref).
    const name = (file.name || 'attachment').replace(/[[\]()\n]/g, '_');
    return { href, name, mime };
}

/**
 * Encrypt a file, upload the ciphertext, and return the markdown to insert into
 * the message composer (image syntax for images, link syntax otherwise).
 */
export async function encryptAndUpload(file: File, opts?: { channelId?: number }): Promise<string> {
    const { href, name, mime } = await encryptAndUploadRef(file, opts);
    return `${mime.startsWith('image/') ? '!' : ''}[${name}](${href})`;
}

// Decrypted blob URLs are cached by file id so an attachment shown in multiple
// places decrypts once. (Bounded by the 25 MB upload cap.)
const blobCache = new Map<string, string>();

/** Fetch + decrypt an encrypted attachment, returning an object URL for the plaintext. */

/**
 * The MIME on an attachment ref is chosen by the SENDER (`m=` in the href), and
 * a `blob:` document inherits this app's origin. Giving a blob a document type
 * therefore hands an attacker in-origin script execution if that URL is ever
 * navigated to.
 *
 * Only the types we actually render inline keep their real MIME. Everything
 * else — including `text/html` and `image/svg+xml` — becomes an opaque binary
 * blob: still downloadable, but inert if it is ever opened.
 *
 * SVG is excluded deliberately even though it is an image: inside `<img>` it
 * cannot run script, but as a top-level document it can, and the same blob URL
 * is used for both.
 */
export function safeBlobType(mime: string): string {
    const m = (mime || '').toLowerCase().split(';')[0].trim();
    if (m === 'image/svg+xml') return 'application/octet-stream';
    const renderable = m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/');
    return renderable ? m : 'application/octet-stream';
}

/** Concurrent mounts of the same attachment share one fetch+decrypt — a row
 *  remount (e.g. the optimistic→server id swap) otherwise pulls the multi-MB
 *  ciphertext twice, which on a phone right after its own upload is exactly
 *  when the link has no headroom. Same shape as authedMedia's inflight map. */
const inflight = new Map<string, Promise<string>>();

export async function decryptToBlobUrl(id: string, keyB64url: string, mime: string, cap?: string): Promise<string> {
    const cached = blobCache.get(id);
    if (cached) return cached;
    const pending = inflight.get(id);
    if (pending) return pending;
    const p = (async () => {
        // /files is authenticated now — a bare fetch here 401s and every
        // attachment in the app fails to open.
        const token = getToken();
        // The capability rides in a header, never the URL: URLs land in server
        // and proxy logs, headers on this authenticated route do not.
        const resp = await fetch(`${API_BASE_URL}/files/${id}`, {
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(cap ? { 'X-Puca-File-Cap': cap } : {}),
            },
        });
        if (!resp.ok) throw new Error(`fetch ${id} failed: ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        const nonce = buf.slice(0, 12);
        const ct = buf.slice(12);
        const key = await crypto.subtle.importKey('raw', fromB64url(keyB64url) as BufferSource, 'AES-GCM', false, ['decrypt']);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ct as BufferSource);
        const url = URL.createObjectURL(new Blob([pt], { type: safeBlobType(mime) }));
        blobCache.set(id, url);
        return url;
    })();
    inflight.set(id, p);
    try {
        return await p;
    } finally {
        inflight.delete(id);
    }
}

/** Revoke every cached decrypted-attachment object URL and clear the cache.
 *  Called on logout so one user's decrypted files don't linger in memory (or
 *  remain openable via their blob: URLs) for the next user on a shared session. */
export function clearBlobCache(): void {
    for (const url of blobCache.values()) {
        URL.revokeObjectURL(url);
    }
    blobCache.clear();
}
