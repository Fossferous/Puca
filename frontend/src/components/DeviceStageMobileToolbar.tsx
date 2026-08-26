import React, { useEffect, useRef } from 'react';
import { type DeviceControlSession } from '../api/devices/session';
import {
    ChevronDownIcon,
    CloseIcon,
    KeyboardIcon,
    MessageIcon,
    MonitorIcon,
    MoreIcon,
    MouseIcon,
} from './Icons';

interface ToolbarProps {
    session: DeviceControlSession;
    onCloseSession: () => void;
    activeMenu: string | null;
    setActiveMenu: (m: string | null) => void;
    /** Fold the bar away. Its own callback, not a menu value: a folded bar
     *  must survive the keyboard panel opening by itself. */
    onCollapse: () => void;
    /** The keyboard button, when the stage wants more than toggle semantics
     *  (re-raising an IME the back gesture dismissed instead of closing the
     *  panel). Falls back to the plain toggle when absent. */
    onKeyboard?: () => void;
    onMinimize: () => void;
    /** This bar's rendered height in CSS px (home-indicator inset included),
     *  on mount and on every resize, and 0 on unmount. The stage reserves
     *  exactly this much of the picture's box for it, so the bar sits BESIDE
     *  the remote screen rather than over its bottom edge — where the Windows
     *  taskbar is. MEASURED, like the keyboard bar's: mobile.css's blanket
     *  `button { min-height: 44px }` decides the real height, not the
     *  `--device-toolbar-h` guess in the stylesheet. */
    onHeight?: (px: number) => void;
}

export function MobileToolbar({ onCloseSession, activeMenu, setActiveMenu, onCollapse, onKeyboard, onMinimize, onHeight }: ToolbarProps) {
    const toggleMenu = (menu: string) => {
        setActiveMenu(activeMenu === menu ? null : menu);
    };

    const rootRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = rootRef.current;
        if (!el || !onHeight) return;
        const read = () => onHeight(el.getBoundingClientRect().height);
        read();
        // jsdom has no ResizeObserver; the bar must still render there.
        if (typeof ResizeObserver !== 'function') return () => onHeight(0);
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => {
            ro.disconnect();
            onHeight(0);
        };
    }, [onHeight]);

    return (
        <div className="device-stage-mobile-toolbar" ref={rootRef}>
            <button className="device-stage-mobile-btn" onClick={onCloseSession} title="Close">
                <CloseIcon />
            </button>
            <button 
                className={`device-stage-mobile-btn ${activeMenu === 'monitor' ? 'active' : ''}`} 
                onClick={() => toggleMenu('monitor')}
                title="Display"
            >
                <MonitorIcon />
            </button>
            <button
                className={`device-stage-mobile-btn ${activeMenu === 'keyboard' ? 'active' : ''}`}
                onClick={() => (onKeyboard ?? (() => toggleMenu('keyboard')))()}
                title="Keyboard"
            >
                <KeyboardIcon />
            </button>
            <button 
                className={`device-stage-mobile-btn ${activeMenu === 'mouse' ? 'active' : ''}`} 
                onClick={() => toggleMenu('mouse')}
                title="Mouse"
            >
                <MouseIcon />
            </button>
            <button 
                className="device-stage-mobile-btn" 
                onClick={onMinimize}
                title="Chat"
            >
                <MessageIcon />
            </button>
            <button 
                className={`device-stage-mobile-btn ${activeMenu === 'more' ? 'active' : ''}`} 
                onClick={() => toggleMenu('more')}
                title="More"
            >
                <MoreIcon />
            </button>
            <button className="device-stage-mobile-btn" onClick={onCollapse} title="Collapse">
                <ChevronDownIcon />
            </button>
        </div>
    );
}

export function MobileToolbarToggle({ onExpand }: { onExpand: () => void }) {
    return (
        <button className="device-stage-mobile-toolbar-toggle" onClick={onExpand}>
            <span>&lt;</span>
        </button>
    );
}
