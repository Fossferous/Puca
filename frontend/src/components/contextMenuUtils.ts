import { useState, useCallback } from 'react';
import type { ContextMenuItem } from './ContextMenu';
import {
    canCopyImageLink,
    canCopyImages,
    copyImageToClipboard,
    describeCopyFailure,
} from '../api/copyImage';
import { decodeClipRef } from '../api/clips/clipRef';
import { formatClock } from '../api/clips/clipPresets';

// --- Pure message-action text helpers (unit-tested in tests/messageActions.test.ts) ---

/**
 * Markdown-quote a message: "> " before every line, plus a trailing newline so
 * the composer caret lands on a fresh line after the quote. Trailing newlines
 * are stripped first so quoting can't produce empty "> " tail lines.
 */
export function formatQuote(content: string): string {
    const trimmed = content.replace(/\n+$/, '');
    return trimmed.split('\n').map(line => `> ${line}`).join('\n') + '\n';
}

/**
 * Compose the text sent when forwarding a message: a quoted "Forwarded" marker
 * line, then the original (decrypted) content verbatim. Encrypted-attachment
 * markdown carries its own key, so media forwards work like copy-paste; the
 * send path re-encrypts the whole text for the target channel/DM.
 */
// icon-lint:allow-emoji — this arrow is MESSAGE TEXT that gets encrypted and
// sent, not chrome. It renders inside someone else's message, where an icon
// component cannot go. tests/messageActions.test.ts asserts the exact string.
export function buildForwardText(content: string): string {
    // Attachment keys travel (the forward re-encrypts for the target). A CLIP
    // ref does NOT: its key would let the footage play where nobody consented,
    // so the payload is scrubbed here as well as the Forward action being
    // hidden for clip posts in Chat.tsx (docs/CLIPS.md).
    return `> ↪ Forwarded\n${scrubClipRefs(content)}`;
}
// icon-lint:end

/** Drop the payload of every clip ref (the packed manifest IS the key). The
 *  bare `sovereign-clip:v1` left behind renders as "clip removed", never a link. */
export function scrubClipRefs(content: string): string {
    return content.replace(/sovereign-clip:v1\?[^\s)]*/g, 'sovereign-clip:v1');
}

/**
 * The short text a reply banner/preview shows for a message. A clip post is
 * summarised as `Clip · 2:04` — never its href, which is 1.6k of base64 that
 * carries the key. Anything else is sliced with an ellipsis like before.
 */
export function replyPreviewText(content: string, max: number): string {
    const m = /sovereign-clip:v1\?[A-Za-z0-9_-]+/.exec(content);
    if (m) {
        const manifest = decodeClipRef(m[0]);
        if (manifest) return `Clip · ${formatClock(manifest.durationMs / 1000)}`;
        return 'Clip';
    }
    if (/sovereign-clip:v1(?![?])/.test(content)) return 'Clip (removed)';
    return content.length > max ? `${content.slice(0, max)}...` : content;
}

/**
 * Remove the embedded AES decryption key (`k=…`) from any `sovereign-enc:`
 * attachment refs in `content`. The key rides inside the (E2EE) message so
 * recipients can decrypt the file, but it must not ESCAPE that envelope: Copy
 * Text puts content on the OS clipboard and Quote drops it into the composer as
 * visible plaintext, so both scrub the key first. Forward deliberately keeps it
 * (it re-encrypts for the target, so the key never leaves E2EE). (audit LOW)
 */
export function stripAttachmentKeys(content: string): string {
    return content
        .replace(/sovereign-enc:([^\s)?]+)\?([^\s)]*)/g, (_full, id, query) => {
            // k= is the file key, c= the fetch capability: either one outside the
            // envelope is access to the blob, so neither reaches the clipboard.
            const kept = (query as string).split('&').filter(kv => kv.length > 0 && !/^[kc]=/.test(kv));
            return kept.length ? `sovereign-enc:${id}?${kept.join('&')}` : `sovereign-enc:${id}`;
        })
        // A clip ref (docs/CLIPS.md) is one packed blob whose key cannot be
        // separated from the rest: drop the whole payload (scrubClipRefs).
        .replace(/sovereign-clip:v1\?[^\s)]*/g, 'sovereign-clip:v1');
}

/**
 * The image URL under a right-click, or null if the click wasn't on one.
 *
 * Checks `tagName` rather than `instanceof HTMLImageElement`: the latter is
 * false across realms (an iframe, or jsdom in tests) and would make the menu
 * item silently never appear.
 *
 * `currentSrc` first — for a responsive image that is the variant actually
 * displayed, and it is what the user means by "this image".
 */
export function imageSrcFromTarget(target: EventTarget | null): string | null {
    const el = target as HTMLElement | null;
    if (!el || el.tagName !== 'IMG') return null;
    const img = el as HTMLImageElement;
    return img.currentSrc || img.getAttribute('src') || null;
}

/**
 * Image actions to splice onto a context menu when the click landed on an
 * image. Empty when it did not, so callers can spread unconditionally.
 *
 * `onNotice` reports failures. Success stays silent, matching Copy Text and
 * every other copy action here — but a failure that says nothing is how you
 * ship a menu item that does nothing and nobody can tell.
 */
export function imageMenuItems(
    target: EventTarget | null,
    onNotice: (message: string) => void,
): ContextMenuItem[] {
    const src = imageSrcFromTarget(target);
    if (!src) return [];

    const items: ContextMenuItem[] = [];

    // Hidden rather than disabled where the engine cannot do it at all: a
    // greyed-out row the user can never enable is just clutter. A per-image
    // failure (a host refusing CORS) is different and is reported when it
    // happens, because it is not knowable up front.
    if (canCopyImages()) {
        items.push({
            id: 'copy-image',
            label: 'Copy Image',
            icon: 'image',
            onClick: () => {
                void copyImageToClipboard(src).then(r => {
                    if (!r.ok) onNotice(describeCopyFailure(r.reason));
                });
            },
        });
    }

    if (canCopyImageLink(src)) {
        items.push({
            id: 'copy-image-link',
            label: 'Copy Image Link',
            icon: 'link',
            onClick: () => {
                // Reported, not discarded. `navigator.clipboard` is UNDEFINED
                // outside a secure context (so this throws synchronously rather
                // than rejecting), and writeText rejects outright when the
                // document isn't focused or permission is refused. Dropping the
                // promise made this the exact thing the module warns against —
                // a menu item that does nothing and says nothing.
                try {
                    navigator.clipboard.writeText(src)
                        .catch(() => onNotice('Couldn’t write to the clipboard.'));
                } catch {
                    onNotice('Couldn’t write to the clipboard.');
                }
            },
        });
    }

    if (items.length > 0) items.push(menuItems.separator());
    return items;
}

// Hook to manage context menu state
export function useContextMenu() {
    const [contextMenu, setContextMenu] = useState<{
        items: ContextMenuItem[];
        position: { x: number; y: number };
    } | null>(null);

    const showContextMenu = useCallback((
        e: React.MouseEvent,
        items: ContextMenuItem[]
    ) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
            items,
            position: { x: e.clientX, y: e.clientY },
        });
    }, []);

    const hideContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    return { contextMenu, showContextMenu, hideContextMenu };
}

// Pre-built menu item generators
export const menuItems = {
    channel: {
        edit: (onEdit: () => void): ContextMenuItem => ({
            id: 'edit-channel',
            label: 'Edit Channel',
            icon: 'pencil',
            onClick: onEdit,
        }),
        delete: (onDelete: () => void): ContextMenuItem => ({
            id: 'delete-channel',
            label: 'Delete Channel',
            icon: 'trash',
            danger: true,
            onClick: onDelete,
        }),
        mute: (onMute: () => void): ContextMenuItem => ({
            id: 'mute-channel',
            label: 'Mute Channel',
            icon: 'bell-off',
            onClick: onMute,
        }),
        copyId: (channelId: number): ContextMenuItem => ({
            id: 'copy-channel-id',
            label: 'Copy Channel ID',
            icon: 'copy',
            onClick: () => navigator.clipboard.writeText(String(channelId)),
        }),
    },
    message: {
        // On touch this is the ONLY way to add a reaction: the inline +
        // button is hidden there (MessageReactions.css), and long-press is
        // what opens this menu. Desktop right-click gets it too, for parity.
        react: (onReact: () => void): ContextMenuItem => ({
            id: 'add-reaction',
            label: 'Add Reaction',
            icon: 'smile',
            onClick: onReact,
        }),
        reply: (onReply: () => void): ContextMenuItem => ({
            id: 'reply',
            label: 'Reply',
            icon: 'reply',
            onClick: onReply,
        }),
        quote: (onQuote: () => void): ContextMenuItem => ({
            id: 'quote',
            label: 'Quote',
            icon: 'note',
            onClick: onQuote,
        }),
        forward: (onForward: () => void): ContextMenuItem => ({
            id: 'forward',
            label: 'Forward',
            icon: 'forward',
            onClick: onForward,
        }),
        edit: (onEdit: () => void): ContextMenuItem => ({
            id: 'edit-message',
            label: 'Edit Message',
            icon: 'pencil',
            onClick: onEdit,
        }),
        delete: (onDelete: () => void): ContextMenuItem => ({
            id: 'delete-message',
            label: 'Delete for Everyone',
            icon: 'trash',
            danger: true,
            onClick: onDelete,
        }),
        // Local-only hide — removes the message from THIS account's view and
        // nothing else. Available on any message (yours or not, channel or
        // DM), because it deletes nothing; the caller shows an Undo toast
        // rather than a confirm.
        hide: (onHide: () => void): ContextMenuItem => ({
            id: 'hide-message',
            label: 'Delete for Me',
            icon: 'eye-off',
            onClick: onHide,
        }),
        pin: (onPin: () => void): ContextMenuItem => ({
            id: 'pin-message',
            label: 'Pin Message',
            icon: 'pin',
            onClick: onPin,
        }),
        copy: (content: string): ContextMenuItem => ({
            id: 'copy-text',
            label: 'Copy Text',
            icon: 'copy',
            // Scrub attachment keys so an accidental paste can't leak them. (audit LOW)
            onClick: () => navigator.clipboard.writeText(stripAttachmentKeys(content)),
        }),
        copyId: (messageId: string): ContextMenuItem => ({
            id: 'copy-message-id',
            label: 'Copy Message ID',
            icon: 'hash',
            onClick: () => navigator.clipboard.writeText(messageId),
        }),
    },
    user: {
        profile: (onViewProfile: () => void): ContextMenuItem => ({
            id: 'view-profile',
            label: 'Profile',
            icon: 'user',
            onClick: onViewProfile,
        }),
        message: (onMessage: () => void): ContextMenuItem => ({
            id: 'send-message',
            label: 'Message',
            icon: 'message',
            onClick: onMessage,
        }),
        addFriend: (onAddFriend: () => void): ContextMenuItem => ({
            id: 'add-friend',
            label: 'Add Friend',
            icon: 'user-add',
            onClick: onAddFriend,
        }),
        kick: (onKick: () => void): ContextMenuItem => ({
            id: 'kick',
            label: 'Kick',
            icon: 'user-remove',
            danger: true,
            onClick: onKick,
        }),
        ban: (onBan: () => void): ContextMenuItem => ({
            id: 'ban',
            label: 'Ban',
            icon: 'gavel',
            danger: true,
            onClick: onBan,
        }),
        copyId: (userId: number): ContextMenuItem => ({
            id: 'copy-user-id',
            label: 'Copy User ID',
            icon: 'hash',
            onClick: () => navigator.clipboard.writeText(String(userId)),
        }),
    },
    server: {
        invite: (onInvite: () => void): ContextMenuItem => ({
            id: 'invite',
            label: 'Invite People',
            icon: 'mail',
            onClick: onInvite,
        }),
        settings: (onSettings: () => void): ContextMenuItem => ({
            id: 'server-settings',
            label: 'Server Settings',
            icon: 'settings',
            onClick: onSettings,
        }),
        createChannel: (onCreate: () => void): ContextMenuItem => ({
            id: 'create-channel',
            label: 'Create Channel',
            icon: 'plus',
            onClick: onCreate,
        }),
        leave: (onLeave: () => void): ContextMenuItem => ({
            id: 'leave-server',
            label: 'Leave Server',
            icon: 'logout',
            danger: true,
            onClick: onLeave,
        }),
        copyId: (serverId: string): ContextMenuItem => ({
            id: 'copy-server-id',
            label: 'Copy Server ID',
            icon: 'hash',
            onClick: () => navigator.clipboard.writeText(serverId),
        }),
    },
    separator: (): ContextMenuItem => ({
        id: 'separator',
        label: '',
        separator: true,
    }),
};
