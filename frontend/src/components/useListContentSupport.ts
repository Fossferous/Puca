/**
 * Púca's view of what the server supports for personal lists beyond a
 * checklist (text, pictures, trash — api/listContent.ts), and the trashed
 * lists, through Púca's own query client. TasksView reads this to show a
 * list's note text and pictures, to move lists to the trash instead of
 * deleting them, and to keep a trashed list's slot in the saved tab order.
 */
import { useQuery } from '@tanstack/react-query';
import { type TaskList } from '../api/tasks';
import { type ListFeatures, NO_LIST_FEATURES, fetchListFeatures, listTrashedTaskLists } from '../api/listContent';
import { isUndecryptable } from '../api/decryptMarkers';

export const listContentQueryKeys = {
    features: ['listContent', 'features'] as const,
    trash: ['listContent', 'trash'] as const,
};

export function useListContentSupport(): { features: ListFeatures; featuresKnown: boolean; trashEnabled: boolean; trashed: TaskList[]; trashedKeys: ReadonlySet<string> } {
    const f = useQuery({ queryKey: listContentQueryKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
    const features = f.data ?? NO_LIST_FEATURES;
    const trashEnabled = f.isSuccess && features.trash;
    const t = useQuery({ queryKey: listContentQueryKeys.trash, queryFn: listTrashedTaskLists, enabled: trashEnabled });
    const trashed = t.data ?? [];
    return { features, featuresKnown: f.isSuccess, trashEnabled, trashed, trashedKeys: new Set(trashed.map(l => `list:${l.id}`)) };
}

/** A short line for the All-tasks board card. */
export function listBodySnippet(list: TaskList | undefined): string {
    const b = list?.body;
    if (!b || isUndecryptable(b)) return '';
    return b.length > 240 ? `${b.slice(0, 239)}…` : b;
}

