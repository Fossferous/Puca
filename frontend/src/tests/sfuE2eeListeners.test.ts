/**
 * The SFU call's E2EE badge and members who publish nothing.
 *
 * A member without SPEAK is in the call listen-only: their LiveKit
 * participant has no publications at all. participantE2ee() reports such a
 * participant as 'negotiating' (fail-closed: no evidence, not encrypted), and
 * allMediaE2eeStatuses() used to count it, so ONE listener turned the whole
 * call's badge into "some media is not encrypted" for as long as they stayed.
 * A participant that sends nothing has nothing to encrypt or leak, so it is
 * left out; a participant that publishes anything is still judged.
 *
 * The room is a hand-built stand-in installed on the manager's private field
 * (the badge reads only remoteParticipants / identity / trackPublications).
 */
import { describe, it, expect } from 'vitest';
import { SfuManager } from '../api/rtc/sfuManager';

interface FakePub { isEncrypted: boolean; source: string; isSubscribed: boolean; isMuted: boolean }
interface FakeParticipant { identity: string; trackPublications: Map<string, FakePub> }

const pub = (encrypted = true): FakePub => ({ isEncrypted: encrypted, source: 'microphone', isSubscribed: true, isMuted: false });
const participant = (identity: string, pubs: FakePub[]): FakeParticipant => ({
    identity,
    trackPublications: new Map(pubs.map((p, i) => [`TR_${identity}_${i}`, p])),
});

/** A manager "in" an SFU call as user 1, our own encryptor live, with these
 *  remote participants; `acked` = identities whose decryptor the worker acked. */
function managerWith(parts: FakeParticipant[], acked: string[] = parts.map(p => p.identity)) {
    const m = new SfuManager();
    const internals = m as unknown as {
        room: unknown;
        localUserId: number | null;
        localE2eeActive: boolean;
        cryptorEnabled: Map<string, boolean>;
    };
    internals.room = { remoteParticipants: new Map(parts.map(p => [p.identity, p])) };
    internals.localUserId = 1;
    internals.localE2eeActive = true;
    for (const id of acked) internals.cryptorEnabled.set(id, true);
    return m;
}

describe('SFU E2EE badge: participants that publish nothing', () => {
    it('POSITIVE CONTROL: a participant with an encrypted publication is counted, as encrypted', () => {
        const m = managerWith([participant('u7#a', [pub(true)])]);
        expect(m.allMediaE2eeStatuses()).toEqual([
            { userId: 7, encrypted: true, reason: 'encrypted', enforced: true },
        ]);
        expect(m.mediaEncryptionSummary()).toMatchObject({ total: 1, encrypted: 1 });
    });

    it('a participant with ZERO publications (a listener without Speak) is not counted', () => {
        const m = managerWith([participant('u7#a', [pub(true)]), participant('u8#b', [])]);
        const statuses = m.allMediaE2eeStatuses();
        expect(statuses.map(s => s.userId)).toEqual([7]);
        expect(m.mediaEncryptionSummary(), 'one listener must not break the badge')
            .toMatchObject({ total: 1, encrypted: 1 });
    });

    it('a call of listeners only has nothing to report', () => {
        const m = managerWith([participant('u8#b', []), participant('u9#c', [])]);
        expect(m.allMediaE2eeStatuses()).toEqual([]);
        expect(m.mediaEncryptionSummary()).toMatchObject({ total: 0, encrypted: 0 });
    });

    it('a participant that publishes is still judged: an unencrypted publication counts against the call', () => {
        const m = managerWith([participant('u7#a', [pub(false)]), participant('u8#b', [])]);
        expect(m.allMediaE2eeStatuses()).toEqual([
            { userId: 7, encrypted: false, reason: 'peer-unencrypted', enforced: true },
        ]);
        expect(m.mediaEncryptionSummary()).toMatchObject({ total: 1, encrypted: 0 });
    });

    it('a user\'s silent second connection does not drag their publishing one to "not encrypted"', () => {
        const m = managerWith([participant('u7#phone', []), participant('u7#desk', [pub(true)])]);
        expect(m.allMediaE2eeStatuses()).toEqual([
            { userId: 7, encrypted: true, reason: 'encrypted', enforced: true },
        ]);
    });
});
