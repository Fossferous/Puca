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
import { readAttachmentBody } from './attachmentProgress';

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

/**
 * True when `href` starts with the attachment scheme, comparing the SCHEME
 * case-insensitively.
 *
 * URL schemes are case-insensitive and `utils/messageParser.ts`'s `isSafeUrl`
 * lowercases before testing its allowlist. A case-SENSITIVE test here therefore
 * used to let `SOVEREIGN-ENC:id?k=KEY` be judged safe, skip `EncryptedAttachment`
 * entirely, and be emitted as a live `<a href>`/`<img src>` carrying the per-file
 * AES key in the DOM. One canonicalisation, used by every recogniser.
 */
export function encPrefixMatch(href: string): boolean {
    return href.slice(0, PREFIX.length).toLowerCase() === PREFIX;
}

export function isEncAttachment(href: string): boolean {
    return encPrefixMatch(href);
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

/**
 * Audio files the same engines can play, keyed by extension — the fallback
 * for a ref whose MIME says nothing (or names an audio type this list does
 * not know). `.opus` is Ogg Opus, which is what every encoder writes under
 * that name. `.weba` is WebM audio. `.webm` is deliberately NOT here: the
 * container holds video as often as audio, so an unlabelled `.webm` goes to
 * the video player (videoMimeFor), which hands an audio-only file over to
 * the audio player once its metadata shows no picture (MessageContent).
 * Deliberately absent: amr/3gp (Android's old voice recorder — Chromium
 * cannot decode AMR), wma, aiff, mid — a guaranteed-broken player is worse
 * than a chip.
 */
const AUDIO_EXT_MIME: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    weba: 'audio/webm',
};

/**
 * Real audio MIMEs worth a player, each mapped to the ONE standard name the
 * player is handed: the canonical names plus the aliases platforms actually
 * report (Windows says `audio/x-m4a` for .m4a and some registries
 * `audio/mp3`; Android has said `audio/x-wav`). The blob carries the
 * canonical name, not the alias: Chromium sniffs the bytes either way, but an
 * engine that picks its decoder from the declared type (Firefox, the
 * WebKitGTK desktop shell) may not list an alias, and would fall back to the
 * chip for a file it can play. `.opus` files are Ogg Opus, hence audio/ogg.
 * An `audio/*` type NOT listed — a playlist (`audio/x-mpegurl`), AMR, MIDI —
 * gets no player from its MIME alone; the extension may still vouch for it
 * (below), and the onError fallback catches a file that lied.
 */
const PLAYABLE_AUDIO_MIME = new Map<string, string>([
    ['audio/mpeg', 'audio/mpeg'], ['audio/mp3', 'audio/mpeg'], ['audio/mpeg3', 'audio/mpeg'], ['audio/x-mpeg', 'audio/mpeg'], ['audio/x-mp3', 'audio/mpeg'],
    ['audio/mp4', 'audio/mp4'], ['audio/x-m4a', 'audio/mp4'], ['audio/m4a', 'audio/mp4'],
    ['audio/aac', 'audio/aac'], ['audio/x-aac', 'audio/aac'], ['audio/aacp', 'audio/aac'],
    ['audio/ogg', 'audio/ogg'], ['audio/opus', 'audio/ogg'],
    ['audio/wav', 'audio/wav'], ['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav'], ['audio/vnd.wave', 'audio/wav'],
    ['audio/flac', 'audio/flac'], ['audio/x-flac', 'audio/flac'],
    ['audio/webm', 'audio/webm'],
]);

/** MIMEs that say nothing about what a file holds: the name decides. */
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'application/ogg']);

/**
 * The audio MIME to render `name` under, or null when it gets no player.
 *
 * Same shape as videoMimeFor, and the caller asks videoMimeFor FIRST (a real
 * video/* MIME, or an unlabelled video extension, is a video). Then:
 *  - a playable audio MIME wins, as its canonical name (parameters dropped:
 *    Púca Notes records `audio/webm;codecs=opus`; `audio/x-m4a` is audio/mp4);
 *  - any other audio/* falls back to the extension — an `.mp3` labelled
 *    `audio/x-mpeg-3` is still an mp3; an `.amr` is still not playable;
 *  - a MISSING or generic MIME falls back to the extension, which is how refs
 *    recorded before the upload side inferred audio types, and any browser
 *    that reports "" for a file, get their player. `application/ogg` counts
 *    as generic: it is RFC 5334's name for "some Ogg stream", which some
 *    type registries report for an `.ogg` or `.opus`;
 *  - a concrete NON-audio type (application/pdf, text/html) is respected:
 *    that file is not audio wearing a bad label, it is not audio.
 * Everything returned is a canonical value of PLAYABLE_AUDIO_MIME or
 * AUDIO_EXT_MIME — never a sender-chosen string — so the blob it types is
 * always one safeBlobType keeps as plain audio.
 */
export function audioMimeFor(name: string, mime: string): string | null {
    const m = (mime || '').toLowerCase().split(';')[0].trim();
    const canonical = PLAYABLE_AUDIO_MIME.get(m);
    if (canonical) return canonical;
    if (!GENERIC_MIME.has(m) && !m.startsWith('audio/')) return null;
    const ext = (name || '').toLowerCase().split('.').pop() ?? '';
    return AUDIO_EXT_MIME[ext] ?? null;
}

/**
 * `decodeURIComponent` that cannot throw. `URLSearchParams` has ALREADY
 * percent-decoded the value, so the second pass below only ever mattered for a
 * hypothetical double-encoded legacy ref — but it THREW on a lone '%', which
 * `m=%25` produces, and this parser runs in a render body. Falling back to the
 * raw value keeps a hostile ref renderable; `safeBlobType` reduces anything
 * unrecognised to application/octet-stream downstream.
 */
function safeDecode(v: string): string {
    try {
        return decodeURIComponent(v);
    } catch {
        return v;
    }
}

/**
 * Parse a sovereign-enc href. TOTAL: null on anything malformed, NEVER a throw.
 *
 * `MessageContent` calls this while rendering a message body that any sender
 * chooses, and when this was written the app's only error boundary was the
 * root one, so a throw here replaced the entire app with the crash screen for
 * every viewer, on every platform, on every load (0.9.810 audit, C-06).
 * `MessageErrorBoundary` now contains a render throw to one row, but this
 * parser stays total regardless: it is also called from the composer's upload
 * settle callback (Chat.tsx), where a throw is an unhandled rejection that no
 * React boundary catches. The outer catch is a deliberate backstop that no
 * current input reaches — safeDecode handles the one live throw source.
 * Mirrors `decodeClipRef`.
 */
export function parseEncAttachment(href: string): { id: string; key: string; mime: string; cap?: string } | null {
    if (!encPrefixMatch(href)) return null;
    try {
        const [id, query = ''] = href.slice(PREFIX.length).split('?');
        const params = new URLSearchParams(query);
        const key = params.get('k');
        if (!id || !key) return null;
        const cap = params.get('c');
        return {
            id,
            key,
            mime: params.get('m') ? safeDecode(params.get('m')!) : 'application/octet-stream',
            ...(cap ? { cap } : {}),
        };
    } catch {
        return null;
    }
}

/**
 * A file encrypted on this device and not yet uploaded: the ciphertext, the
 * key that opens it, and what it is called.
 *
 * The seal and the upload are separate steps so a photo taken with no
 * connection can be encrypted THE MOMENT IT IS TAKEN and the plaintext
 * dropped, with only the ciphertext parked on the device until the network
 * comes back (notes/model/notesBlobs.ts). Nothing else about the format
 * changes: `encryptAndUploadRef` below is the two steps back to back, and is
 * still what chat, DMs and task attachments call.
 */
export interface SealedFile {
    /** The AES-256-GCM key, base64url — the same string that becomes `k=`. */
    key: string;
    /** nonce(12) || ciphertext, exactly as it is uploaded. */
    blob: Blob;
    /** The real MIME, recorded in the ref's `m=`; the server never sees it. */
    mime: string;
    /** The display name, markdown-safe. */
    name: string;
}

/** Encrypt a file for upload, without uploading it. See `SealedFile`. */
export async function sealFileForUpload(file: File): Promise<SealedFile> {
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
    // The browser's guess first; when it has none (mkv famously reports ""),
    // infer video and audio types from the extension so the ref records
    // something the renderer can embed — old refs without this still get the
    // same fallback at render time (videoMimeFor / audioMimeFor).
    const mime = file.type
        || videoMimeFor(file.name || '', '')
        || audioMimeFor(file.name || '', '')
        || 'application/octet-stream';
    // Strip markdown-breaking chars from the display name (href has the real ref).
    const name = (file.name || 'attachment').replace(/[[\]()\n]/g, '_');
    return { key: b64url(keyBytes), blob, mime, name };
}

/** Upload already-sealed ciphertext and build its ref. */
export async function uploadSealedRef(sealed: SealedFile, opts?: { channelId?: number }): Promise<{ href: string; name: string; mime: string }> {
    const uploaded = await uploadFile(new File([sealed.blob], 'attachment.enc', { type: 'application/octet-stream' }), { wantCap: true, channelId: opts?.channelId });
    const href = `${PREFIX}${uploaded.id}?k=${sealed.key}&m=${encodeURIComponent(sealed.mime)}`
        + (uploaded.cap ? `&c=${encodeURIComponent(uploaded.cap)}` : '');
    return { href, name: sealed.name, mime: sealed.mime };
}

/**
 * Encrypt a file, upload the ciphertext, and return the parts of the ref:
 * the sovereign-enc href (carrying id + key + mime), the sanitized display
 * name, and the real mime. Building block for both the chat markdown form
 * (encryptAndUpload) and task attachment refs.
 */
export async function encryptAndUploadRef(file: File, opts?: { channelId?: number }): Promise<{ href: string; name: string; mime: string }> {
    return uploadSealedRef(await sealFileForUpload(file), opts);
}

/**
 * Open ciphertext this device sealed and never uploaded, as an object URL.
 * Same `safeBlobType` rule as a fetched attachment: a parked PDF is an
 * opaque binary blob, never an in-origin document.
 */
export async function decryptParkedBlobUrl(bytes: Uint8Array, keyB64url: string, mime: string): Promise<string> {
    const nonce = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const key = await crypto.subtle.importKey('raw', fromB64url(keyB64url) as BufferSource, 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ct as BufferSource);
    return URL.createObjectURL(new Blob([pt], { type: safeBlobType(mime) }));
}

/**
 * Encrypt a file, upload the ciphertext, and return the markdown to insert into
 * the message composer (image syntax for images, link syntax otherwise).
 */
export async function encryptAndUpload(file: File, opts?: { channelId?: number }): Promise<string> {
    const { href, name, mime } = await encryptAndUploadRef(file, opts);
    return `${mime.startsWith('image/') ? '!' : ''}[${name}](${href})`;
}

// Decrypted blob URLs are cached so an attachment shown in multiple places
// decrypts once.
//
// The key is `id:key:type`, NOT the bare file id, and that matters for
// correctness as well as freshness. Keyed on the id alone, a cache hit skipped
// both the fetch and `crypto.subtle.decrypt`, so the AES key stopped being
// verified: anyone who learned a file id could post
// `![x](sovereign-enc:<id>?k=<garbage>&m=image/png)` and, in any session that
// had already opened that file, the real plaintext rendered inside the
// attacker's message under their chosen name and MIME. The stored Blob type was
// likewise frozen by whichever ref decrypted first, so a later ref with a
// different `m=` got a URL whose type contradicted how the renderer treated it.
// Everything that determines the bytes and their type is in the key.
//
// STILL UNBOUNDED, deliberately, and this is the second thing to know about it.
// An LRU here is not a local change: evicting an entry is only worth anything
// if the object URL is revoked with it (an un-revoked blob: URL pins its bytes
// for the life of the document whether or not a Map still names it), and
// revoking breaks a URL that is already live. `EncryptedAttachment`
// (components/MessageContent.tsx) puts the URL in component state and only
// re-derives it when `href` or its retry counter changes — so a revoked URL is
// a permanently broken image in a row the user can still see, with no path back
// short of a remount. Bounding this needs a consumer that can notice a dead URL
// and ask again; until then the cache is cleared on logout (clearBlobCache) and
// on reload, which is what it has always relied on.
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
 *
 * The same reasoning covers every STRUCTURED-SUFFIX type, so a subtype with a
 * `+` never keeps its type in any family. `image/svg+xml` is the one we know
 * by name, but whether an engine renders some other `x/y+xml` as an XML
 * document (where an XHTML-namespace <script> runs) varies by engine, and the
 * desktop shell is not Chromium everywhere (WebKitGTK on Linux). No image,
 * video or audio format we play is spelled with a `+`, so refusing all of
 * them costs nothing. The subtype must be a plain token; anything else — an
 * empty subtype, a space, a quote — is opaque bytes.
 *
 * Audio playlist TYPES (`audio/mpegurl`, `audio/x-mpegurl`, `audio/x-scpls`)
 * are opaque bytes too, but that is hygiene, not the defence: the type does
 * NOT decide whether a player treats a file as a playlist. Measured in
 * headless Edge: HLS playlist bytes in a blob typed audio/mpeg, video/mp4,
 * audio/x-mpegurl or application/vnd.apple.mpegurl ALL made a preload=metadata
 * player fetch the segment URL inside, with no click — Chromium recognises
 * the playlist from its first bytes. What keeps a playlist away from every
 * player is `isPlaylistBlobUrl` below, which the renderers ask before they
 * mount a <video> or <audio>.
 */
const MEDIA_TYPE_RE = /^(image|video|audio)\/[a-z0-9][a-z0-9!#$&^_.-]*$/;
const AUDIO_PLAYLIST_RE = /^audio\/(x-)?(mpegurl|scpls)$/;
export function safeBlobType(mime: string): string {
    const m = (mime || '').toLowerCase().split(';')[0].trim();
    if (m === 'image/svg+xml') return 'application/octet-stream';
    if (!MEDIA_TYPE_RE.test(m) || AUDIO_PLAYLIST_RE.test(m)) return 'application/octet-stream';
    return m;
}

/**
 * Does this plaintext open as an HLS playlist (`#EXTM3U`)?
 *
 * A playlist is a list of OTHER URLs, and a media element handed one goes
 * and fetches them: the sender's server learns the reader's IP and the moment
 * they opened the channel, with no click, past "Load remote images", and the
 * player then fails to the download chip so nothing on screen shows it.
 * Engines decide that from the BYTES, not the blob's type (see safeBlobType),
 * so the only place to stop it is here, while the plaintext is in hand.
 *
 * Measured in Edge: `#EXTM3U` at byte 0 plus an `#EXT-X-` tag fetched; a
 * plain m3u (no `#EXT-X-` tag) did not. This check is deliberately looser,
 * since a false positive only costs a player on a file that was never audio
 * or video: any case, after a UTF-8 BOM, whitespace, or ID3v2 tags (media
 * probes such as FFmpeg's skip an ID3 tag before deciding what a stream is;
 * not measured for HLS on any engine), and with or without the `#EXT-X-`
 * tags (a plain m3u is not media either).
 */
export function looksLikeHlsPlaylist(bytes: Uint8Array): boolean {
    let i = 0;
    for (let guard = 0; guard < 8; guard++) {
        if (bytes[i] === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) i += 3;
        while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
        // ID3v2: "ID3", version (2), flags (1), size (4 bytes, 7 bits each);
        // flag 0x10 means a 10-byte footer follows the tag.
        if (i + 10 <= bytes.length && bytes[i] === 0x49 && bytes[i + 1] === 0x44 && bytes[i + 2] === 0x33) {
            const size = ((bytes[i + 6] & 0x7f) << 21) | ((bytes[i + 7] & 0x7f) << 14) | ((bytes[i + 8] & 0x7f) << 7) | (bytes[i + 9] & 0x7f);
            i += 10 + size + ((bytes[i + 5] & 0x10) ? 10 : 0);
            continue;
        }
        break;
    }
    const sig = '#extm3u';
    if (i + sig.length > bytes.length) return false;
    for (let j = 0; j < sig.length; j++) {
        const b = bytes[i + j];
        const lower = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
        if (lower !== sig.charCodeAt(j)) return false;
    }
    return true;
}

/** Blob URLs (from decryptToBlobUrl) whose plaintext is a playlist. */
const playlistUrls = new Set<string>();

/**
 * Is `url` a decrypted attachment that must never be handed to a media
 * element? Every renderer that would mount a <video> or <audio> for an
 * attachment asks this first and shows the download button instead
 * (MessageContent's EncryptedAttachment, TaskAttachments, NoteImages).
 */
export function isPlaylistBlobUrl(url: string | null | undefined): boolean {
    return !!url && playlistUrls.has(url);
}

/** Concurrent mounts of the same attachment share one fetch+decrypt — a row
 *  remount (e.g. the optimistic→server id swap) otherwise pulls the multi-MB
 *  ciphertext twice, which on a phone right after its own upload is exactly
 *  when the link has no headroom. Same shape as authedMedia's inflight map. */
const inflight = new Map<string, Promise<string>>();

export async function decryptToBlobUrl(id: string, keyB64url: string, mime: string, cap?: string): Promise<string> {
    const cacheKey = `${id}:${keyB64url}:${safeBlobType(mime)}`;
    const cached = blobCache.get(cacheKey);
    if (cached) return cached;
    const pending = inflight.get(cacheKey);
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
        const buf = await readAttachmentBody(id, resp); // its progress shows while it downloads (AttachmentLoading)
        const nonce = buf.slice(0, 12);
        const ct = buf.slice(12);
        const key = await crypto.subtle.importKey('raw', fromB64url(keyB64url) as BufferSource, 'AES-GCM', false, ['decrypt']);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ct as BufferSource);
        // A playlist is not media, whatever the ref says: opaque bytes, and
        // flagged so no renderer gives it a player (looksLikeHlsPlaylist).
        const playlist = looksLikeHlsPlaylist(new Uint8Array(pt));
        const url = URL.createObjectURL(new Blob([pt], { type: playlist ? 'application/octet-stream' : safeBlobType(mime) }));
        if (playlist) playlistUrls.add(url);
        blobCache.set(cacheKey, url);
        return url;
    })();
    inflight.set(cacheKey, p);
    try {
        return await p;
    } finally {
        inflight.delete(cacheKey);
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
    playlistUrls.clear();
}
