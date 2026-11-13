/**
 * Android's BACK closes the top layer first (hooks/useBackClose.ts,
 * api/mobileApp.ts interceptBack). Until 2026-11-12 only a fullscreen video,
 * a stream and a camera tile took it: from every menu, dialog, sheet,
 * Settings and the picture viewer, Back sent the app to the home screen.
 *
 * This pins the coverage, not the behaviour (backCloseOverlays.test.tsx
 * drives real overlays): every component file that draws a layer (a dialog
 * or menu role, aria-modal, or an overlay/backdrop/scrim/popup/modal class)
 * must take Back, or be listed below with the reason it does not. A new
 * dialog that forgets fails here, naming its file.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', 'components');

/** What a layer looks like in the markup. */
const LAYER = /role="(?:dialog|alertdialog|menu)"|aria-modal|className="[^"]*(?:-overlay|-backdrop|-scrim|-popup|-modal)[ "]/;
const TAKES_BACK = /\buseBackClose\(|\binterceptBack\(/;

/** Draws something that matches LAYER but is not one Back should close. */
const NOT_A_LAYER: Record<string, string> = {
    'ClipAttachment.tsx': 'the play button laid over a clip in a message, not a layer',
    'StreamStatsOverlay.tsx': 'the stats text drawn over a stream, not a layer',
    'DeviceStageMobileKeyboard.tsx': "the stage's keyboard bar: DeviceStage's activeMobileMenu ('keyboard'), which takes Back",
    'DeviceStageMobileMenus.tsx': "its menus and their confirm are DeviceStage's activeMobileMenu, which takes Back",
};

/** A layer that deliberately leaves Back alone. */
const LEAVES_BACK: Record<string, string> = {
    'ClipComposerModal.tsx': 'the desktop app only: Clips are captured on the desktop',
    'DeviceStageDesktopBar.tsx': "the desktop's bar; a phone's stage draws DeviceStageMobileMenus instead",
    'FileAccessPrompt.tsx': "a remote-control host's question something waits on: Back must not answer it",
    'HostConsentPrompt.tsx': "a remote-control host's question something waits on: Back must not answer it",
    'UnattendedPassphrasePrompt.tsx': "a remote-control host's question something waits on: Back must not answer it",
    'RemoteControlOverlay.tsx': "remote control OF a phone: the phone screen-share work's, not this one's",
    'ScreenShareModal.tsx': "the phone's own screen share: the phone screen-share work's, not this one's",
};

/** Layers that match no LAYER pattern, so the scan cannot find them. */
const MUST_TAKE_BACK = [
    'ContextMenu.tsx', 'EmojiPicker.tsx', 'UserContextMenu.tsx', 'ServerList.tsx', 'MessageReactions.tsx',
    'UserProfilePopup.tsx', 'ChecklistPanel.tsx', 'ServerCreateWizard.tsx', 'notes/Popover.tsx',
    'StreamStage.tsx', 'VoicePanel.tsx', 'DeviceStage.tsx', 'Chat.tsx',
    // These two hold Back and do nothing with it: a recovery code shown once, and a vote on
    // someone else's clip (Escape there declines), must be answered, and nothing under them
    // may close while they wait.
    'RecoveryCodeModal.tsx', 'ClipApprovalPrompt.tsx',
];

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return walk(p);
        return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : [];
    });
}

const files = walk(root).map((p) => ({
    name: relative(root, p).replace(/\\/g, '/'),
    src: readFileSync(p, 'utf8'),
}));

describe('Android BACK: every layer takes it or says why not', () => {
    it('every component file that draws a layer takes Back', () => {
        const missing = files
            .filter((f) => LAYER.test(f.src) && !TAKES_BACK.test(f.src))
            .filter((f) => !(f.name in NOT_A_LAYER) && !(f.name in LEAVES_BACK))
            .map((f) => f.name);
        expect(missing).toEqual([]);
    });

    it('the layers no pattern finds take Back too', () => {
        const missing = MUST_TAKE_BACK.filter((name) => {
            const f = files.find((x) => x.name === name);
            return !f || !TAKES_BACK.test(f.src);
        });
        expect(missing).toEqual([]);
    });

    it('every exception is still a file that draws a layer and takes no Back (no stale entries)', () => {
        for (const name of [...Object.keys(NOT_A_LAYER), ...Object.keys(LEAVES_BACK)]) {
            const f = files.find((x) => x.name === name);
            expect(f, `${name} no longer exists`).toBeTruthy();
            expect(LAYER.test(f!.src), `${name} no longer draws a layer`).toBe(true);
            expect(TAKES_BACK.test(f!.src), `${name} takes Back now: take it off the list`).toBe(false);
        }
    });

    it('control: the scan does find layers (a pattern that matched nothing would pass the first test)', () => {
        const layers = files.filter((f) => LAYER.test(f.src)).map((f) => f.name);
        expect(layers.length).toBeGreaterThan(40);
        expect(layers).toContain('SettingsModal.tsx');
        expect(layers).toContain('ImageLightbox.tsx');
        expect(layers).toContain('EditChannelModal.tsx');
    });
});
