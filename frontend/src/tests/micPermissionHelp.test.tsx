/**
 * The "Microphone Access Blocked" dialog names the path that exists on the
 * platform the user is on. The Android app used to get the BROWSER arm —
 * "click the lock icon in your address bar" — which a WebView cannot follow.
 * Positive control: with the Android arm removed (falling through to the
 * browser arm, as before), the first assertion below fails.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MicPermissionHelp, type MicHelpPlatform } from '../components/MicPermissionHelp';

let container: HTMLDivElement;
let root: Root;

async function mount(platform: MicHelpPlatform, extra: Partial<React.ComponentProps<typeof MicPermissionHelp>> = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<MicPermissionHelp platform={platform} onRetry={() => {}} onDismiss={() => {}} {...extra} />);
    });
    return container.textContent ?? '';
}
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('MicPermissionHelp', () => {
    it('android: names the Settings path, never the address bar', async () => {
        const text = await mount('android', { onOpenAndroidSettings: async () => true });
        expect(text).not.toMatch(/address bar/i);
        expect(text).toMatch(/Android Settings/);
        expect(text).toMatch(/Permissions/);
        expect(Array.from(container.querySelectorAll('button')).map(b => b.textContent)).toContain('Open app settings');
        expect(text).not.toMatch(/Reset Permissions/);
    });

    it('android: when the APK cannot open its settings page, the button gives way to the manual path', async () => {
        await mount('android', { onOpenAndroidSettings: async () => false });
        const open = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Open app settings')!;
        await act(async () => { open.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(container.textContent).toMatch(/open Android Settings by hand/i);
        expect(Array.from(container.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Open app settings');
    });

    it('web: the browser instructions are unchanged', async () => {
        const text = await mount('web');
        expect(text).toMatch(/address bar/i);
        expect(text).not.toMatch(/Android Settings/);
    });

    it('desktop: Windows steps plus the reset button', async () => {
        const text = await mount('tauri', { onResetDesktop: () => {} });
        expect(text).toMatch(/Windows Settings/);
        expect(text).not.toMatch(/address bar/i);
        expect(Array.from(container.querySelectorAll('button')).map(b => b.textContent)).toContain('Reset Permissions & Restart');
    });
});
