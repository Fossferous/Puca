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
import { uploadFile, assertUploadable, ENCRYPTED_OVERHEAD_BYTES, MAX_UPLOAD_BYTES } from './uploads';
import { API_BASE_URL } from './config';
import { getToken } from './auth';
import { readAttachmentBody } from './attachmentProgress';
import { createPriorityLimiter, abortError, isAbortError } from './priorityLimiter';
import { readVideoDims, type VideoDims } from './videoDims';
import { hostPlaintext, dropAllPlaintext, freeNow, type PlainLease } from './plaintextHost';
import { keepCipher, dropAllCiphertext, type CipherCopy } from './cipherStore';

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

/**
 * A file's plaintext as bytes, with its name and type: what an attachment
 * decrypted only to be sealed again under a fresh key (a message captured
 * into a note, a note copied) is handed over as. Never wrapped in a File: a
 * File made from bytes is a page Blob, and the engine writes a page's blobs
 * beyond its in-memory limit (1% of the RAM in the Android WebView) to
 * `blob_storage` as they are, where the plaintext stays until the page next
 * collects garbage (docs/SECURITY_MODEL.md, *Decrypted attachments on your
 * own storage*). The caller owns `bytes`, and may free them (freeNow) once
 * the seal is done.
 */
export interface PlainBytes {
    bytes: Uint8Array;
    name: string;
    type: string;
}

// Not `'bytes' in f`: a File has a bytes() method of its own in newer engines.
const isPlainBytes = (f: File | PlainBytes): f is PlainBytes => ArrayBuffer.isView((f as PlainBytes).bytes);

/** Encrypt a file for upload, without uploading it. See `SealedFile`. */
export async function sealFileForUpload(file: File | PlainBytes): Promise<SealedFile> {
    const given = isPlainBytes(file) ? file.bytes : null;
    // Check BEFORE reading and encrypting: uploadFile checks too, but by then we
    // have already pulled the whole file into memory and encrypted it. Account
    // for what encryption adds, or a file of exactly the cap fails at the server.
    assertUploadable({ name: file.name, size: given ? given.byteLength : (file as File).size }, ENCRYPTED_OVERHEAD_BYTES);
    const raw = given ?? new Uint8Array(await (file as File).arrayBuffer());
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
 * (encryptAndUpload) and task attachment refs. Plaintext the app decrypted
 * itself comes as bytes (PlainBytes), never as a File made from them.
 */
export async function encryptAndUploadRef(file: File | PlainBytes, opts?: { channelId?: number }): Promise<{ href: string; name: string; mime: string }> {
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

// Fetched attachments are cached so one shown in several places, or shown
// again, downloads once.
//
// WHAT the cache keeps is the CIPHERTEXT, exactly as fetched. The plaintext
// exists only while something shows it: a blob: URL made in a plaintext host
// worker (api/plaintextHost.ts) when the first holder takes the entry, and
// taken back — the worker terminated, its blobs and any file Chromium paged
// them to gone at once — when the last holder lets go. A copy kept for coming
// back is decrypted again then (from the ciphertext in the cache: no second
// download). Measured 2026-10-05, before this: the Android WebView wrote 79 of
// 85 MB of a small channel's decrypted pictures and videos to
// app_webview/Default/blob_storage as they were, kept them there while the
// app sat in the background, and left them after a crash until the next
// start; on desktop the same happens under memory pressure. The ciphertext is
// kept in the origin-private file system (api/cipherStore.ts), never as a
// Blob: Chromium writes several blobs into one page file and keeps the file
// while any of them lives, so a cached ciphertext Blob kept a picture's
// plaintext on disk after the picture had gone (measured).
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
// BOUNDED for the attachments in messages, and only for them. An entry (its
// ciphertext) is evicted only when nobody can be showing it:
//  - `acquireAttachmentUrl` (MessageContent's EncryptedAttachment) HOLDS an
//    entry while it is on or near the screen and releases it, after its
//    <img>/<video> has left the DOM, when it scrolls far away, the channel is
//    left, or the app has been in the background a moment (attachmentAwake).
//    The first holder gets the plaintext URL, the last one to let go takes it
//    back. Released entries (copies the reader has SEEN) stay cached, as
//    ciphertext, up to RETAINED_ATTACHMENT_BYTES, so coming back to a channel
//    downloads nothing; past that, dropped: the oldest messages of each
//    channel left first (releaseBurst), then the ones nothing on the page
//    shows any more (noteAttachmentInterest), then the least recently given
//    back. Taking back a URL that is still on screen would be a permanently
//    broken image, which is why only the last holder's release does it.
//  - `prefetchAttachmentUrl` loads a message attachment that is still far
//    from the screen, after everything nearer, so one the reader scrolls to
//    later is already here, as it was when everything loaded at once. Those
//    copies (loaded AHEAD, not yet seen) have their own budget,
//    AHEAD_ATTACHMENT_BYTES, which it never goes past and in which it never
//    pushes out another of the page's own; a copy the reader has seen is
//    never pushed out to load ahead (measured: when one budget was shared,
//    loading ahead in one channel pushed out the copies of the channel just
//    left, and going back to it downloaded again what had been on screen).
//    It decrypts the file once, to check the key and read what the page
//    needs before it is shown (a video's picture size, whether it is a
//    playlist), and keeps only the ciphertext.
//  - Tasks and Notes hold their pictures and voice notes the same way, while
//    they are shown (components/useHeldAttachmentUrl.ts); they used to pin
//    them, plaintext URL included, until sign-out (decryptToBlobUrl, gone).
//    `decryptAttachmentBytes` holds an entry only while it reads it.
// Measured before the bound (2026-10-05, headless Edge, a channel of 12 x
// 22.5 MB videos): the browser process kept +257 MB per such channel opened
// and never gave it back while the app ran (515 MB after two). Sign-out
// still clears everything (clearBlobCache), as does a reload.
interface CacheEntry {
    /** The file as fetched, nonce(12) || AES-GCM ciphertext: in OPFS once it
     *  is written there, never as a Blob (api/cipherStore.ts says why). */
    cipher: CipherCopy;
    keyB64url: string;
    /** The type the plaintext is hosted under (safeBlobType, or opaque bytes
     *  for a playlist). */
    type: string;
    /** The plaintext opens as a playlist (looksLikeHlsPlaylist). */
    playlist: boolean;
    /** Plaintext size: what the budgets count. */
    bytes: number;
    /** The plaintext URL, while anyone holds or pins the entry. */
    plain: PlainLease | null;
    /** The plaintext on its way to a host (openPlain). */
    opening: Promise<PlainLease> | null;
    /** The plaintext the load just decrypted, for a holder that took the
     *  entry in the same task (so a file shown as it arrives is decrypted
     *  once); dropped at the end of that task. */
    fresh: ArrayBuffer | null;
    /** Holders showing it now (acquireAttachmentUrl). Never evicted while > 0. */
    refs: number;
    /** Has been held (shown) at least once; else it was loaded ahead. */
    seen: boolean;
    /** When it was loaded, last taken or last given back (useSeq): the
     *  lowest goes first. A counter, not a clock: a channel left gives all
     *  its copies back in one millisecond, top row first, and the newest
     *  (what is on screen when you come back) must be the ones kept. */
    seq: number;
    /** The burst it was last given back in (releaseBurst): every copy a
     *  channel gives back as it is left shares one. 0 if never given back. */
    burst: number;
}
const blobCache = new Map<string, CacheEntry>();
let useSeq = 0;

/** Copies given back in one task (a channel being left: every row unmounts
 *  in one commit) share a burst. Eviction goes by how deep a copy sits in its
 *  burst — the oldest message of each channel first — before it goes by age,
 *  so the newest few of EVERY channel left are kept, not all of the last one:
 *  measured 2026-10-05 with two channels of 12 x 22.5 MB videos, plain
 *  least-recently-used dropped every copy of the first channel when the
 *  second was left, and going back to it downloaded the two on screen again
 *  (4.2 s at 100 Mbit; 0.3 s when everything was kept). */
let releaseBurst = 0;
let burstOpen = false;
function currentBurst(): number {
    if (!burstOpen) {
        burstOpen = true;
        releaseBurst++;
        setTimeout(() => { burstOpen = false; }, 0);
    }
    return releaseBurst;
}

/** Bytes kept (as ciphertext) for message attachments the reader has seen
 *  and nobody is showing now (see above): a little over seven 25 MB videos
 *  (the upload cap). */
export const RETAINED_ATTACHMENT_BYTES = 192 * 1024 * 1024;
/** Bytes loaded ahead of the reader, as ciphertext (prefetchAttachmentUrl). */
export const AHEAD_ATTACHMENT_BYTES = 192 * 1024 * 1024;
let retainedBudget = RETAINED_ATTACHMENT_BYTES;
let aheadBudget = AHEAD_ATTACHMENT_BYTES;
/** Tests only: other budgets (null restores the real one), so eviction can
 *  be seen without 192 MB of files. */
export function __setRetainedAttachmentBudget(bytes: number | null): void {
    retainedBudget = bytes ?? RETAINED_ATTACHMENT_BYTES;
}
export function __setAheadAttachmentBudget(bytes: number | null): void {
    aheadBudget = bytes ?? AHEAD_ATTACHMENT_BYTES;
}

/** Message attachments on the page now, per cache key
 *  (noteAttachmentInterest): an unheld copy one of them may scroll back to
 *  is kept before one nothing shows any more, and only those count against
 *  what may still be loaded ahead. */
const interest = new Map<string, number>();


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

/** Plaintext URLs handed out now whose bytes are a playlist. */
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
const inflight = new Map<string, Promise<CacheEntry>>();
/** Callers between asking for an entry and taking it: never evicted then. */
const claiming = new Map<string, number>();
/** Bumped by clearBlobCache (sign-out). A load that began before it is not
 *  cached after it, and nobody retries across it. */
let cacheGeneration = 0;

const cacheKeyOf = (id: string, keyB64url: string, mime: string) => `${id}:${keyB64url}:${safeBlobType(mime)}`;

async function importKey(keyB64url: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', fromB64url(keyB64url) as BufferSource, 'AES-GCM', false, ['decrypt']);
}

/** nonce(12) || ciphertext -> plaintext. Views, not copies: WebCrypto copies
 *  its input anyway, and a .slice() here held one more full copy of a 25 MB
 *  file for the length of the call. */
async function openSealed(sealed: Uint8Array, keyB64url: string): Promise<ArrayBuffer> {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) as BufferSource }, await importKey(keyB64url), sealed.subarray(12) as BufferSource);
}

/** The fetch + first decrypt; the entry (ciphertext) is cached before it is
 *  returned, with the plaintext as `fresh` for a holder in the same task. */
async function loadEntry(cacheKey: string, id: string, keyB64url: string, mime: string, cap?: string): Promise<CacheEntry> {
    const generation = cacheGeneration;
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
    // Decrypted once here whatever happens next: a wrong key fails now, not
    // when the reader scrolls to it.
    const pt = await openSealed(buf, keyB64url);
    // Signed out while it downloaded: the plaintext is not the next user's
    // to find in the cache (or by its blob: URL).
    if (generation !== cacheGeneration) throw abortError();
    // A playlist is not media, whatever the ref says: opaque bytes, and
    // flagged so no renderer gives it a player (looksLikeHlsPlaylist).
    const plain = new Uint8Array(pt);
    const playlist = looksLikeHlsPlaylist(plain);
    // A video's picture size, from its header, for the box it takes before
    // (or without) a player: attachmentPictureSize.
    if (!playlist && safeBlobType(mime).startsWith('video/') && !pictureSizes.has(id)) {
        const dims = readVideoDims(plain);
        if (dims) pictureSizes.set(id, dims);
    }
    const entry: CacheEntry = {
        cipher: keepCipher(buf),
        keyB64url,
        type: playlist ? 'application/octet-stream' : safeBlobType(mime),
        playlist,
        bytes: pt.byteLength,
        plain: null,
        opening: null,
        fresh: pt,
        refs: 0, seen: false, seq: ++useSeq, burst: 0,
    };
    // Nobody took it in this task (a load ahead, or a holder that went away):
    // only the ciphertext stays, and the plaintext's memory goes now rather
    // than at the next garbage collection.
    setTimeout(() => {
        const left = entry.fresh;
        entry.fresh = null;
        freeNow(left);
    }, 0);
    blobCache.set(cacheKey, entry);
    return entry;
}

/**
 * The entry's plaintext URL, decrypting and hosting it if nobody has it now.
 * Only for an entry that is held (the caller took it first), so
 * nothing evicts it meanwhile; one call at a time per entry (`opening`).
 */
function openPlain(e: CacheEntry): Promise<PlainLease> {
    if (e.plain) return Promise.resolve(e.plain);
    if (e.opening) return e.opening;
    const generation = cacheGeneration;
    const p = (async () => {
        let pt = e.fresh;
        e.fresh = null;
        if (!pt) {
            const sealed = await e.cipher.read();
            pt = await openSealed(sealed, e.keyB64url);
            freeNow(sealed.buffer as ArrayBuffer);
        }
        // Signed out meanwhile: no URL for the next user to find.
        if (generation !== cacheGeneration) throw abortError();
        // Copied into the hosted Blob and emptied (freeNow).
        const lease = await hostPlaintext(pt, e.type);
        if (generation !== cacheGeneration) { lease.release(); throw abortError(); }
        return lease;
    })();
    e.opening = p.then(
        (lease) => {
            e.opening = null;
            e.plain = lease;
            if (e.playlist) playlistUrls.add(lease.url);
            return lease;
        },
        (err) => {
            e.opening = null;
            // Its cached ciphertext could not be read back (its file went):
            // forget the entry, so the next try downloads it again.
            if (!isAbortError(err)) {
                for (const [k, v] of blobCache) if (v === e) { blobCache.delete(k); e.cipher.drop(); }
            }
            throw err;
        },
    );
    return e.opening;
}

/** Nobody holds it: take its plaintext URL back (its host worker goes, and
 *  the page is nudged to collect: api/plaintextHost.ts). */
function dropPlainIfIdle(e: CacheEntry): void {
    if (e.refs > 0 || !e.plain) return;
    playlistUrls.delete(e.plain.url);
    e.plain.release();
    e.plain = null;
}

/** The cached entry, the load already under way, or a new one from `start`. */
function getOrLoad(cacheKey: string, start: () => Promise<CacheEntry>): Promise<CacheEntry> {
    const cached = blobCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    // Forget the load in ITS settle, which runs before anyone awaiting `p`
    // resumes: a waiter that retries after an abort must not find it again.
    // (Only its own entry: sign-out empties the map, and a later load of the
    // same file may be in it by the time this one settles.)
    const forget = () => { if (inflight.get(cacheKey) === p) inflight.delete(cacheKey); };
    const p: Promise<CacheEntry> = start().then(
        (e) => { forget(); return e; },
        (err) => { forget(); throw err; },
    );
    inflight.set(cacheKey, p);
    return p;
}

/** getOrLoad, then `take` the entry in the same tick it arrives, before
 *  anything else (a release elsewhere) could evict it. */
async function claim(cacheKey: string, start: () => Promise<CacheEntry>, take: (e: CacheEntry) => void): Promise<CacheEntry> {
    claiming.set(cacheKey, (claiming.get(cacheKey) ?? 0) + 1);
    try {
        const e = await getOrLoad(cacheKey, start);
        take(e);
        return e;
    } finally {
        const n = (claiming.get(cacheKey) ?? 1) - 1;
        if (n > 0) claiming.set(cacheKey, n); else claiming.delete(cacheKey);
    }
}

/**
 * claim, again when the load it joined was dropped for someone else: a
 * message attachment that was still waiting for a fetch slot when its row
 * scrolled away (acquireAttachmentUrl's `signal`) takes its waiting load with
 * it, and whoever else was riding on that load still wants the file. Never
 * when `own` (this caller's signal) aborted, and never across a sign-out.
 */
async function claimForCaller(cacheKey: string, start: () => Promise<CacheEntry>, take: (e: CacheEntry) => void, own?: AbortSignal): Promise<CacheEntry> {
    const generation = cacheGeneration;
    for (let tries = 0; ; tries++) {
        try {
            return await claim(cacheKey, start, take);
        } catch (err) {
            if ((isAbortError(err) || isSkipped(err)) && !own?.aborted && generation === cacheGeneration && tries < 4) continue;
            throw err;
        }
    }
}

/** A load ahead that found no room when its turn came (prefetchAttachmentUrl):
 *  nobody else's business, so anyone riding on it queues its own. */
function skippedError(): Error {
    const e = new Error('No room to load this attachment ahead.');
    e.name = 'AttachmentPrefetchSkipped';
    return e;
}
function isSkipped(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AttachmentPrefetchSkipped';
}

/** Drop unheld entries until the copies seen fit RETAINED_ATTACHMENT_BYTES
 *  and the copies loaded ahead fit AHEAD_ATTACHMENT_BYTES, each on its own:
 *  the deepest in their burst first, then those no attachment on the page
 *  shows, then the lowest `seq`. Held and being-claimed entries stay. */
function enforceRetainedBudget(): void {
    const seen: Array<[string, CacheEntry]> = [];
    const ahead: Array<[string, CacheEntry]> = [];
    for (const [k, e] of blobCache) {
        if (e.refs > 0 || claiming.has(k)) continue;
        (e.seen ? seen : ahead).push([k, e]);
    }
    trimTo(seen, retainedBudget);
    trimTo(ahead, aheadBudget);
}

function trimTo(pool: Array<[string, CacheEntry]>, budget: number): void {
    let kept = pool.reduce((n, [, e]) => n + e.bytes, 0);
    if (kept <= budget) return;
    // How many in the same burst were given back after it (0: the newest).
    const depth = new Map<CacheEntry, number>();
    for (const [, e] of pool) {
        if (!e.burst) { depth.set(e, 0); continue; }
        let d = 0;
        for (const [, o] of pool) if (o.burst === e.burst && o.seq > e.seq) d++;
        depth.set(e, d);
    }
    const onPage = (k: string) => (interest.has(k) ? 1 : 0);
    pool.sort((a, b) => depth.get(b[1])! - depth.get(a[1])! || onPage(a[0]) - onPage(b[0]) || a[1].seq - b[1].seq);
    for (const [k, e] of pool) {
        if (kept <= budget) break;
        blobCache.delete(k);
        // Unheld, so its plaintext went with its last holder; this is the
        // ciphertext.
        dropPlainIfIdle(e);
        e.cipher.drop();
        kept -= e.bytes;
    }
}

/**
 * An attachment's plaintext as bytes, for code that reads a file rather than
 * showing it (a message captured into a note, a note copied, a drawing's
 * strokes): no URL is made and nothing stays decrypted here (what these used,
 * decryptToBlobUrl, kept a URL for each until sign-out). The bytes are the
 * caller's: keep them bytes (seal them as PlainBytes, decode them as text),
 * never a File or Blob, or they are in the engine's blob storage after all,
 * and free them (freeNow) when done. The cache keeps the ciphertext as for
 * any load.
 */
export async function decryptAttachmentBytes(id: string, keyB64url: string, mime: string, cap?: string): Promise<Uint8Array> {
    const cacheKey = cacheKeyOf(id, keyB64url, mime);
    let fresh: ArrayBuffer | null = null;
    // Held while it is read, so nothing evicts it meanwhile.
    const e = await claimForCaller(cacheKey, () => loadEntry(cacheKey, id, keyB64url, mime, cap), (entry) => {
        entry.refs++;
        fresh = entry.fresh;
        entry.fresh = null;
    });
    try {
        if (fresh) return new Uint8Array(fresh);
        const sealed = await e.cipher.read();
        const pt = await openSealed(sealed, e.keyB64url);
        freeNow(sealed.buffer as ArrayBuffer);
        return new Uint8Array(pt);
    } finally {
        e.refs = Math.max(0, e.refs - 1);
        dropPlainIfIdle(e);
        enforceRetainedBudget();
    }
}

/** A held attachment URL: valid until `release()`, which the holder calls only
 *  once nothing it renders uses the URL any more. A second call does nothing. */
export interface AttachmentHold {
    url: string;
    release: () => void;
}

/**
 * How many fetch+decrypts run at once. A video (or any other file) can be the
 * full 25 MB, so two: the one on screen gets the link instead of sharing it
 * with the whole channel, and the renderer never holds more than two files'
 * sealed and opened copies at once. Pictures are usually small and many to a
 * screen, so they get their own four.
 */
const heavyLimiter = createPriorityLimiter(2);
const lightLimiter = createPriorityLimiter(4);
const limiterFor = (mime: string) => (safeBlobType(mime).startsWith('image/') ? lightLimiter : heavyLimiter);
/**
 * Decrypting a cached copy again (reading its ciphertext back and opening
 * it) is CPU work, so it takes its turn too, the closest first, apart from
 * the downloads (which wait on the network). Measured on the 2 GB emulator,
 * going back to a channel of 12 x 22 MB videos: six copies opened at once
 * took 600-700 ms each and the first on screen showed after 4.9 s, where
 * the same six one or two at a time take 70-140 ms each; with this, the
 * ones on screen showed after 2.3 s (2.1 s when the cache still kept them
 * decrypted). Not one at a time: going back to that channel took the
 * renderer to 291-328 MB with one, 291-346 MB with two (6 rounds each,
 * 2026-10-05; 152-204 MB in the other channel just before), with the first
 * on screen ready at 1.46-1.65 s either way.
 */
const heavyOpenLimiter = createPriorityLimiter(2);
const lightOpenLimiter = createPriorityLimiter(4);
const openLimiterFor = (mime: string) => (safeBlobType(mime).startsWith('image/') ? lightOpenLimiter : heavyOpenLimiter);

/**
 * Hold an attachment's decrypted URL while it is shown (MessageContent's
 * EncryptedAttachment; Tasks and Notes through useHeldAttachmentUrl):
 *  - the fetch waits for one of a few slots, and the most urgent waiting
 *    attachment (`urgency`: lowest first, asked when a slot frees; the
 *    distance from the screen) goes first;
 *  - aborting `signal` while it still waits drops it (rejects AbortError);
 *  - `release()` it once it is no longer shown. The last holder's release
 *    takes the plaintext URL back at once (every holder of one file shares
 *    one URL), and the ciphertext joins the RETAINED_ATTACHMENT_BYTES
 *    budget; taken again, it is decrypted again, into a NEW URL.
 */
export async function acquireAttachmentUrl(
    id: string,
    keyB64url: string,
    mime: string,
    cap?: string,
    opts: { urgency?: () => number; signal?: AbortSignal } = {},
): Promise<AttachmentHold> {
    const { urgency = () => 0, signal } = opts;
    if (signal?.aborted) throw abortError();
    const cacheKey = cacheKeyOf(id, keyB64url, mime);
    const limiter = limiterFor(mime);
    const start = () => limiter.schedule({ run: () => loadEntry(cacheKey, id, keyB64url, mime, cap), urgency, signal });
    const take = (e: CacheEntry) => {
        if (signal?.aborted) return;
        e.refs++;
        e.seen = true;
        e.seq = ++useSeq;
    };
    const entry = await claimForCaller(cacheKey, start, take, signal);
    if (signal?.aborted) {
        // It arrived just as we stopped wanting it: cached, unheld.
        enforceRetainedBudget();
        throw abortError();
    }
    // Held from here: give it back if the plaintext does not come, or comes
    // after we stopped wanting it.
    const letGo = () => {
        entry.refs = Math.max(0, entry.refs - 1);
        dropPlainIfIdle(entry);
        enforceRetainedBudget();
    };
    let lease: PlainLease;
    try {
        // Shown already, or just decrypted by its download: at once. A copy
        // from the cache is decrypted again, in its turn (openLimiterFor).
        lease = entry.plain || entry.fresh || entry.opening
            ? await openPlain(entry)
            : await openLimiterFor(mime).schedule({ run: () => openPlain(entry), urgency, signal });
    } catch (err) {
        letGo();
        throw err;
    }
    if (signal?.aborted) {
        letGo();
        throw abortError();
    }
    let held = true;
    return {
        url: lease.url,
        release: () => {
            if (!held) return;
            held = false;
            entry.refs = Math.max(0, entry.refs - 1);
            entry.seq = ++useSeq;
            entry.burst = currentBurst();
            if (entry.refs === 0) {
                // The last one showing it: the plaintext goes now, the
                // ciphertext stays within the budget.
                dropPlainIfIdle(entry);
                enforceRetainedBudget();
            }
        },
    };
}

/**
 * A message attachment for this file is on the page, until the returned
 * function is called (MessageContent's EncryptedAttachment, for as long as it
 * is mounted). Its unheld copy is then kept before one nothing on the page
 * shows any more, and prefetchAttachmentUrl counts it as the page's own.
 */
export function noteAttachmentInterest(id: string, keyB64url: string, mime: string): () => void {
    const k = cacheKeyOf(id, keyB64url, mime);
    interest.set(k, (interest.get(k) ?? 0) + 1);
    let noted = true;
    return () => {
        if (!noted) return;
        noted = false;
        const n = (interest.get(k) ?? 1) - 1;
        if (n > 0) interest.set(k, n); else interest.delete(k);
    };
}

/** Is there room for one more file loaded ahead for the page, in
 *  AHEAD_ATTACHMENT_BYTES? Copies loaded ahead for rows no longer on the page
 *  do not count (they go first), and copies seen are not in this budget. */
function roomToPrefetch(): boolean {
    let onPage = 0;
    for (const [k, e] of blobCache) {
        if (e.refs === 0 && !e.seen && interest.has(k)) onPage += e.bytes;
    }
    return onPage + MAX_UPLOAD_BYTES <= aheadBudget;
}

/**
 * Load a message attachment that is still far from the screen into the cache,
 * unheld, so it is already here when the reader scrolls to it — as every
 * attachment was when they all loaded at once. It goes after everything
 * nearer (`urgency`, as for acquireAttachmentUrl), never in the last free
 * fetch slot (a `background` job: one is always left for a file the reader
 * scrolls to), and only while the page's copies loaded ahead leave room for
 * one more file in AHEAD_ATTACHMENT_BYTES, judged when its turn comes: it
 * may push out a copy loaded ahead for a row no longer on the page, never a
 * copy the reader has seen. Resolves when it is here, skipped, failed or
 * aborted (`signal`: the row came near and holds it, or left the page); a
 * skipped one loads when it comes near, as one that failed does.
 */
export async function prefetchAttachmentUrl(
    id: string,
    keyB64url: string,
    mime: string,
    cap?: string,
    opts: { urgency?: () => number; signal?: AbortSignal } = {},
): Promise<void> {
    const { urgency = () => 0, signal } = opts;
    const cacheKey = cacheKeyOf(id, keyB64url, mime);
    const generation = cacheGeneration;
    const run = () => (roomToPrefetch() ? loadEntry(cacheKey, id, keyB64url, mime, cap) : Promise.reject(skippedError()));
    for (let tries = 0; ; tries++) {
        if (signal?.aborted || blobCache.has(cacheKey)) return;
        try {
            await getOrLoad(cacheKey, () => limiterFor(mime).schedule({ run, urgency, signal, background: true }));
            break;
        } catch (err) {
            // The load it joined was dropped for someone else — typically this
            // very row's own wait for a slot, dropped as the row scrolled out
            // of range, a moment before this load ahead replaced it (measured:
            // giving up then left two of twelve videos never loaded). Queue
            // its own. Skipped (no room), failed or aborted itself: done.
            if (isAbortError(err) && !signal?.aborted && generation === cacheGeneration && tries < 4) continue;
            return;
        }
    }
    enforceRetainedBudget();
}

/** What the cache holds now, in bytes of plaintext (tests, diagnostics):
 *  shown now, seen and given back, loaded ahead and not yet seen — and how
 *  much of it is decrypted right now (`plainBytes`: only what is held
 *  should be). */
export function attachmentCacheStats(): { entries: number; heldBytes: number; retainedBytes: number; aheadBytes: number; plainBytes: number } {
    let heldBytes = 0, retainedBytes = 0, aheadBytes = 0, plainBytes = 0;
    for (const e of blobCache.values()) {
        if (e.refs > 0) heldBytes += e.bytes;
        else if (e.seen) retainedBytes += e.bytes;
        else aheadBytes += e.bytes;
        if (e.plain) plainBytes += e.bytes;
    }
    return { entries: blobCache.size, heldBytes, retainedBytes, aheadBytes, plainBytes };
}

/**
 * Picture sizes of message videos, by file id: read from each file's header
 * as it is decrypted (api/videoDims.ts), replaced by what a player reports
 * (noteAttachmentPictureSize). MessageContent gives a video that has no
 * player (only the few closest to the screen have one) its player's box, so
 * giving it a player moves nothing. A few numbers per file, kept until
 * sign-out; they outlive an evicted copy, so one loaded again keeps its
 * space while it downloads.
 */
const pictureSizes = new Map<string, VideoDims>();

export function attachmentPictureSize(id: string): VideoDims | null {
    return pictureSizes.get(id) ?? null;
}

/** What a player showed for this file (its videoWidth x videoHeight). */
export function noteAttachmentPictureSize(id: string, dims: VideoDims): void {
    if (dims.width > 0 && dims.height > 0) pictureSizes.set(id, { width: dims.width, height: dims.height });
}

/** Take back every decrypted-attachment URL (every plaintext host worker
 *  goes) and clear the cache. Called on logout so one user's decrypted files
 *  don't linger in memory (or remain openable via their blob: URLs) for the
 *  next user on a shared session. Attachments still waiting for a fetch slot
 *  are dropped too, and one still downloading is not cached when it lands
 *  (cacheGeneration). */
export function clearBlobCache(): void {
    cacheGeneration++;
    for (const e of blobCache.values()) {
        e.plain?.release();
        e.plain = null;
        e.fresh = null;
        e.cipher.drop();
    }
    dropAllPlaintext();
    dropAllCiphertext();
    blobCache.clear();
    inflight.clear();
    playlistUrls.clear();
    pictureSizes.clear();
    heavyLimiter.clear();
    lightLimiter.clear();
    heavyOpenLimiter.clear();
    lightOpenLimiter.clear();
}
