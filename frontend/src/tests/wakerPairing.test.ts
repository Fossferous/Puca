import { describe, it, expect } from 'vitest';
import { parseWakerKeys } from '../api/devices/waker';

const REAL_INIT_OUTPUT = `
device_id  b7UiAGvt9FLd5l9-sNRxE
device_pub x25519:rC0UTI4FNtzeW4WyqTs1TW7EUxbDzv4fqVJflXQQNWs=
sign_pub   ed25519:ShxSotHfenGK7SHj16Fe7zAvj7LcNLrZh5ZayKKRn/s=
`;

describe('waker pairing input', () => {
    it('reads the block puca-waker init actually prints', () => {
        // Captured verbatim from a real run, not hand-written: the parser's job
        // is to accept what the binary emits, and a fixture invented here would
        // pass while the real output failed.
        const keys = parseWakerKeys(REAL_INIT_OUTPUT);
        expect(keys).not.toBeNull();
        expect(keys!.device_id).toBe('b7UiAGvt9FLd5l9-sNRxE');
        expect(keys!.device_pub.startsWith('x25519:')).toBe(true);
        expect(keys!.sign_pub.startsWith('ed25519:')).toBe(true);
    });

    it('tolerates the operator pasting surrounding noise', () => {
        // They copied a terminal, not a form field.
        const messy = `root@sovereign:~# puca-waker init\nGive these three PUBLIC values...\n${REAL_INIT_OUTPUT}\nThen write this to /etc/...`;
        expect(parseWakerKeys(messy)?.device_id).toBe('b7UiAGvt9FLd5l9-sNRxE');
    });

    it('refuses a truncated paste rather than enrolling a device that can never attest', () => {
        // THE REGRESSION THAT MATTERS. A short device id still enrols — the
        // server derives its own — but the waker's config then names an id the
        // server never assigned, so it connects, fails to attest, and reports
        // as "never comes online" with nothing pointing at the cause.
        expect(parseWakerKeys('device_id  tooshort\ndevice_pub x25519:A\nsign_pub ed25519:B')).toBeNull();
        expect(parseWakerKeys(REAL_INIT_OUTPUT.replace(/^device_pub.*$/m, ''))).toBeNull();
        expect(parseWakerKeys(REAL_INIT_OUTPUT.replace(/^sign_pub.*$/m, ''))).toBeNull();
        expect(parseWakerKeys('')).toBeNull();
        expect(parseWakerKeys('nothing useful here')).toBeNull();
    });

    it('refuses keys with the wrong algorithm prefix', () => {
        // The device id is a hash over both key strings including their
        // prefixes, so a swapped pair derives a different id server-side.
        const swapped = REAL_INIT_OUTPUT
            .replace('x25519:', 'ed25519:')
            .replace(/sign_pub\s+ed25519:/, 'sign_pub   x25519:');
        expect(parseWakerKeys(swapped)).toBeNull();
    });
});
