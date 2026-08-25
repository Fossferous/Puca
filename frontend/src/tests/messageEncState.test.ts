/**
 * H-1: every rendered message must be classifiable as secure / legacy-plaintext
 * / failed, so the UI can flag a message the server delivered as CLEARTEXT.
 * Without the classifier, an injected plaintext message renders identically to a
 * decrypted one and the E2EE promise's absence is invisible.
 *
 * These are pure, deterministic checks on `messageEncState` — the single source
 * of truth every decrypt path (DM / channel / task) now tags its output with.
 */
import { describe, it, expect } from 'vitest';
import {
    messageEncState,
    generateChannelKey,
    encryptChannelMessage,
    serializeEnvelope,
} from '../api/e2ee';
import {
    ENC_CANNOT_DECRYPT,
    ENC_UNVERIFIED_SENDER,
    ENC_SIGN_IN,
    ENC_KEY_UNAVAILABLE,
    TASK_DECRYPT_FAILED,
} from '../api/decryptMarkers';

describe('messageEncState (H-1 encryption indicator)', () => {
    it('classifies a real envelope as secure', async () => {
        const ck = generateChannelKey();
        const wire = serializeEnvelope(await encryptChannelMessage(ck, 1, 'hello'));
        // Decrypted output is the plaintext (not a failure marker) -> secure.
        expect(messageEncState(wire, 'hello')).toBe('secure');
    });

    it('classifies server-sent plaintext (non-envelope) as legacy', () => {
        // THE H-1 CASE: the wire was never an envelope, so this content was sent
        // as cleartext and passed through verbatim. It must NOT read as secure.
        expect(messageEncState('just a normal message', 'just a normal message')).toBe('legacy');
        // A JSON-looking blob that is not a valid envelope is still plaintext.
        expect(messageEncState('{"not":"an envelope"}', '{"not":"an envelope"}')).toBe('legacy');
        // Empty content is plaintext, not an envelope.
        expect(messageEncState('', '')).toBe('legacy');
    });

    it('classifies any decrypt-failure marker as failed, regardless of wire', () => {
        for (const marker of [ENC_CANNOT_DECRYPT, ENC_UNVERIFIED_SENDER, ENC_SIGN_IN, ENC_KEY_UNAVAILABLE, TASK_DECRYPT_FAILED]) {
            // Even if the wire WAS an envelope, a failure output is 'failed'.
            expect(messageEncState('{"v":2,"t":"ch","ct":"x","epoch":1}', marker)).toBe('failed');
        }
    });

    it('does not misclassify a plaintext message that merely quotes a marker string as failed unless it exactly equals one', () => {
        // A genuine message that contains marker-like text is still legacy, not
        // failed — isUndecryptable is an exact match on the trimmed content.
        const almost = `I saw ${ENC_CANNOT_DECRYPT} in the logs`;
        expect(messageEncState(almost, almost)).toBe('legacy');
    });
});

// The threading: the batch decrypt functions must TAG each message with its
// state. Plaintext passthrough needs no keys, so this exercises the real
// decrypt path end-to-end (parse -> passthrough -> classify). If the encState
// attachment were dropped, `encState` would be undefined and these fail.
describe('decrypt functions tag server-sent plaintext as legacy (H-1 threading)', () => {
    it('decryptChannelMessages flags a non-envelope channel message', async () => {
        const { decryptChannelMessages } = await import('../api/servers');
        const out = await decryptChannelMessages(1, [{
            id: 'm1', channel_id: 1, user_id: 7, username: 'srv',
            content: 'plaintext injected by the server', created_at: '2026-01-01T00:00:00Z',
        }]);
        expect(out[0].content).toBe('plaintext injected by the server');
        expect(out[0].encState).toBe('legacy');
    });

    it('decryptDMMessages flags a non-envelope DM message', async () => {
        const { decryptDMMessages } = await import('../api/dms');
        const out = await decryptDMMessages([{
            id: 'd1', conversation_id: 'c1', sender_id: 9, sender_username: 'srv',
            sender_display_name: null, content: 'cleartext DM', created_at: '2026-01-01T00:00:00Z',
        }], 9);
        expect(out[0].content).toBe('cleartext DM');
        expect(out[0].encState).toBe('legacy');
    });
});
