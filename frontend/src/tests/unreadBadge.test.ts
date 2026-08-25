/**
 * The badge decision matrix. Judged from RAW inputs, never the toast
 * decision's short-circuited reason: shouldNotify checks the setting FIRST,
 * so with notifications off every message reported 'setting-off' — judging
 * that reason badged your OWN messages, muted servers, and messages you were
 * looking at. These tests pin the truth table.
 */
import { describe, it, expect } from 'vitest';
import { isBadgeWorthy } from '../api/unreadBadge';

const base = { mobile: false, isOwn: false, isMuted: false, hasFocus: false };

describe('isBadgeWorthy', () => {
    it('badges an unfocused, unmuted, other-author message', () => {
        expect(isBadgeWorthy(base)).toBe(true);
    });

    it('never badges your own message', () => {
        expect(isBadgeWorthy({ ...base, isOwn: true })).toBe(false);
    });

    it('never badges a muted channel/server', () => {
        expect(isBadgeWorthy({ ...base, isMuted: true })).toBe(false);
    });

    it('never badges while the window is focused', () => {
        expect(isBadgeWorthy({ ...base, hasFocus: true })).toBe(false);
    });

    it('never badges on mobile', () => {
        expect(isBadgeWorthy({ ...base, mobile: true })).toBe(false);
    });

    // The regression this shape exists to prevent: the toast setting must
    // have NO influence — isBadgeWorthy doesn't even accept it, so a
    // notifications-off user still gets badges for genuinely unseen
    // messages and never for own/muted/focused ones.
});
