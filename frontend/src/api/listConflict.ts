/**
 * Two devices, one note — the client half of migration 069.
 *
 * A note's own content (its title, its text, its pictures) carries a
 * revision. A save names the revision it was based on; if someone else wrote
 * the note in between, the server refuses with 409 and hands back the copy it
 * holds, and NOTHING is written. Before this, the later save simply won and
 * the other device's words were gone with no trace.
 *
 * Ticking, adding, editing or reordering an ITEM does not touch the
 * revision (migration 069's trigger names the three content columns), so the
 * everyday case of two people in one note — one typing, one ticking — is not
 * a conflict and never raises one.
 *
 * VERSION SKEW. `expect_rev` is only sent when `fetchListFeatures()` says the
 * server has it. Absent, the server does not check, which is exactly today's
 * last-write-wins behaviour — so an older server, and an op queued before any
 * of this existed, keep working.
 *
 * Deliberately a leaf: it depends on client.ts and listSeal.ts only, so both
 * tasks.ts and listContent.ts can use it without a cycle.
 */
import { ApiError, apiClient } from './client';
import { MAX_READABLE_ENVELOPE_VERSION } from './e2ee';
import { openSelfField } from './listSeal';

/**
 * A save that lost the race. `body` and `attachments` are the server's
 * current copy, OPENED on this device (or a decrypt-failure marker — never
 * the envelope), so the caller can show the user what they are about to
 * replace. `title` stays sealed: the body conflict UI does not need it, and
 * opening a title needs tasks.ts, which imports this module.
 */
export class NoteConflictError extends Error {
    readonly contentRev: number;
    readonly body: string | null;
    readonly attachments: string | null;
    readonly sealedTitle: string | null;

    constructor(contentRev: number, body: string | null, attachments: string | null, sealedTitle: string | null) {
        super('This note was changed somewhere else');
        this.name = 'NoteConflictError';
        this.contentRev = contentRev;
        this.body = body;
        this.attachments = attachments;
        this.sealedTitle = sealedTitle;
    }
}

/** The 409 this module raised, or null for any other refusal — a trashed
 *  note and an envelope downgrade are also 409s and must keep behaving
 *  exactly as they do today (drop the edit, say so). The server tags this
 *  one with `"conflict": "stale"` for precisely that reason. */
async function conflictFrom(err: unknown): Promise<NoteConflictError | null> {
    if (!(err instanceof ApiError) || err.status !== 409) return null;
    const raw = (err.body ?? '').trim();
    if (!raw.startsWith('{')) return null;
    let parsed: { conflict?: unknown; content_rev?: unknown; body?: unknown; attachments?: unknown; title?: unknown };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (parsed.conflict !== 'stale' || typeof parsed.content_rev !== 'number') return null;
    const open = async (v: unknown): Promise<string | null> =>
        typeof v === 'string' && v !== '' ? await openSelfField(v) : null;
    return new NoteConflictError(
        parsed.content_rev,
        await open(parsed.body),
        await open(parsed.attachments),
        typeof parsed.title === 'string' ? parsed.title : null,
    );
}

/** One content write this tab made and the server accepted: the revision it
 *  named (undefined = none) and the one it produced. */
export interface ContentWrite {
    listId: number;
    expectRev?: number;
    rev: number;
}

const writeWatchers = new Set<(w: ContentWrite) => void>();

/**
 * Be told of every content write THIS tab lands (title, text or pictures).
 * The offline outbox (notes/model/notesOutbox.ts) uses it to tell its own
 * revision bumps from another device's: text queued on revision N, behind the
 * device's own rename that moved the note to N+1, must not be refused as
 * though someone else had written. Carries ids and counters only.
 */
export function watchContentWrites(fn: (w: ContentWrite) => void): () => void {
    writeWatchers.add(fn);
    return () => { writeWatchers.delete(fn); };
}

/**
 * PATCH a note's own content. Resolves to the note's NEW revision, so a run
 * of saves chains without a refetch between them — or null from a server
 * older than 069, which answers with no body.
 *
 * Throws NoteConflictError when `expect_rev` lost the race; every other
 * failure is rethrown untouched.
 */
export async function patchListContent(listId: number, payload: Record<string, unknown>): Promise<number | null> {
    try {
        const answer = await apiClient.patch<{ content_rev?: unknown } | null>(
            `/task-lists/${listId}`,
            { ...payload, reads_up_to: MAX_READABLE_ENVELOPE_VERSION },
        );
        const rev = answer && typeof answer === 'object' ? (answer as { content_rev?: unknown }).content_rev : undefined;
        if (typeof rev !== 'number') return null;
        const expectRev = typeof payload.expect_rev === 'number' ? payload.expect_rev : undefined;
        for (const w of writeWatchers) {
            try { w({ listId, expectRev, rev }); } catch { /* a watcher never fails the save */ }
        }
        return rev;
    } catch (err) {
        const conflict = await conflictFrom(err);
        if (conflict) throw conflict;
        throw err;
    }
}
