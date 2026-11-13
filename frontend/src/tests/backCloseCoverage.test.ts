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

/**
 * The scan above is per FILE: one Back hook anywhere passes a file that draws
 * several layers. These are such layers one by one: how each is drawn (which
 * pins the entry to the real markup) and the state it is drawn under, which a
 * useBackClose's `active` must name. Before this, VoicePanel passed on its call
 * bar's hook while its camera full screen took no Back (review finding).
 */
const EACH_LAYER: Array<{ file: string; layer: string; drawn: RegExp; state: string }> = [
    { file: 'VoicePanel.tsx', layer: "the camera's full screen", drawn: /\{isCameraOn && isFullscreen && \(\s*<div className="camera-fullscreen"/, state: 'isFullscreen' },
    { file: 'VoicePanel.tsx', layer: "the call's Encrypted explanation", drawn: /\{e2eeTipOpen && createPortal\(/, state: 'e2eeTipOpen' },
    { file: 'Chat.tsx', layer: 'the pinned messages', drawn: /\{showPins && \(\(\) => \{/, state: 'showPins' },
    { file: 'DeviceStage.tsx', layer: "the phone's stage menus", drawn: /\{isMobile && activeMobileMenu === 'more' && \(/, state: 'activeMobileMenu' },
];
const heldUnder = (state: string) => new RegExp(String.raw`\buseBackClose\([^;]*\b${state}\b[^;]*\);`);

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

    it('a file that draws several layers takes Back for each of them', () => {
        const missing = EACH_LAYER.filter(({ file, drawn, state }) => {
            const f = files.find((x) => x.name === file);
            expect(f, `${file} no longer exists`).toBeTruthy();
            expect(drawn.test(f!.src), `${file}: ${drawn} no longer matches how the layer is drawn`).toBe(true);
            return !heldUnder(state).test(f!.src);
        }).map(({ file, layer }) => `${file}: ${layer}`);
        expect(missing).toEqual([]);
    });

    it('control: the per-layer check fails a layer whose state no Back hook names', () => {
        const src = 'useBackClose(() => setControlsExpanded(false), controlsExpanded && isPhonePanel);\n'
            + '{isCameraOn && isFullscreen && (<div className="camera-fullscreen" />)}';
        expect(heldUnder('isFullscreen').test(src)).toBe(false);
        expect(heldUnder('controlsExpanded').test(src)).toBe(true);
        // The close function naming it is not enough: setIsFullscreen is not isFullscreen.
        expect(heldUnder('isFullscreen').test('useBackClose(() => setIsFullscreen(false), isCameraOn);')).toBe(false);
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
