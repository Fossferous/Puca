/**
 * The phone's bottom toolbar reports its own height, the way the keyboard bar
 * does — because the stage now lays the remote picture out BESIDE the chrome
 * rather than underneath it. In landscape the picture fills the height, so a
 * toolbar floating over the surface hid the bottom of the remote screen (the
 * Windows taskbar) and the only way to see it was to collapse the bar. The
 * stage reserves exactly the measured height instead.
 *
 * jsdom has no layout, so this pins only that the prop is WIRED — it fires on
 * mount with a number and reports 0 on unmount — not the number itself. The
 * number on a real phone is whatever mobile.css's button rule and the bar's
 * own min-height resolve to, which is precisely why it is measured.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceControlSession } from '../api/devices/session';
import { MobileToolbar } from '../components/DeviceStageMobileToolbar';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const session = { id: 'ds-1', role: 'controller', phase: 'active' } as unknown as DeviceControlSession;

function mount(onHeight?: (px: number) => void) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <MobileToolbar
                session={session}
                onCloseSession={() => {}}
                activeMenu={null}
                setActiveMenu={() => {}}
                onMinimize={() => {}}
                onHeight={onHeight}
            />,
        );
    });
}

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('the mobile toolbar reports its measured height', () => {
    it('fires on mount with a number and zeroes on unmount', () => {
        const onHeight = vi.fn();
        mount(onHeight);
        expect(onHeight, 'the stage cannot reserve a height it is never told').toHaveBeenCalled();
        expect(typeof onHeight.mock.calls[0][0]).toBe('number');

        onHeight.mockClear();
        act(() => root!.unmount());
        root = null;
        expect(onHeight, 'a collapsed bar must give the picture its room back').toHaveBeenCalledWith(0);
    });

    it('is optional — the bar renders its seven controls without it', () => {
        mount();
        expect(host!.querySelectorAll('button.device-stage-mobile-btn').length).toBe(7);
    });
});
