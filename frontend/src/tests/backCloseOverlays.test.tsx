/**
 * Android's BACK on real overlays (hooks/useBackClose.ts over
 * api/mobileApp.ts interceptBack). Before 2026-11-12 a menu, a dialog, the
 * picture viewer and Settings took no Back at all: the press sent the app to
 * the home screen with the layer still open (seen on the real APK). Here the
 * native side is the plugin's two calls, played: `back()` is the gesture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    platform: 'android',
    enabled: [] as boolean[],
    listeners: [] as Array<() => void>,
}));

vi.mock('@capacitor/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@capacitor/core')>();
    const absent = () => new Proxy({}, {
        get: (_t, p) => (p === 'then' ? undefined : () => Promise.reject(new Error('not here'))),
    });
    return {
        ...real,
        Capacitor: {
            ...real.Capacitor,
            getPlatform: () => h.platform,
            isNativePlatform: () => h.platform !== 'web',
            isPluginAvailable: () => false,
        },
        registerPlugin: (name: string) => (name === 'SovereignApp'
            ? {
                setBackIntercept: async (o: { enabled: boolean }) => { h.enabled.push(o.enabled); },
                addListener: async (evt: string, cb: () => void) => {
                    if (evt === 'backButton') h.listeners.push(cb);
                    return { remove: async () => { h.listeners = h.listeners.filter(f => f !== cb); } };
                },
            }
            : absent()),
    };
});

import { ContextMenu } from '../components/ContextMenu';
import { NotesDialog } from '../components/NotesDialog';
import { ImageLightbox } from '../components/ImageLightbox';
import { WelcomePopup } from '../components/WelcomePopup';
import { ShareUnavailableButton } from '../components/ShareUnavailableButton';
import ScreenShareModal from '../components/ScreenShareModal';
import { useBackClose } from '../hooks/useBackClose';

let host: HTMLDivElement;
let root: Root;
const back = () => act(async () => { for (const cb of [...h.listeners]) cb(); });
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
    h.platform = 'android';
    h.enabled = [];
    h.listeners = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('Android BACK closes the overlay on top, not the app', () => {
    it('a menu (the long-press message menu is a ContextMenu)', async () => {
        const onClose = vi.fn();
        act(() => root.render(<ContextMenu items={[{ id: 'copy', label: 'Copy Text', onClick: () => {} }]} position={{ x: 10, y: 10 }} onClose={onClose} />));
        await settle();
        expect(h.enabled.at(-1)).toBe(true);
        await back();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the picture viewer', async () => {
        const onClose = vi.fn();
        act(() => root.render(<ImageLightbox url="blob:picture" name="p.png" onClose={onClose} />));
        await settle();
        await back();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a dialog over a dialog: the top one first, then the one under it, then Back is the system\'s again', async () => {
        const closedOuter = vi.fn();
        const closedInner = vi.fn();
        function Outer() {
            const [innerOpen, setInnerOpen] = useState(false);
            const [, rerender] = useState(0);
            return (
                <NotesDialog title="Outer" onClose={closedOuter}>
                    <button id="open-inner" onClick={() => setInnerOpen(true)}>open</button>
                    <button id="rerender" onClick={() => rerender(n => n + 1)}>again</button>
                    {innerOpen && (
                        <NotesDialog title="Inner" onClose={() => { closedInner(); setInnerOpen(false); }}>
                            <span>inner</span>
                        </NotesDialog>
                    )}
                </NotesDialog>
            );
        }
        act(() => root.render(<Outer />));
        await settle();
        act(() => document.getElementById('open-inner')!.click());
        // The outer dialog drawing again must not lift it over the inner one.
        act(() => document.getElementById('rerender')!.click());
        await settle();
        await back();
        expect(closedInner).toHaveBeenCalledTimes(1);
        expect(closedOuter).not.toHaveBeenCalled();
        await settle();
        expect(h.enabled.at(-1)).toBe(true);
        await back();
        expect(closedOuter).toHaveBeenCalledTimes(1);
        act(() => root.render(<span />));
        await settle();
        expect(h.enabled.at(-1)).toBe(false);
        expect(h.listeners).toHaveLength(0);
    });

    it('a busy dialog stays open, as it does for Escape', async () => {
        const onClose = vi.fn();
        act(() => root.render(<NotesDialog title="Saving" onClose={onClose} busy><span /></NotesDialog>));
        await settle();
        await back();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('the newest close function is the one called', async () => {
        const first = vi.fn();
        const second = vi.fn();
        function Probe({ onClose }: { onClose: () => void }) { useBackClose(onClose); return null; }
        act(() => root.render(<Probe onClose={first} />));
        act(() => root.render(<Probe onClose={second} />));
        await settle();
        await back();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('a question that must be answered holds Back: nothing under it closes (review finding)', async () => {
        // RecoveryCodeModal and ClipApprovalPrompt take Back and do nothing with it. Without
        // that, Back went past them and closed Settings (or folded the call bar) out of sight.
        const closedUnder = vi.fn();
        function Under() { useBackClose(closedUnder); return null; }
        function MustAnswer({ up }: { up: boolean }) { useBackClose(() => {}, up); return null; }
        act(() => root.render(<><Under /><MustAnswer up={false} /></>));
        act(() => root.render(<><Under /><MustAnswer up /></>));
        await settle();
        await back();
        expect(closedUnder).not.toHaveBeenCalled();
        // CONTROL: answered (gone), the next Back closes what was under it.
        act(() => root.render(<><Under /><MustAnswer up={false} /></>));
        await settle();
        await back();
        expect(closedUnder).toHaveBeenCalledTimes(1);
    });

    it('a popup with no other close than its X (the first-run welcome)', async () => {
        const onDismiss = vi.fn();
        act(() => root.render(<WelcomePopup onCreateServer={() => {}} onJoinServer={() => {}} onDismiss={onDismiss} />));
        await settle();
        await back();
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('the card that says why Share Screen is not here (the Android app that cannot share, review finding)', async () => {
        act(() => root.render(<ShareUnavailableButton reason="android-app" />));
        const card = () => host.querySelector('[data-testid="screenshare-unavailable-card"]');
        act(() => (host.querySelector('[data-testid="screenshare-unavailable"]') as HTMLButtonElement).click());
        await settle();
        expect(card(), 'the card is open').toBeTruthy();
        await back();
        expect(card(), 'Back closed it').toBeNull();
        await settle();
        expect(h.enabled.at(-1), 'and gave Back to the system again').toBe(false);
    });

    describe('the Share dialog (review finding: Back folded the call bar out of sight behind it)', () => {
        const capture = { pending: false };
        const props = {
            onCaptureScreen: () => (capture.pending ? new Promise<null>(() => {}) : Promise.resolve(null)),
            onGoLive: async () => {},
            onCancelAfterCapture: () => {},
        };
        beforeEach(() => { capture.pending = false; });

        it('over the call bar opened to all its controls, Back closes the dialog and leaves the bar', async () => {
            const foldedBar = vi.fn();
            const onClose = vi.fn();
            function Bar() { useBackClose(foldedBar); return null; }
            act(() => root.render(<><Bar /></>));
            act(() => root.render(<><Bar /><ScreenShareModal isOpen launch="settings" onClose={onClose} {...props} /></>));
            await settle();
            expect(host.querySelector('.stream-modal-overlay'), 'the dialog is drawn').toBeTruthy();
            await back();
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(foldedBar).not.toHaveBeenCalled();
            // CONTROL: the dialog gone, the next Back folds the bar.
            act(() => root.render(<><Bar /><ScreenShareModal isOpen={false} launch="settings" onClose={onClose} {...props} /></>));
            await settle();
            await back();
            expect(foldedBar).toHaveBeenCalledTimes(1);
        });

        it('while it works (its X disabled), Back holds and closes nothing under it either', async () => {
            const foldedBar = vi.fn();
            const onClose = vi.fn();
            function Bar() { useBackClose(foldedBar); return null; }
            capture.pending = true;
            act(() => root.render(<><Bar /></>));
            act(() => root.render(<><Bar /><ScreenShareModal isOpen launch="settings" onClose={onClose} {...props} /></>));
            await settle();
            act(() => (host.querySelector('[data-testid="share-go-live"]') as HTMLButtonElement).click());
            await settle();
            expect((host.querySelector('.stream-modal-close') as HTMLButtonElement).disabled, 'busy').toBe(true);
            await back();
            expect(onClose).not.toHaveBeenCalled();
            expect(foldedBar).not.toHaveBeenCalled();
        });

        it("a quick launch draws no dialog, so it holds no Back (the picker is Android's own)", async () => {
            const foldedBar = vi.fn();
            const onClose = vi.fn();
            function Bar() { useBackClose(foldedBar); return null; }
            capture.pending = true;
            act(() => root.render(<><Bar /></>));
            act(() => root.render(<><Bar /><ScreenShareModal isOpen launch="quick" onClose={onClose} {...props} /></>));
            await settle();
            expect(host.querySelector('.stream-modal-overlay')).toBeNull();
            await back();
            expect(onClose).not.toHaveBeenCalled();
            expect(foldedBar).toHaveBeenCalledTimes(1);
        });
    });

    it('control: off Android (the web, the desktop app) nothing is asked of the native side', async () => {
        h.platform = 'web';
        act(() => root.render(<ContextMenu items={[]} position={{ x: 0, y: 0 }} onClose={() => {}} />));
        await settle();
        expect(h.enabled).toEqual([]);
        expect(h.listeners).toHaveLength(0);
    });
});
