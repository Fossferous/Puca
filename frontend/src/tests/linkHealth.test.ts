/**
 * When does a refused sign-in-screen link count as PERSISTENT?
 *
 * One rule, read by the DevicesView warning and by the console-lock handover
 * gate. A single refusal must change nothing: the same refusal comes back for
 * a server database fault, and one can be a blip the next attempt clears. So
 * the rule is at least two refusals, at least ten minutes apart.
 */
import { describe, it, expect } from 'vitest';
import {
    linkRefusalPersistent,
    LINK_REFUSAL_MIN_COUNT,
    LINK_REFUSAL_MIN_SPAN_SECS,
} from '../api/devices/linkHealth';

const T = 1_750_000_000;

describe('linkRefusalPersistent', () => {
    it('is the documented rule: two refusals, ten minutes apart', () => {
        expect(LINK_REFUSAL_MIN_COUNT).toBe(2);
        expect(LINK_REFUSAL_MIN_SPAN_SECS).toBe(600);
    });

    it('a single refusal is not persistent', () => {
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: T, linkRefusedCount: 1,
        })).toBe(false);
    });

    it('two refusals within ten minutes are not persistent', () => {
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: T + 599, linkRefusedCount: 2,
        })).toBe(false);
        // Many refusals inside the window still do not make it persistent.
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: T + 300, linkRefusedCount: 9,
        })).toBe(false);
    });

    it('two refusals ten or more minutes apart are persistent', () => {
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: T + 600, linkRefusedCount: 2,
        })).toBe(true);
        // The service's own cadence: a refusal, then the next one 15 minutes on.
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: T + 900, linkRefusedCount: 2,
        })).toBe(true);
    });

    it('one refusal long ago is still only one refusal', () => {
        // first/last span alone is not enough: count must agree.
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: T + 86_400, linkRefusedCount: 1,
        })).toBe(false);
    });

    it('nothing recorded, or an older service, is not a refusal', () => {
        expect(linkRefusalPersistent(null)).toBe(false);
        expect(linkRefusalPersistent(undefined)).toBe(false);
        expect(linkRefusalPersistent({})).toBe(false);
        expect(linkRefusalPersistent({
            linkRefusedFirst: null, linkRefusedLast: null, linkRefusedCount: 0,
        })).toBe(false);
        expect(linkRefusalPersistent({
            linkRefusedFirst: T, linkRefusedLast: null, linkRefusedCount: 5,
        })).toBe(false);
    });
});
