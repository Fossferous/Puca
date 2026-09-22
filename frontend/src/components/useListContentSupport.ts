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
import { galleryItems, heroItems } from '../api/noteMedia';

export const listContentQueryKeys = {
    features: ['listContent', 'features'] as const,
    trash: ['listContent', 'trash'] as const,
};

export function useListContentSupport(): {
    features: ListFeatures; featuresKnown: boolean; trashEnabled: boolean;
    /** The trash has been read (or there is none). Until then `trashedKeys`
     *  is empty for want of knowing, and a tab-pref save — a full replace —
     *  would drop every trashed list's slot, so saves wait for this. */
    trashSettled: boolean;
    trashed: TaskList[]; trashedKeys: ReadonlySet<string>;
} {
    const f = useQuery({ queryKey: listContentQueryKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
    const features = f.data ?? NO_LIST_FEATURES;
    const trashEnabled = f.isSuccess && features.trash;
    const t = useQuery({ queryKey: listContentQueryKeys.trash, queryFn: listTrashedTaskLists, enabled: trashEnabled });
    const trashed = t.data ?? [];
    const trashSettled = f.isSuccess && (!trashEnabled || t.isSuccess);
    return { features, featuresKnown: f.isSuccess, trashEnabled, trashSettled, trashed, trashedKeys: new Set(trashed.map(l => `list:${l.id}`)) };
}

/** A short line for the All-tasks board card: the note's text, or — for a
 *  note that is only attachments — how many pictures and files it holds (the
 *  board is a glance; the list's own view shows them). */
export function listBodySnippet(list: TaskList | undefined): string {
    const b = list?.body;
    if (b && !isUndecryptable(b)) return b.length > 240 ? `${b.slice(0, 239)}…` : b;
    const pictures = heroItems(list?.attachments, Number.MAX_SAFE_INTEGER).length;
    const files = galleryItems(list?.attachments).filter(i => i.kind === 'file').length;
    const parts: string[] = [];
    if (pictures > 0) parts.push(`${pictures} picture${pictures === 1 ? '' : 's'}`);
    if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
    return parts.join(', ');
}

