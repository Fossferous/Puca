/**
 * The PHONE-side file server: answers FsRequests on the session's `files`
 * data channel, confined to the folder the phone's user granted.
 *
 * This is the JS counterpart of the native agent's server (puca-agent
 * `stream.rs` ChannelData + `file_transfer.rs` handle_request) and speaks the
 * SAME wire protocol, because the controller cannot tell what kind of host it
 * is browsing: JSON text frames, `{cmd: list_roots|list|read|write, id?}` in,
 * `{ok: roots|list|data|wrote|error, id echoed iff the request carried one}`
 * out. Divergences from the agent, both deliberate and both STRICTER:
 *
 * - Writes are replace-at-0 / append-at-end only. The agent seeks; the
 *   Capacitor filesystem API has no positioned write, and the one production
 *   client (`uploadFile`) writes strictly sequentially from zero — so
 *   "replace, then append" implements the same files, and a mid-file
 *   overwrite is refused with the agent's own "write sequentially" wording.
 *   Replace-at-0 also makes the final-chunk `truncate` flag implicit: a
 *   rewritten file can never keep a stale tail.
 * - `read` stats first and answers `{data:''}` at-or-past EOF, so the
 *   empty-file probe and end-of-file are deterministic here rather than
 *   depending on the native plugin's out-of-range behaviour.
 *
 * The granted root is read PER REQUEST through `getRoot`, never cached —
 * revocation (the Stop banner, teardown) takes effect on the next request,
 * exactly like the agent re-reading its scope.
 */

import { FS_MAX_IO, resolveJailed, type FsProvider } from './fsJail';

/** Mirrors the native agent's MAX_LIST_ENTRIES (file_transfer.rs): a folder
 *  with more entries answers the first page plus `truncated: true` rather
 *  than serialising an unbounded listing into one frame on the phone's heap. */
export const FS_MAX_LIST = 5000;

interface FsReplyBase {
    ok: string;
    id?: number;
    [key: string]: unknown;
}

/** The root in force for a session, canonicalised at grant time. */
export interface GrantedRoot {
    root: string;
    canonRoot: string;
}

function err(message: string): FsReplyBase {
    return { ok: 'error', message };
}

function b64len(data: string): number {
    // Length of the DECODED bytes, without decoding: base64 is 4 chars per 3
    // bytes with `=` padding.
    const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return (data.length / 4) * 3 - pad;
}

/**
 * Answer one request. Pure protocol logic over the injected provider; the
 * channel plumbing lives in `attachFilesServer` below.
 */
export async function handleFsRequest(
    req: Record<string, unknown>,
    granted: GrantedRoot | null,
    provider: FsProvider,
): Promise<FsReplyBase> {
    if (!granted) return err('file access has not been allowed on that computer');
    const { root, canonRoot } = granted;

    const cmd = req.cmd;
    if (cmd === 'list_roots') {
        // One folder was granted, so there is exactly one root — mirroring
        // the agent's Jailed scope, and for the same reason: enumerating
        // anything else would advertise paths every other branch refuses.
        return { ok: 'roots', roots: [root] };
    }

    const path = typeof req.path === 'string' ? req.path : null;
    if (path === null) return err('a path is required');
    const resolved = await resolveJailed(provider, root, canonRoot, path);
    if (resolved === null) return err('path is outside the granted folder');

    if (cmd === 'list') {
        try {
            const all = await provider.readdir(resolved);
            return {
                ok: 'list',
                entries: all.length > FS_MAX_LIST ? all.slice(0, FS_MAX_LIST) : all,
                truncated: all.length > FS_MAX_LIST,
            };
        } catch (e) {
            return err(`could not read dir: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (cmd === 'read') {
        const offset = typeof req.offset === 'number' && req.offset >= 0 ? req.offset : 0;
        const len = typeof req.len === 'number' ? req.len : 0;
        if (len > FS_MAX_IO) {
            return err(`read of ${len} bytes is over the ${FS_MAX_IO}-byte limit; request it in chunks`);
        }
        // A MISSING OR NON-POSITIVE LENGTH IS A REFUSAL, not a default.
        // Capacitor's native readFile reads to EOF when length <= 0, so a
        // single frame with `len` omitted (or -1) would slip past the cap
        // above and base64 the WHOLE file into the phone's heap — the same
        // out-of-memory shape the agent's MAX_READ_LEN exists to stop, with
        // the cap intact and bypassed. The client always sends a positive
        // length; nothing legitimate lands here.
        if (!Number.isInteger(len) || len <= 0) {
            return err('a read needs a positive whole-number length');
        }
        try {
            const st = await provider.stat(resolved);
            if (!st.exists || st.is_dir) return err('could not open file');
            if (offset >= st.size) return { ok: 'data', data: '' };
            const want = Math.min(len, st.size - offset);
            return { ok: 'data', data: await provider.read(resolved, offset, want) };
        } catch (e) {
            return err(`could not read file: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (cmd === 'write') {
        const offset = typeof req.offset === 'number' && req.offset >= 0 ? req.offset : 0;
        const data = typeof req.data === 'string' ? req.data : '';
        const decodedLen = b64len(data);
        if (decodedLen > FS_MAX_IO) {
            return err(`write of ${decodedLen} bytes is over the ${FS_MAX_IO}-byte limit; send it in chunks`);
        }
        try {
            const st = await provider.stat(resolved);
            const size = st.exists ? st.size : 0;
            if (st.exists && st.is_dir) return err('could not open file');
            if (offset === 0) {
                await provider.writeReplace(resolved, data);
            } else if (offset === size) {
                await provider.append(resolved, data);
            } else if (offset > size) {
                // The agent's no-holes rule, same wording: a peer-chosen
                // offset past the end is a sparse-file amplification.
                return err(
                    `write at offset ${offset} would leave a hole in a ${size}-byte file; write sequentially`,
                );
            } else {
                // Stricter than the agent (which can seek): the only client
                // writes strictly sequentially, so a mid-file overwrite is a
                // desynced client, not a use case.
                return err(
                    `write at offset ${offset} into a ${size}-byte file is not sequential; write sequentially`,
                );
            }
            return { ok: 'wrote', len: decodedLen };
        } catch (e) {
            return err(`could not write file: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return err('unknown command');
}

/**
 * Wire a `files` data channel to the server. Requests are answered strictly
 * in arrival order — the client may match by order (an id-less pairing), so
 * a slow request must not let a fast one overtake its reply.
 */
export function attachFilesServer(
    dc: RTCDataChannel,
    getRoot: () => GrantedRoot | null,
    provider: FsProvider,
): void {
    let chain: Promise<void> = Promise.resolve();
    dc.onmessage = (event: MessageEvent) => {
        const raw = event.data;
        chain = chain.then(async () => {
            if (dc.readyState !== 'open') return;
            let reply: FsReplyBase;
            let reqId: number | undefined;
            try {
                if (typeof raw !== 'string') throw new Error('binary frame');
                const req = JSON.parse(raw) as Record<string, unknown>;
                if (typeof req.id === 'number') reqId = req.id;
                reply = await handleFsRequest(req, getRoot(), provider);
            } catch {
                reply = err('unparseable request');
            }
            // Echo the id iff the request carried one — same contract as the
            // agent (stream.rs encode_fs_reply).
            if (reqId !== undefined) reply.id = reqId;
            try {
                dc.send(JSON.stringify(reply));
            } catch {
                // The channel died mid-answer; the session teardown owns it.
            }
        });
    };
}
