/**
 * Right-click a member > "Move to": which voice actions the user menu offers,
 * and that "Move to" expands INLINE under its own button.
 *
 * Two defects, both shipped:
 *  - "Move to" was a side flyout (`.context-submenu`, `left: 100%`) inside a
 *    menu with `overflow: hidden`, so the channel list was painted outside the
 *    clip and nobody could see it. jsdom has no layout, so the visibility
 *    itself is proved in a real browser (e2e/user-menu-move-to-real-browser.mjs);
 *    this file pins the structure that makes it visible: a toggle with
 *    aria-expanded, and the targets in the menu's own flow (`.ucm-submenu`),
 *    never in a `.context-submenu` flyout.
 *  - The member list could not move anyone unless the moderator sat in the
 *    SAME call: one `isInVoice` prop meant both "in a call with me" (local
 *    volume / mute) and "in voice at all" (moderation). The two are separate
 *    props now, and moderation must show with the listener controls off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../components/voiceState', () => ({ getCurrentStreamingUserId: () => null }));
vi.mock('../api/remoteControl', () => ({ offerControl: vi.fn() }));

import { UserContextMenu, type UserContextMenuProps } from '../components/UserContextMenu';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const TARGETS = [
    { id: 11, name: 'General voice' },
    { id: 12, name: 'AFK', isAfk: true },
];

function render(props: Partial<UserContextMenuProps>) {
    const base: UserContextMenuProps = {
        userId: 2,
        username: 'member',
        currentUserId: 1,
        position: { x: 10, y: 10 },
        showListenerControls: false,
        onClose: vi.fn(),
    };
    act(() => root.render(<UserContextMenu {...base} {...props} />));
}

const button = (text: string) =>
    [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text) ?? null;
const hasSlider = () => !!host.querySelector('input[type="range"]');

describe('UserContextMenu voice actions', () => {
    it('member list, NOT in a call with them, holding MOVE_MEMBERS: Move to + Disconnect, no local volume', () => {
        render({ showListenerControls: false, canMoveMembers: true, voiceMoveTargets: TARGETS });
        expect(button('Move to')).not.toBeNull();
        expect(button('Disconnect from voice')).not.toBeNull();
        expect(hasSlider()).toBe(false);
        expect(button('Mute')).toBeNull();
    });

    it('in a call with them, no MOVE_MEMBERS: local volume and mute, no moderation (positive control for the slider probe)', () => {
        render({ showListenerControls: true, canMoveMembers: false, voiceMoveTargets: TARGETS });
        expect(hasSlider()).toBe(true);
        expect(button('Mute')).not.toBeNull();
        expect(button('Move to')).toBeNull();
        expect(button('Disconnect from voice')).toBeNull();
    });

    it('neither: no Voice section at all', () => {
        render({ showListenerControls: false, canMoveMembers: false, voiceMoveTargets: TARGETS });
        expect(host.textContent).not.toContain('Voice');
        expect(hasSlider()).toBe(false);
    });

    it('never for yourself, whatever the props say', () => {
        render({ userId: 1, showListenerControls: true, canMoveMembers: true, voiceMoveTargets: TARGETS });
        expect(button('Move to')).toBeNull();
        expect(hasSlider()).toBe(false);
    });

    it('a member parked in AFK can be disconnected but offers no destinations', () => {
        render({ showListenerControls: false, canMoveMembers: true, voiceMoveTargets: [] });
        expect(button('Move to')).toBeNull();
        expect(button('Disconnect from voice')).not.toBeNull();
    });
});

describe('"Move to" expands inline', () => {
    it('toggles aria-expanded and lists the targets in the menu flow, not a flyout', () => {
        const onVoiceMove = vi.fn();
        const onClose = vi.fn();
        render({ showListenerControls: true, canMoveMembers: true, voiceMoveTargets: TARGETS, onVoiceMove, onClose });
        const toggle = button('Move to')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(button('General voice')).toBeNull();

        act(() => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        const target = button('General voice');
        expect(target).not.toBeNull();
        // The group the toggle controls is the one holding the targets.
        const group = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
        expect(group).not.toBeNull();
        expect(group!.contains(target)).toBe(true);
        expect(target!.closest('.ucm-submenu')).toBe(group);
        expect(target!.closest('.context-submenu')).toBeNull();

        act(() => target!.click());
        expect(onVoiceMove).toHaveBeenCalledWith(11);
        expect(onClose).toHaveBeenCalled();
    });

    it('collapses again on a second press', () => {
        render({ showListenerControls: false, canMoveMembers: true, voiceMoveTargets: TARGETS });
        const toggle = button('Move to')!;
        act(() => toggle.click());
        act(() => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(button('General voice')).toBeNull();
    });

    it('Roles uses the same inline pattern', () => {
        render({
            canModerate: true,
            availableRoles: [{ id: 21, name: 'Moderator' }],
            userRoleIds: [],
        });
        const toggle = button('Roles')!;
        expect(toggle).not.toBeNull();
        act(() => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        const box = host.querySelector('input[type="checkbox"]');
        expect(box).not.toBeNull();
        expect(box!.closest('.ucm-submenu')).not.toBeNull();
        expect(box!.closest('.context-submenu')).toBeNull();
    });
});
