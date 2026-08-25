/** The badge is a SUBSET check on server-stamped part ids (docs/CLIPS.md D6). */
import { describe, it, expect } from 'vitest';
import { clipBadge, clipBadgeText } from '../api/clips/clipConsentBadge';

const m = (parts: string[]) => ({ parts });

describe('clipBadge', () => {
    it('renders "approved by everyone" when every manifest part is stamped', () => {
        expect(clipBadge(m(['a', 'b']), { proposal_id: 'p', approver_count: 3, part_file_ids: ['a', 'b'], solo: false })).toEqual({ kind: 'approved', count: 3 });
    });
    it('an EXTRA stamped part (superset) does not break the badge', () => {
        expect(clipBadge(m(['a']), { proposal_id: 'p', approver_count: 2, part_file_ids: ['a', 'zzz'], solo: false })).toEqual({ kind: 'approved', count: 2 });
    });
    it('a manifest part nobody approved => mismatch (warning, playback refused)', () => {
        expect(clipBadge(m(['a', 'evil']), { proposal_id: 'p', approver_count: 2, part_file_ids: ['a'], solo: false })).toEqual({ kind: 'mismatch' });
        expect(clipBadge(m([]), { proposal_id: 'p', approver_count: 2, part_file_ids: ['a'], solo: false })).toEqual({ kind: 'mismatch' });
    });
    it('no stamp => none (no badge, no scare chip)', () => {
        expect(clipBadge(m(['a']), null)).toEqual({ kind: 'none' });
        expect(clipBadge(m(['a']), undefined)).toEqual({ kind: 'none' });
        expect(clipBadge(m(['a']), { proposal_id: 'p', approver_count: 1, part_file_ids: 'nope' as unknown as string[], solo: false })).toEqual({ kind: 'none' });
    });
    it('solo => solo copy, never "approved by"', () => {
        expect(clipBadge(m(['a']), { proposal_id: 'p', approver_count: 0, part_file_ids: ['a'], solo: true })).toEqual({ kind: 'solo' });
    });
});

describe('clipBadgeText names nobody', () => {
    it('copy per kind', () => {
        expect(clipBadgeText({ kind: 'approved', count: 3 })).toBe('Approved by everyone in the call (3 people)');
        expect(clipBadgeText({ kind: 'approved', count: 1 })).toBe('Approved by everyone in the call (1 person)');
        expect(clipBadgeText({ kind: 'solo' })).toMatch(/Solo clip/);
        expect(clipBadgeText({ kind: 'mismatch' })).toMatch(/nobody approved/);
        expect(clipBadgeText({ kind: 'none' })).toBeNull();
    });
});
