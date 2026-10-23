/**
 * "Require encryption for calls" pushed live (audit 2026-10, second review):
 * the `MediaE2eeRequired` frame the server sends every member when the owner
 * saves the setting, and how it lands in the cached server rows that a
 * running call reads its policy from (Chat -> VoicePanel's
 * serverRequireMediaE2ee -> webrtcManager.setRequireMediaE2ee). The frame
 * reaching a member's socket is src/ws.rs
 * the_media_e2ee_policy_reaches_every_member_with_the_stored_value; the call
 * acting on it is mediaE2eeEnforcementToggle.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { applyMediaE2eeRequired, parseMediaE2eeRequired } from '../api/serverMediaPolicy';

const frame = (payload: unknown) => ({ type: 'MediaE2eeRequired', payload });

describe('the pushed "Require encryption for calls"', () => {
    it('reads the frame the server sends', () => {
        expect(parseMediaE2eeRequired(frame({ server_id: 's1', require_media_e2ee: true })))
            .toEqual({ server_id: 's1', require_media_e2ee: true });
        expect(parseMediaE2eeRequired(frame({ server_id: 's1', require_media_e2ee: false })))
            .toEqual({ server_id: 's1', require_media_e2ee: false });
    });

    it('takes nothing else: another frame, no server, an empty one, a value that is not a boolean', () => {
        expect(parseMediaE2eeRequired({ type: 'GamesEnabled', payload: { server_id: 's1', games_enabled: true } })).toBeNull();
        expect(parseMediaE2eeRequired(frame({ require_media_e2ee: true }))).toBeNull();
        expect(parseMediaE2eeRequired(frame({ server_id: '', require_media_e2ee: true }))).toBeNull();
        expect(parseMediaE2eeRequired(frame({ server_id: 's1', require_media_e2ee: 'true' }))).toBeNull();
        expect(parseMediaE2eeRequired(frame(null))).toBeNull();
        expect(parseMediaE2eeRequired({ type: 'MediaE2eeRequired' })).toBeNull();
    });

    it("lands in that server's cached row, as a new array, without touching the old one or another server", () => {
        const rows = [{ id: 's1', require_media_e2ee: false }, { id: 's2', require_media_e2ee: false }];
        const next = applyMediaE2eeRequired(rows, { server_id: 's1', require_media_e2ee: true });
        expect(next, 'react-query must see a new array, or nothing re-renders').not.toBe(rows);
        expect(next).toEqual([{ id: 's1', require_media_e2ee: true }, { id: 's2', require_media_e2ee: false }]);
        expect(rows[0].require_media_e2ee).toBe(false);
    });

    it('a row from an older server, with no such field, takes the pushed value', () => {
        expect(applyMediaE2eeRequired([{ id: 's1' }], { server_id: 's1', require_media_e2ee: true }))
            .toEqual([{ id: 's1', require_media_e2ee: true }]);
    });

    it('CONTROL: the same value, a server not listed, or no rows yet leave the cache as it is', () => {
        const rows = [{ id: 's1', require_media_e2ee: true }];
        expect(applyMediaE2eeRequired(rows, { server_id: 's1', require_media_e2ee: true })).toBe(rows);
        expect(applyMediaE2eeRequired(rows, { server_id: 's9', require_media_e2ee: false })).toBe(rows);
        expect(applyMediaE2eeRequired(undefined, { server_id: 's1', require_media_e2ee: true })).toBeUndefined();
    });
});
