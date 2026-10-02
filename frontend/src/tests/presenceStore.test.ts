/**
 * The presence store: ONE place every status render reads from.
 *
 * Before it, each surface kept its own copy: the member list patched one
 * react-query cache from UserOnline/UserOffline, the friends list had no
 * live presence at all (a 15 s poll), and nothing could show "idle". Pushed
 * frames and polled snapshots now land in one store with one precedence rule:
 * a snapshot only overrides what it is NEWER than, so a 10 s member poll that
 * was already in flight cannot paint over a status pushed while it travelled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fixture from './fixtures/userStatus.json';
import {
    applyPresenceFrame,
    ingestPresenceSnapshot,
    normalizeStatus,
    presenceOf,
    __resetPresenceForTests,
} from '../api/presenceStore';

const frame = (type: string, payload: object) => ({ type, payload: payload as Record<string, unknown> });

beforeEach(() => __resetPresenceForTests());

describe('presence store', () => {
    it('parses the exact frame the server sends (shared fixture)', () => {
        applyPresenceFrame(fixture);
        expect(presenceOf(7)).toBe('idle');
        // Positive control: an untouched user is not idle.
        expect(presenceOf(8, true)).toBe('online');
    });

    it('UserStatus idle/away, then back to online', () => {
        applyPresenceFrame(frame('UserOnline', { user: { id: 5, username: 'e' } }));
        expect(presenceOf(5)).toBe('online');
        applyPresenceFrame(frame('UserStatus', { user_id: 5, status: 'idle' }));
        expect(presenceOf(5)).toBe('idle');
        applyPresenceFrame(frame('UserStatus', { user_id: 5, status: 'away' }));
        expect(presenceOf(5)).toBe('away');
        applyPresenceFrame(frame('UserStatus', { user_id: 5, status: 'online' }));
        expect(presenceOf(5)).toBe('online');
    });

    it('UserOffline after UserStatus(idle) is offline; UserOnline after that is plain online', () => {
        applyPresenceFrame(frame('UserStatus', { user_id: 5, status: 'idle' }));
        applyPresenceFrame(frame('UserOffline', { user_id: 5 }));
        expect(presenceOf(5)).toBe('offline');
        applyPresenceFrame(frame('UserOnline', { user: { id: 5, username: 'e' } }));
        expect(presenceOf(5)).toBe('online');
    });

    it('a status this client does not know reads as online, never as offline', () => {
        applyPresenceFrame(frame('UserStatus', { user_id: 5, status: 'dnd' }));
        expect(presenceOf(5)).toBe('online');
        expect(normalizeStatus(true, 'something-newer')).toBe('online');
        expect(normalizeStatus(true, undefined)).toBe('online');
        expect(normalizeStatus(false, 'idle')).toBe('offline');
        expect(normalizeStatus(true, 'away')).toBe('away');
    });

    it('a REST row is the fallback when nothing was ingested for that user', () => {
        expect(presenceOf(9, true, 'idle')).toBe('idle');
        expect(presenceOf(9, false, 'idle')).toBe('offline');
        expect(presenceOf(9, true)).toBe('online');
        expect(presenceOf(9)).toBe('offline');
    });

    it('a snapshot older than a push does not overwrite it; a newer one does', () => {
        const before = Date.now() - 5_000;
        applyPresenceFrame(frame('UserStatus', { user_id: 5, status: 'idle' }));
        // A poll that STARTED before the push arrives after it, still saying online.
        ingestPresenceSnapshot([{ id: 5, is_online: true, status: 'online' }], before);
        expect(presenceOf(5)).toBe('idle');
        // A poll started after the push is newer evidence and wins.
        ingestPresenceSnapshot([{ id: 5, is_online: false }], Date.now() + 1);
        expect(presenceOf(5)).toBe('offline');
    });

    it('a snapshot row beats a missing entry, and the store beats the stale row it was fed later', () => {
        ingestPresenceSnapshot([{ id: 6, is_online: true, status: 'away' }], Date.now());
        // The render site still holds the row it fetched; the store answers.
        expect(presenceOf(6, true, 'online')).toBe('away');
    });

    it('ignores frames for other types and malformed payloads', () => {
        applyPresenceFrame(frame('UserStatus', { user_id: '5', status: 'idle' }));
        applyPresenceFrame(frame('ChatMessage', { user_id: 5 }));
        expect(presenceOf(5, true)).toBe('online');
    });
});
