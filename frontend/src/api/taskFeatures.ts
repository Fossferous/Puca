/**
 * Which task-timing features the SERVER stores — GET /task-features (066+).
 *
 * Why a probe and not the response shape: an older server silently DROPS
 * fields it does not know (no struct uses deny_unknown_fields), so a client
 * that wrote a schedule to one would lose it without an error. The task
 * responses of a 066 server do always carry a `schedule` key — but an empty
 * note's task list is `[]`, which carries nothing, and a new note or an
 * import target is exactly where an event gets created first. So: one GET per
 * session, independent of rows.
 *
 *   404        → an older server: none of these (editing hidden, today's
 *                behaviour everywhere)
 *   other error / offline → UNKNOWN: editing hidden too, and retried on the
 *                next subscribe — guessing "yes" would lose data, guessing
 *                "no" forever would hide a feature that exists
 */
import { useSyncExternalStore } from 'react';
import { apiClient, ApiError } from './client';

export type TaskFeature = 'schedule' | 'snooze' | 'updated_at' | 'expect_due_at' | 'recurrence_aware' | 'reopen_subtree' | 'reminder_feed_v2';

interface State {
    status: 'unknown' | 'loading' | 'known';
    features: ReadonlySet<string>;
}

let state: State = { status: 'unknown', features: new Set() };
const listeners = new Set<() => void>();

function set(next: State): void {
    state = next;
    for (const l of listeners) l();
}

/** Load (once) and return the feature set; rejects only on a transient
 *  failure, which leaves the state unknown for a later retry. */
export async function loadTaskFeatures(): Promise<ReadonlySet<string>> {
    if (state.status === 'known') return state.features;
    set({ ...state, status: 'loading' });
    try {
        const r = await apiClient.get<{ version?: number; features?: unknown }>('/task-features');
        const list = Array.isArray(r?.features) ? r.features.filter((f): f is string => typeof f === 'string') : [];
        set({ status: 'known', features: new Set(list) });
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
            set({ status: 'known', features: new Set() });
        } else {
            set({ status: 'unknown', features: new Set() });
            throw err;
        }
    }
    return state.features;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    if (state.status === 'unknown') void loadTaskFeatures().catch(() => { /* unknown; retried on the next subscribe */ });
    return () => { listeners.delete(cb); };
}

const getSnapshot = () => state;

/** true / false once known; null while unknown (treat as "no"). */
export function useTaskFeature(f: TaskFeature): boolean | null {
    const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return s.status === 'known' ? s.features.has(f) : null;
}

export function hasTaskFeature(f: TaskFeature): boolean {
    return state.status === 'known' && state.features.has(f);
}

/** Tests only. */
export function __resetTaskFeatures(): void {
    state = { status: 'unknown', features: new Set() };
}
