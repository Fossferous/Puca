import { activeSessions } from './session';

export interface FsEntry {
    name: string;
    is_dir: boolean;
    size: number;
}

export interface FsResponse {
    ok?: string;
    roots?: string[];
    entries?: FsEntry[];
    /** The directory had more than the host's cap; `entries` is the first
     *  page. Absent from an agent that predates the cap (reads as false). */
    truncated?: boolean;
    data?: string;
    len?: number;
    message?: string;
    /** Echo of the request's id. Absent from an agent that predates ids. */
    id?: number;
}

/** MUST stay under the agent's `MAX_READ_LEN`/`MAX_WRITE_LEN` ceiling (64 KiB).
 *
 *  16 KiB, not the full 64: one reply is base64-in-JSON, so a 64 KiB chunk was
 *  ~87 KB on the wire against str0m's 128 KiB send budget SHARED ACROSS ALL
 *  STREAMS — and that budget only frees on the peer's SACK. The moment ~44 KB
 *  was still unacked (routine on any real link mid-transfer), the next reply
 *  did not fit and the agent dropped it on the floor: every download of a real
 *  file stalled into "the other computer did not answer" while directory
 *  listings, being small, worked — exactly the shape the field report
 *  described. A 16 KiB chunk is ~22 KB framed, small enough that the budget
 *  cannot be exhausted by one in-flight reply plus one unacked predecessor. */
export const FS_CHUNK = 16 * 1024;

/** A reply that never comes must not hang the file browser forever.
 *
 *  Reachable in practice: a host whose backend cannot serve files at all
 *  answers nothing, and the agent silently drops a reply that does not fit the
 *  channel buffer. */
const FS_TIMEOUT_MS = 15_000;

/**
 * One request at a time, per session — AND every request carries an id.
 *
 * Serialising alone made "the next message is my answer" true only while no
 * reply was ever late: after a 15s timeout tore the listener down, the late
 * reply was consumed by the FOLLOWING request, and every answer was off by
 * one from then on. A mismatched Data reply decodes as zero bytes, zero bytes
 * read as EOF, and the download saved a TRUNCATED file under the real name
 * with no error — silent corruption, not a failure. The id lets a listener
 * discard a stale reply and keep waiting for its own; a reply with no id at
 * all comes from an agent that predates ids and is accepted as before.
 */
const chains = new Map<string, Promise<unknown>>();

/** Monotonic per-page request id. Uniqueness within one session's lifetime is
 *  all that matters; the value itself is meaningless. */
let nextFsRequestId = 1;

function enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const prev = chains.get(sessionId) ?? Promise.resolve();
    // Swallow the predecessor's rejection so one failed command does not
    // poison every later one on the same session.
    const next = prev.then(job, job);
    chains.set(sessionId, next.catch(() => undefined));
    return next;
}

function sendOne(sessionId: string, cmd: Record<string, unknown>): Promise<FsResponse> {
    const s = activeSessions().find(x => x.id === sessionId);
    if (!s || !s.filesChannel) return Promise.reject(new Error('File transfer is not connected'));
    const dc = s.filesChannel;
    if (dc.readyState !== 'open') {
        return Promise.reject(new Error('File transfer is not connected'));
    }

    const id = nextFsRequestId++;
    return new Promise<FsResponse>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            dc.removeEventListener('message', listener);
            dc.removeEventListener('close', onClose);
            fn();
        };

        const listener = (event: MessageEvent) => {
            // The agent writes replies as TEXT. If a future change sends them
            // as binary this lands here as a Blob, and saying so beats
            // "Unexpected token o in JSON" from JSON.parse("[object Blob]").
            if (typeof event.data !== 'string') {
                finish(() => reject(new Error('file transfer reply was not text')));
                return;
            }
            let resp: FsResponse;
            try {
                resp = JSON.parse(event.data) as FsResponse;
            } catch (e) {
                finish(() => reject(e instanceof Error ? e : new Error(String(e))));
                return;
            }
            // A reply carrying someone ELSE's id is a straggler from a request
            // that already timed out. Discard it and keep waiting for ours —
            // consuming it is how one late reply used to shift every answer
            // off by one for the rest of the session. No id at all means an
            // agent from before ids existed; serialisation is the only
            // matching there, exactly as before.
            if (typeof resp.id === 'number' && resp.id !== id) return;
            finish(() => {
                if (resp.ok === 'error') reject(new Error(resp.message || 'Unknown FS error'));
                else resolve(resp);
            });
        };

        const onClose = () => finish(() => reject(new Error('File transfer disconnected')));
        const timer = setTimeout(
            () => finish(() => reject(new Error('the other computer did not answer'))),
            FS_TIMEOUT_MS,
        );

        dc.addEventListener('message', listener);
        dc.addEventListener('close', onClose);
        try {
            dc.send(JSON.stringify({ ...cmd, id }));
        } catch (e) {
            finish(() => reject(e instanceof Error ? e : new Error(String(e))));
        }
    });
}

function sendCommand(sessionId: string, cmd: Record<string, unknown>): Promise<FsResponse> {
    return enqueue(sessionId, () => sendOne(sessionId, cmd));
}

export async function listRoots(sessionId: string): Promise<string[]> {
    const resp = await sendCommand(sessionId, { cmd: 'list_roots' });
    return resp.roots || [];
}

export async function listDir(
    sessionId: string,
    path: string,
): Promise<{ entries: FsEntry[]; truncated: boolean }> {
    const resp = await sendCommand(sessionId, { cmd: 'list', path });
    return { entries: resp.entries || [], truncated: resp.truncated === true };
}

export async function readFileChunk(sessionId: string, path: string, offset: number, len: number): Promise<string> {
    if (len > FS_CHUNK) throw new Error(`read of ${len} bytes exceeds the ${FS_CHUNK}-byte chunk limit`);
    const resp = await sendCommand(sessionId, { cmd: 'read', path, offset, len });
    return resp.data || '';
}

export async function writeFileChunk(
    sessionId: string,
    path: string,
    offset: number,
    data: string,
    truncate = false,
): Promise<number> {
    const resp = await sendCommand(sessionId, { cmd: 'write', path, offset, data, truncate });
    return resp.len || 0;
}

/** base64 of one slice, without building a giant intermediate string. */
function toBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Download a whole file by paging, streaming each chunk into `write` —
 * a sink function, so the caller decides where bytes go (disk on Tauri via
 * transferSinks, memory elsewhere) instead of this function always
 * accumulating the entire file in the JS heap. Paged because the agent
 * refuses a single oversized read (it used to allocate whatever length was
 * asked for, which an arbitrarily large `len` turned into an OOM kill).
 *
 * A SHORT READ IS AN ERROR, NOT EOF. Zero bytes mid-file used to break the
 * loop and hand back a partial blob that was then saved under the real
 * filename with no complaint — silent truncation. The size came from the
 * directory listing moments ago; if the file has genuinely changed since,
 * failing and letting the user retry beats presenting a corrupt file as done.
 */
export async function downloadFileTo(
    sessionId: string,
    path: string,
    size: number,
    write: (chunk: Uint8Array) => void | Promise<void>,
    onProgress?: (done: number, total: number) => void,
    /** Set `aborted` to stop between chunks. A plain object rather than an
     *  AbortSignal to match the convention the chat sender already uses, and
     *  because the only thing that has to cross the boundary is one bit. */
    signal?: { aborted: boolean },
): Promise<number> {
    let offset = 0;
    // A zero-length file still needs one round trip, or an empty download
    // would silently "succeed" without ever contacting the host.
    do {
        if (signal?.aborted) throw new Error('cancelled');
        const want = Math.min(FS_CHUNK, Math.max(size - offset, 0)) || (offset === 0 ? 1 : 0);
        if (want === 0) break;
        const b64 = await readFileChunk(sessionId, path, offset, want);
        const bytes = fromBase64(b64);
        if (bytes.length === 0) {
            if (size === 0) break; // the empty file probing read
            throw new Error(
                `the transfer ended early at ${offset} of ${size} bytes — the file `
                + 'may have changed on the other machine; refresh and try again',
            );
        }
        await write(bytes);
        offset += bytes.length;
        onProgress?.(offset, size);
    } while (offset < size);
    if (offset < size) {
        throw new Error(`the transfer ended early at ${offset} of ${size} bytes`);
    }
    return offset;
}

/** Compatibility wrapper: the whole file as one in-memory Blob. */
export async function downloadFile(
    sessionId: string,
    path: string,
    size: number,
    onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
    const parts: BlobPart[] = [];
    await downloadFileTo(sessionId, path, size, b => { parts.push(b as unknown as BlobPart); }, onProgress);
    return new Blob(parts);
}

/**
 * Upload a whole file by paging. The final chunk carries `truncate`, so
 * overwriting a LARGER existing file cuts the leftover tail instead of leaving
 * the previous file's bytes past the new end.
 */
export async function uploadFile(
    sessionId: string,
    path: string,
    file: Blob,
    onProgress?: (done: number, total: number) => void,
): Promise<number> {
    const total = file.size;
    let offset = 0;
    if (total === 0) {
        return writeFileChunk(sessionId, path, 0, '', true);
    }
    while (offset < total) {
        const slice = file.slice(offset, Math.min(offset + FS_CHUNK, total));
        const bytes = new Uint8Array(await slice.arrayBuffer());
        const last = offset + bytes.length >= total;
        const wrote = await writeFileChunk(sessionId, path, offset, toBase64(bytes), last);
        // The reply says how much actually landed. Advancing by the LOCAL
        // slice length regardless — what this did before — counted a reply
        // that wrote nothing as a successful chunk and uploaded a file full
        // of holes the progress bar called 100%.
        if (wrote !== bytes.length) {
            throw new Error(
                `the other machine wrote ${wrote} of ${bytes.length} bytes at `
                + `offset ${offset} — upload aborted`,
            );
        }
        offset += bytes.length;
        onProgress?.(offset, total);
    }
    return offset;
}
