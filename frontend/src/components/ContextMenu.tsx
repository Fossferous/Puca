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
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
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
                onClose();
            }
        };

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            className="context-menu"
            style={{
                left: adjustedPosition.x,
                top: adjustedPosition.y,
            }}
        >
            {items.map((item, index) => {
                if (item.separator) {
                    return <div key={`sep-${index}`} className="context-menu-separator" />;
                }

                return (
                    <button
                        key={item.id}
                        className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
                        onClick={() => {
                            if (!item.disabled && item.onClick) {
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
