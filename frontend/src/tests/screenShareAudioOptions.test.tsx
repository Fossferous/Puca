/**
 * The "All system audio (except Púca)" option is REMOVED, permanently.
 *
 * WASAPI's exclude-mode loopback only filters audio sessions created AFTER
 * the loopback client initialises. Púca's own voice call always predates
 * it (that was the whole point of the mode), so the call echoed straight back
 * into every stream and nothing on our side could prevent it. This test is
 * the tombstone: if the option ever reappears in the desktop picker, whoever
 * added it needs to have solved the timing problem first.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../api/platform', () => ({ isTauri: () => true }));

import ScreenShareModal from '../components/ScreenShareModal';

describe('screen share audio options (desktop)', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it("offers exactly the window's app, chosen apps and no audio — no system-audio mode", async () => {
        const div = document.createElement('div');
        document.body.appendChild(div);
        const root = createRoot(div);
        await act(async () => {
            root.render(
                <ScreenShareModal
                    isOpen={true}
                    onClose={() => {}}
                    onCaptureScreen={async () => null}
                    onGoLive={async () => {}}
                    onCancelAfterCapture={() => {}}
                />,
            );
        });

        const options = [...div.querySelectorAll('select.app-select option')];
        // 'auto' (the shared window's own app) and 'pick' (the app list) are
        // both app-scoped: include-mode captures of named processes, which
        // structurally cannot carry Púca's own call.
        expect(options.map(o => (o as HTMLOptionElement).value)).toEqual(['auto', 'pick', 'none']);
        expect(div.textContent).not.toMatch(/system audio/i);
        await act(async () => root.unmount());
    });
});
