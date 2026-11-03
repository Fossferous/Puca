import React, { useState, useEffect } from 'react';
import './ContextMenu.css';
import { Icon, type IconName } from './Icons';

export interface ContextMenuItem {
    id: string;
    label: string;
    /**
     * Registry name, not a glyph. This was `string` while the menus used
     * emoji, so it accepted any character at all and would have accepted
     * 'copyy' just as happily; as an IconName a typo is a compile error.
     */
    icon?: IconName;
    danger?: boolean;
    disabled?: boolean;
    separator?: boolean;
    onClick?: () => void;
}

interface ContextMenuProps {
    items: ContextMenuItem[];
    position: { x: number; y: number };
    onClose: () => void;
    /**
     * The control that opened this, when one did (showContextMenuAt), however it was pressed.
     * This renders last in the page, so with the focus left on that control everything between
     * them is in the way of a keyboard. So such a menu is a real menu: the focus goes in, and the
     * arrow keys walk it. A menu at the pointer (a right click) has none of that.
     */
    opener?: HTMLElement;
    /** What a screen reader calls it: a menu a control opened has a role to name. */
    label?: string;
    /**
     * Whether a key pressed the opener, so the first item takes the focus and the opener gets it back
     * as this closes. From a mouse or a finger the menu itself takes it, because nothing would show
     * the focus on an item and a stray Enter or Space would press it, and it goes back to nothing
     * (settleFocus).
     */
    fromKeyboard?: boolean;
}

/**
 * Where the focus goes as a menu with an opener closes. A key's menu gives it back to the opener: a
 * keyboard has to carry on from somewhere. A pointer's leaves it on nothing, and the opener does not
 * keep it: from there a stray Space or Enter opens this again as a key's (ModeSelector: a click no
 * pointer counted), with the first item under the focus for the next stray one to press, and on
 * the mode selector that item is Off. It does pass through the opener, which is where the browser
 * starts a Tab from afterwards: this menu is last in the page, so a Tab from where it was would
 * walk the whole page again. Not in Safari's engine, which starts one from the top either way.
 */
const settleFocus = (opener: HTMLElement | undefined, fromKeyboard: boolean | undefined) => {
    opener?.focus({ preventScroll: true });
    if (!fromKeyboard) opener?.blur();
};

const enabledItems = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLButtonElement>('.context-menu-item:not(:disabled)') ?? [])];

export function ContextMenu({ items, position, onClose, opener, label, fromKeyboard }: ContextMenuProps) {
    const menuRef = React.useRef<HTMLDivElement>(null);
    const [adjustedPosition, setAdjustedPosition] = useState(position);

    useEffect(() => {
        // Adjust position to stay within viewport
        if (menuRef.current) {
            // offsetWidth/Height, not getBoundingClientRect: the menu is scaling in
            // from 95% right now, and a rect would measure it 5% short and leave its
            // end past the window's edge.
            const { offsetWidth, offsetHeight } = menuRef.current;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let x = position.x;
            let y = position.y;

            if (x + offsetWidth > viewportWidth) {
                x = viewportWidth - offsetWidth - 8;
            }
            if (y + offsetHeight > viewportHeight) {
                y = viewportHeight - offsetHeight - 8;
            }

            // eslint-disable-next-line react-hooks/set-state-in-effect -- reposition after measuring the rendered menu
            setAdjustedPosition({ x, y });
        }
    }, [position]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                // From a key's menu too the press says where the focus goes: this only takes care
                // that a pointer's opener is not left holding it.
                if (!fromKeyboard) opener?.blur();
                onClose();
            }
        };

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                settleFocus(opener, fromKeyboard);
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [onClose, opener, fromKeyboard]);

    useEffect(() => {
        // preventScroll: it is scaling in, and it is already where it should be.
        if (opener) (fromKeyboard ? enabledItems(menuRef.current)[0] : menuRef.current)?.focus({ preventScroll: true });
    }, [opener, fromKeyboard]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!opener) return;
        // Held down, the Enter that opened this repeats, and the first item has the focus now.
        if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            return;
        }
        if (e.key === 'Tab') {
            // Not prevented: from the control it goes on to what comes after it, not to whatever
            // comes after the end of the page.
            opener.focus({ preventScroll: true });
            onClose();
            return;
        }
        const enabled = enabledItems(menuRef.current);
        const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? enabled[(at + 1) % enabled.length]
            : e.key === 'ArrowUp' ? enabled[(at <= 0 ? enabled.length : at) - 1]
            : e.key === 'Home' ? enabled[0]
            : e.key === 'End' ? enabled[enabled.length - 1]
            : undefined;
        if (!next) return;
        e.preventDefault();
        next.focus();
    };

    return (
        <div
            ref={menuRef}
            className="context-menu"
            role={opener ? 'menu' : undefined}
            aria-label={opener ? label : undefined}
            tabIndex={opener ? -1 : undefined}
            onKeyDown={handleKeyDown}
            style={{
                left: adjustedPosition.x,
                top: adjustedPosition.y,
            }}
        >
            {items.map((item, index) => {
                if (item.separator) {
                    return <div key={`sep-${index}`} className="context-menu-separator" role={opener ? 'separator' : undefined} />;
                }

                return (
                    <button
                        key={item.id}
                        className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
                        role={opener ? 'menuitem' : undefined}
                        onClick={() => {
                            if (!item.disabled && item.onClick) {
                                // First: a question this opens gives the focus back to what had it.
                                settleFocus(opener, fromKeyboard);
                                item.onClick();
                                onClose();
                            }
                        }}
                        disabled={item.disabled}
                    >
                        {/* The icon stays INSIDE the wrapper: .context-menu-icon sets
                            width: 20px, and CSS beats the svg's width attribute, so
                            moving the class onto the icon would stretch it. */}
                        {item.icon && <span className="context-menu-icon"><Icon name={item.icon} /></span>}
                        <span className="context-menu-label">{item.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
