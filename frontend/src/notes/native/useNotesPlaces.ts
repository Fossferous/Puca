/**
 * Location reminders as Púca Notes shows them: the open items that have a
 * saved place on THIS phone, for the Reminders view's "At a place" section.
 *
 * Places are device-local and per app (api/taskPlaces.ts): Púca and Púca
 * Notes on one phone keep separate stores, so a place saved in one app is
 * not seen by the other, and nothing about any place reaches the server.
 *
 * Also retires the place assignment of an item once it is seen completed —
 * TaskTree does this for the list it renders, but Notes' grid rarely renders
 * every note's tree, and a fence for a finished errand must stop firing.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { type Task } from '../../api/tasks';
import { getTaskPlace, placesVersion, subscribePlaces, unassignTasks, type TaskPlace } from '../../api/taskPlaces';
import { isAndroidApp } from '../../api/platform';
import { type NoteCard } from '../model/notesModel';

export interface PlaceItem {
    task: Task;
    note: NoteCard;
    place: TaskPlace;
}

/** Pure: every open task with a place, in note order. */
export function placeReminderItems(cards: NoteCard[], placeOf: (taskId: number) => TaskPlace | null): PlaceItem[] {
    const out: PlaceItem[] = [];
    for (const note of cards) {
        for (const task of note.tasks ?? []) {
            if (task.is_completed) continue;
            const place = placeOf(task.id);
            if (place) out.push({ task, note, place });
        }
    }
    return out;
}

/** Pure: ids of completed tasks that still carry a place assignment. */
export function completedWithPlace(cards: NoteCard[], placeOf: (taskId: number) => TaskPlace | null): number[] {
    const out: number[] = [];
    for (const note of cards) {
        for (const task of note.tasks ?? []) {
            if (task.is_completed && placeOf(task.id)) out.push(task.id);
        }
    }
    return out;
}

export function usePlaceReminderItems(cards: NoteCard[]): PlaceItem[] {
    const version = useSyncExternalStore(subscribePlaces, placesVersion, placesVersion);
    const android = isAndroidApp();
    useEffect(() => {
        if (!android) return;
        const done = completedWithPlace(cards, getTaskPlace);
        if (done.length > 0) unassignTasks(done);
    }, [android, cards, version]);
    return useMemo(
        () => (android ? placeReminderItems(cards, getTaskPlace) : []),
        // `version` is the store's change signal: getTaskPlace reads it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [android, cards, version],
    );
}
