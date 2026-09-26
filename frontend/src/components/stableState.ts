/**
 * Updates that return the PREVIOUS value when nothing changed, so React skips
 * the render. Both callers run on a timer for as long as the app is open, and
 * both used to build a fresh object every tick — which re-rendered the whole
 * component every tick whether anything had changed or not:
 *  - Chat's typing cleanup, every second (the whole of Chat, message list
 *    included);
 *  - VoicePanel's encryption-status poll, every two seconds.
 */
import type { MediaE2eeReason } from '../api/rtc/types';

export interface TypingEntry { username: string; expiry: number }

/** Drops expired "is typing" entries; the SAME map when none expired. */
export function pruneExpiredTyping<K>(prev: Map<K, TypingEntry>, now: number): Map<K, TypingEntry> {
    let next: Map<K, TypingEntry> | null = null;
    for (const [id, data] of prev) {
        if (data.expiry < now) {
            next ??= new Map(prev);
            next.delete(id);
        }
    }
    return next ?? prev;
}

export interface MediaSummary { total: number; encrypted: number; supported: boolean; enforced: boolean }
export interface E2eeDetailRow { userId: number; encrypted: boolean; reason: MediaE2eeReason }

/** `next` unless it says exactly what `prev` says, in which case `prev`. */
export function keepSummary(prev: MediaSummary, next: MediaSummary): MediaSummary {
    return prev.total === next.total && prev.encrypted === next.encrypted
        && prev.supported === next.supported && prev.enforced === next.enforced ? prev : next;
}

/** `next` unless it lists the same peers in the same states, in which case `prev`. */
export function keepDetail(prev: E2eeDetailRow[], next: E2eeDetailRow[]): E2eeDetailRow[] {
    if (prev.length !== next.length) return next;
    for (let i = 0; i < prev.length; i++) {
        const a = prev[i], b = next[i];
        if (a.userId !== b.userId || a.encrypted !== b.encrypted || a.reason !== b.reason) return next;
    }
    return prev;
}
