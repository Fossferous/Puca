/**
 * Púca Notes — delete goes to the TRASH where the server has one.
 *
 * The trash is a server feature added alongside Notes' list content
 * (`POST /task-lists/:id/trash`, src/list_content.rs), announced by
 * `GET /task-lists/features` → `{ trash: true, ... }`. A server that predates
 * it answers the probe 404/405 (the path falls through to `/task-lists/:id`,
 * which has no GET), and only THAT server gets today's permanent delete,
 * behind the Undo window the grid and the selection bar already give it.
 *
 * Any other probe failure throws: a network error lets the outbox queue the
 * delete (and probe again at replay), a 5xx rolls it back. A bad moment is
 * never mistaken for an old server, so it never falls back to the permanent
 * delete.
 *
 * Kept in its own module on this branch; the list-content work carries the
 * same probe (api/listContent.ts fetchListFeatures) and the two meet at merge.
 */
import { apiClient, ApiError } from '../../api/client';
import { deleteTaskList, type TaskList } from '../../api/tasks';

const FEATURES_TTL_MS = 10 * 60_000;
let cached: { trash: boolean; at: number } | null = null;

/** For tests: forget what the server said. */
export function resetListTrashProbe(): void {
    cached = null;
}

/** Whether the server has a trash. See the header for what throws. */
export async function listTrashSupported(now: number = Date.now()): Promise<boolean> {
    if (cached && now - cached.at < FEATURES_TTL_MS) return cached.trash;
    let trash: boolean;
    try {
        const raw: unknown = await apiClient.get('/task-lists/features');
        trash = typeof raw === 'object' && raw !== null && (raw as { trash?: unknown }).trash === true;
    } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) trash = false;
        else throw err;
    }
    cached = { trash, at: now };
    return trash;
}

export type ListDeleteOutcome = 'trashed' | 'deleted';

/** Move a list to the trash, or — only on a server known to have none —
 *  delete it for good. */
export async function trashOrDeleteList(listId: number): Promise<ListDeleteOutcome> {
    if (await listTrashSupported()) {
        await apiClient.post(`/task-lists/${listId}/trash`, {});
        return 'trashed';
    }
    await deleteTaskList(listId);
    return 'deleted';
}

/**
 * The ids of lists in the trash, so a note there is not mistaken for one
 * that is gone (its colour and labels must survive a restore). Rows without
 * a trash time are dropped: a server that ignores `?trashed=true` would
 * otherwise hand back every live list.
 */
export async function trashedListIds(): Promise<Set<number>> {
    const lists: Array<Pick<TaskList, 'id'> & { trashed_at?: string | null }> = await apiClient.get('/task-lists?trashed=true');
    return new Set(lists.filter(l => typeof l.trashed_at === 'string' && l.trashed_at !== '').map(l => l.id));
}
