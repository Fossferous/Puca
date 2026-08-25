/**
 * The consent badge decision (docs/CLIPS.md §Phase 2) — pure, so it is
 * testable without React.
 *
 * The server stamps `messages.clip_consent` with the ids of the parts the
 * clipper uploaded UNDER THE APPROVED PROPOSAL, plus a count. The manifest
 * inside the message names the parts the clip actually plays from. The badge
 * renders only when the manifest is a SUBSET of the stamped ids: an extra
 * uploaded part (a retried index that produced a spare row is impossible — parts
 * are idempotent — but a defensive superset costs nothing) does not break it,
 * while a manifest pointing at parts nobody approved gets a warning and no
 * playback. No stamp at all (a clip href pasted as text, or a pre-Clips
 * message) means: no badge, no scare chip — it is just an attachment.
 */
import type { ClipConsent } from '../servers';
import type { ClipManifest } from './clipRef';

export type ClipBadge =
    | { kind: 'approved'; count: number }
    | { kind: 'solo' }
    | { kind: 'none' }
    | { kind: 'mismatch' };

export function clipBadge(manifest: Pick<ClipManifest, 'parts'>, consent: ClipConsent | null | undefined): ClipBadge {
    if (!consent || !Array.isArray(consent.part_file_ids)) return { kind: 'none' };
    const stamped = new Set(consent.part_file_ids);
    const covered = manifest.parts.length > 0 && manifest.parts.every(id => stamped.has(id));
    if (!covered) return { kind: 'mismatch' };
    if (consent.solo) return { kind: 'solo' };
    const n = Number(consent.approver_count);
    return { kind: 'approved', count: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0 };
}

/** The badge copy. Names are deliberately absent — the server never stamps them. */
export function clipBadgeText(b: ClipBadge): string | null {
    switch (b.kind) {
        case 'approved': return `Approved by everyone in the call (${b.count} ${b.count === 1 ? 'person' : 'people'})`;
        case 'solo': return 'Solo clip — no one else was in the call';
        case 'mismatch': return 'This clip points at footage nobody approved — it will not play.';
        default: return null;
    }
}
