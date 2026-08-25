/**
 * Renders parsed message content (markdown + mentions + channels + emoji).
 *
 * The parsing lives in utils/messageParser (pure + unit-tested); this component
 * only maps the resulting node tree to React elements and resolves mention /
 * channel names against the current server context.
 */
import React, { useState, useEffect } from 'react';
import { parseMessage, isSafeUrl, type Node } from '../utils/messageParser';
import { isImageUrl } from '../api/linkPreview';
import { isEncAttachment, parseEncAttachment, decryptToBlobUrl, videoMimeFor } from '../api/attachments';
import { isClipRef, isScrubbedClipRef } from '../api/clips/clipRef';
import { ClipAttachment } from './ClipAttachment';
import type { ClipConsent } from '../api/servers';
import { openExternalUrl } from '../api/openExternal';
import { ImageLightbox } from './ImageLightbox';
import { LockIcon, CheckCircleIcon, WarningIcon, PaperclipIcon } from './Icons';
import { saveAttachment } from '../api/saveAttachment';
import type { MemberWithRoles, Channel } from '../api/servers';

/** Fetch + decrypt an E2EE attachment and render it (image and video inline,
 *  else a download link). The plaintext bytes only ever exist in this browser. */
function EncryptedAttachment({ href, name }: { href: string; name: string }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    // Bumping this re-runs the fetch effect — `failed` used to latch forever,
    // making "reload the channel" the only retry. The common failure is the
    // SENDER's own phone fetching its just-uploaded image while the uplink is
    // still saturated; one bounded auto-retry heals that without user action,
    // and the failed state offers a manual Retry after.
    const [attempt, setAttempt] = useState(0);
    // The player couldn't decode the container (an extension-guessed video
    // that turned out unplayable) — drop back to the download chip.
    const [embedFailed, setEmbedFailed] = useState(false);
    const info = parseEncAttachment(href);
    // Not just `mime.startsWith('video/')`: refs recorded before the upload
    // side inferred types (and any browser that reports "" for .mkv) carry
    // application/octet-stream for real videos — the NAME is the signal then.
    const videoMime = info ? videoMimeFor(name, info.mime) : null;
    useEffect(() => {
        setFailed(false);
        setEmbedFailed(false);
        if (!info) { setFailed(true); return; }
        let alive = true;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        // Type the blob with the resolved video MIME so <video> gets a
        // media-typed source even when the ref said octet-stream.
        decryptToBlobUrl(info.id, info.key, videoMime ?? info.mime)
            .then((u) => { if (alive) setUrl(u); })
            .catch(() => {
                if (!alive) return;
                if (attempt === 0) {
                    // One automatic retry, delayed enough for the uplink to drain.
                    retryTimer = setTimeout(() => { if (alive) setAttempt(1); }, 2000);
                } else {
                    setFailed(true);
                }
            });
        return () => { alive = false; if (retryTimer !== undefined) clearTimeout(retryTimer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [href, attempt]);

    if (failed || !info) {
        return (
            <span className="message-attachment failed">
                <LockIcon /> [Attachment unavailable]
                {info && (
                    <button type="button" className="attachment-retry" onClick={() => setAttempt(a => a + 1)}>
                        Retry
                    </button>
                )}
            </span>
        );
    }
    if (!url) return <span className="message-attachment loading"><LockIcon /> Decrypting attachment…</span>;
    if (info.mime.startsWith('image/')) {
        return (
            // stopPropagation for the same reason as the video branch below:
            // a revealed spoiler wraps this span, and the zoom click would
            // bubble into its toggle — opening the lightbox while re-hiding
            // the spoiler underneath it. Unrevealed spoilers never see this
            // (pointer-events:none), so the revealing tap still works.
            <span className="message-image" onClick={(e) => e.stopPropagation()}>
                {/* Enlarge in-app. openAttachmentBlob's window.open of a blob:
                    URL is a no-op in the Tauri and Capacitor shells. */}
                <img src={url} alt={name} loading="lazy" onClick={() => setZoomed(true)} />
                {zoomed && <ImageLightbox url={url} name={name} onClose={() => setZoomed(false)} />}
            </span>
        );
    }
    if (videoMime && !embedFailed) {
        // Inline player, same pattern TaskAttachments already uses: the
        // decrypted blob URL feeds a native <video> directly (safeBlobType
        // keeps the real MIME on video/* blobs for exactly this).
        // preload="metadata" so a channel of clips doesn't buffer them all;
        // playsInline so Capacitor/iOS doesn't hijack into fullscreen; no
        // autoplay ever. The download chip stays underneath — the embed
        // replaces the NEED to download, not the ability. onError: an
        // extension-guessed container the engine can't demux falls back to
        // the plain chip instead of a dead player.
        return (
            // stopPropagation: native <video> control clicks (play/seek/
            // volume) COMPOSE out of the UA shadow root and would bubble to a
            // wrapping Spoiler's toggle — pressing Play re-hid the spoiler,
            // which re-applied pointer-events:none over the controls while
            // the clip kept playing (review finding, 0811). Unrevealed
            // spoilers are unaffected: pointer-events:none means this span
            // never sees the revealing tap.
            <span className="message-video" onClick={(e) => e.stopPropagation()}>
                <video
                    src={url}
                    controls
                    preload="metadata"
                    playsInline
                    title={name}
                    onError={() => setEmbedFailed(true)}
                />
                <AttachmentDownload url={url} name={name || 'attachment'} />
            </span>
        );
    }
    return <AttachmentDownload url={url} name={name || 'attachment'} />;
}

/**
 * A BUTTON, not a link. `download` on an anchor is honoured only for a plain
 * left click — middle-click and "Open link in new tab" ignore it and navigate
 * to the blob, which inherits this app's origin while its MIME comes from
 * whoever sent the attachment. No blob URL is exposed as a link anywhere.
 */
function AttachmentDownload({ url, name }: { url: string; name: string }) {
    const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [where, setWhere] = useState('');

    return (
        <button
            type="button"
            className={`message-attachment ${state}`}
            title={state === 'saved' ? `Saved to ${where}` : `Download ${name}`}
            disabled={state === 'saving'}
            onClick={async () => {
                setState('saving');
                try {
                    const res = await saveAttachment(url, name);
                    setWhere(res.where);
                    setState('saved');
                } catch (err) {
                    console.error('[attachment] save failed:', err);
                    setState('error');
                }
            }}
        >
            {state === 'saved' ? <CheckCircleIcon /> : state === 'error' ? <WarningIcon /> : <PaperclipIcon />} {name}
            {state === 'saved' && <span className="attachment-saved"> — saved</span>}
            {state === 'error' && <span className="attachment-saved"> — could not save</span>}
        </button>
    );
}

// A small set of common shortcode emoji. Unknown shortcodes render literally.
// icon-lint:allow-emoji — message CONTENT: typing :fire: puts this glyph in the
// user's own text. Replacing these with icons would change what people send.
const EMOJI: Record<string, string> = {
    smile: '😄', smiley: '😃', grin: '😁', joy: '😂', laughing: '😆',
    wink: '😉', blush: '😊', heart: '❤️', fire: '🔥', tada: '🎉',
    thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', eyes: '👀',
    rocket: '🚀', ok_hand: '👌', wave: '👋', pray: '🙏', clap: '👏',
    thinking: '🤔', sob: '😭', sunglasses: '😎', poop: '💩', '100': '💯',
    check: '✅', x: '❌', warning: '⚠️', star: '⭐', skull: '💀',
};
// icon-lint:end

function Spoiler({ children }: { children: React.ReactNode }) {
    const [revealed, setRevealed] = useState(false);
    return (
        <span
            className={`spoiler ${revealed ? 'revealed' : ''}`}
            onClick={() => setRevealed(!revealed)}
        >
            {children}
        </span>
    );
}

interface Ctx {
    members: MemberWithRoles[];
    channels: Channel[];
    onChannelClick?: (channel: Channel) => void;
    /** Server-stamped consent for the message being rendered (clip posts only). */
    clipConsent?: ClipConsent | null;
}

function renderNodes(nodes: Node[], ctx: Ctx, keyPrefix = ''): React.ReactNode[] {
    return nodes.map((node, i) => {
        const key = `${keyPrefix}${i}`;
        switch (node.type) {
            case 'text':
                return <React.Fragment key={key}>{node.value}</React.Fragment>;
            case 'strong':
                return <strong key={key}>{renderNodes(node.children, ctx, key + '.')}</strong>;
            case 'em':
                return <em key={key}>{renderNodes(node.children, ctx, key + '.')}</em>;
            case 'underline':
                return <u key={key}>{renderNodes(node.children, ctx, key + '.')}</u>;
            case 'strike':
                return <del key={key}>{renderNodes(node.children, ctx, key + '.')}</del>;
            case 'spoiler':
                return <Spoiler key={key}>{renderNodes(node.children, ctx, key + '.')}</Spoiler>;
            case 'code':
                return <code key={key} className="inline-code">{node.value}</code>;
            case 'codeblock':
                return (
                    <pre key={key} className="code-block" data-lang={node.lang || undefined}>
                        <code>{node.value}</code>
                    </pre>
                );
            case 'blockquote':
                return <blockquote key={key} className="message-quote">{renderNodes(node.children, ctx, key + '.')}</blockquote>;
            case 'link':
                // A clip ref is dispatched BEFORE any <a> could be emitted: the
                // href carries the clip key and must never be navigable.
                if (isClipRef(node.href)) return <ClipAttachment key={node.href} href={node.href} consent={ctx.clipConsent} />;
                if (isScrubbedClipRef(node.href)) return <span key={key} className="clip-attachment-broken">{node.label} (clip removed)</span>;
                if (isEncAttachment(node.href)) return <EncryptedAttachment key={key} href={node.href} name={node.label} />;
                // Belt-and-suspenders with the parser: never emit a raw href for a
                // disallowed scheme (javascript:, data:, …) — render the label as
                // plain text instead. (H7)
                if (!isSafeUrl(node.href)) return <React.Fragment key={key}>{node.label}</React.Fragment>;
                return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="message-link">{node.label}</a>;
            case 'url':
                if (!isSafeUrl(node.href)) return <React.Fragment key={key}>{node.href}</React.Fragment>;
                // Bare image/GIF links embed inline (matching how most chat apps handle them); others are links.
                if (isImageUrl(node.href)) {
                    return (
                        <span key={key} className="message-image">
                            {/* referrerPolicy=no-referrer: a bare image URL is a
                                third-party host the SENDER chose, so loading it
                                leaks the viewer to them. We can't stop the fetch
                                without a proxy / click-to-load (tracked
                                separately), but we can withhold the Referer so
                                the app URL and channel context don't leak too. */}
                            <img src={node.href} alt="" loading="lazy" referrerPolicy="no-referrer"
                                onClick={() => openExternalUrl(node.href)}
                                onError={(e) => { (e.currentTarget.closest('.message-image') as HTMLElement).style.display = 'none'; }} />
                        </span>
                    );
                }
                return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="message-link">{node.href}</a>;
            case 'image':
                if (isClipRef(node.href)) return <ClipAttachment key={node.href} href={node.href} consent={ctx.clipConsent} />;
                if (isScrubbedClipRef(node.href)) return <span key={key} className="clip-attachment-broken">{node.alt} (clip removed)</span>;
                if (isEncAttachment(node.href)) return <EncryptedAttachment key={key} href={node.href} name={node.alt} />;
                if (!isSafeUrl(node.href)) return node.alt ? <React.Fragment key={key}>{node.alt}</React.Fragment> : null;
                return (
                    <span key={key} className="message-image">
                        {/* See the bare-URL case above — withhold the Referer
                            from the sender-chosen third-party image host. */}
                        <img src={node.href} alt={node.alt} loading="lazy" referrerPolicy="no-referrer"
                            onClick={() => openExternalUrl(node.href)}
                            onError={(e) => { (e.currentTarget.closest('.message-image') as HTMLElement).style.display = 'none'; }} />
                    </span>
                );
            case 'mentionEveryone':
                return <span key={key} className="mention everyone">@everyone</span>;
            case 'mentionHere':
                return <span key={key} className="mention everyone">@here</span>;
            case 'mentionUser': {
                const name = node.name.toLowerCase();
                const m = ctx.members.find(
                    (mem) =>
                        mem.username.toLowerCase() === name ||
                        (mem.display_name && mem.display_name.toLowerCase() === name) ||
                        (mem.server_nickname && mem.server_nickname.toLowerCase() === name)
                );
                if (m) {
                    const label = m.server_nickname || m.display_name || m.username;
                    return <span key={key} className="mention">@{label}</span>;
                }
                return <React.Fragment key={key}>@{node.name}</React.Fragment>;
            }
            case 'channel': {
                const name = node.name.toLowerCase();
                const c = ctx.channels.find((ch) => ch.name.toLowerCase() === name);
                if (c) return (
                    <span
                        key={key}
                        className="mention channel"
                        onClick={ctx.onChannelClick ? () => ctx.onChannelClick!(c) : undefined}
                        role={ctx.onChannelClick ? 'button' : undefined}
                    >#{c.name}</span>
                );
                return <React.Fragment key={key}>#{node.name}</React.Fragment>;
            }
            case 'emoji': {
                const glyph = EMOJI[node.name.toLowerCase()];
                return <React.Fragment key={key}>{glyph ?? `:${node.name}:`}</React.Fragment>;
            }
            default:
                return null;
        }
    });
}

interface MessageContentProps {
    content: string;
    members: MemberWithRoles[];
    channels?: Channel[];
    onChannelClick?: (channel: Channel) => void;
    /** `msg.clip_consent` — lets a clip ref in this message render its badge. */
    clipConsent?: ClipConsent | null;
}

export function MessageContent({ content, members, channels = [], onChannelClick, clipConsent }: MessageContentProps) {
    const nodes = parseMessage(content);
    return <>{renderNodes(nodes, { members, channels, onChannelClick, clipConsent })}</>;
}
