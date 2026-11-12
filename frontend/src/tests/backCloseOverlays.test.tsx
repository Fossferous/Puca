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

    it('a popup with no other close than its X (the first-run welcome)', async () => {
        const onDismiss = vi.fn();
        act(() => root.render(<WelcomePopup onCreateServer={() => {}} onJoinServer={() => {}} onDismiss={onDismiss} />));
        await settle();
        await back();
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('control: off Android (the web, the desktop app) nothing is asked of the native side', async () => {
        h.platform = 'web';
        act(() => root.render(<ContextMenu items={[]} position={{ x: 0, y: 0 }} onClose={() => {}} />));
        await settle();
        expect(h.enabled).toEqual([]);
        expect(h.listeners).toHaveLength(0);
    });
});
