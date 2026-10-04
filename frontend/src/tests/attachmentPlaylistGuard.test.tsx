/**
 * An HLS playlist never reaches a media element, whatever its ref says.
 *
 * Measured in headless Edge (2026-10-04, review of the audio-player change):
 * a file whose BYTES are an HLS playlist (`#EXTM3U` + `#EXT-X-TARGETDURATION`
 * + a segment URL), loaded into a `<video>` or `<audio>` with
 * preload="metadata", made the engine GET the segment URL with no click —
 * whatever type the blob carried (audio/mpeg, audio/x-mpegurl,
 * application/vnd.apple.mpegurl, video/mp4 all fetched). Chromium recognises
 * the playlist from its bytes, so `safeBlobType` cannot stop it: every reader
 * who merely scrolled past `song.mp3` or `clip.mp4` told the sender's server
 * their IP and when they opened the channel, ignoring "Load remote images",
 * and the player then failed to the chip so nothing on screen showed it.
 *
 * So `decryptToBlobUrl` looks at the plaintext while it has it, and every
 * renderer that would hand the URL to a player asks `isPlaylistBlobUrl`
 * first: a playlist is the download chip, never a player.
 *
 * Nothing in this file mocks the code under test: the REAL decryptToBlobUrl
 * opens real AES-GCM ciphertext (only fetch and URL.createObjectURL, which
 * jsdom lacks, are stand-ins), and the real components decide. Each case
 * has a positive control (the same ref with real audio bytes gets its
 * player), so the assertion cannot pass because nothing rendered at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { decryptToBlobUrl, isPlaylistBlobUrl, looksLikeHlsPlaylist, clearBlobCache } from '../api/attachments';
import { MessageContent } from '../components/MessageContent';
import { TaskAttachments } from '../components/TaskAttachments';
import { NoteImages } from '../components/NoteImages';

const enc = new TextEncoder();
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttps://tracker.example/seg0.ts\n#EXT-X-ENDLIST\n';
/** An ID3v2.4 tag of `size` body bytes (syncsafe size), as an mp3 starts. */
function id3(size: number, footer = false): Uint8Array {
    const h = new Uint8Array(10 + size);
    h.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return h;
}
function cat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
/** An MPEG-1 Layer III frame header and some payload: what an mp3 holds. */
const MP3_FRAME = new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(60).fill(0x55)]);

describe('looksLikeHlsPlaylist', () => {
    it('an HLS playlist, however it opens', () => {
        expect(looksLikeHlsPlaylist(enc.encode(PLAYLIST))).toBe(true);
        expect(looksLikeHlsPlaylist(enc.encode('﻿' + PLAYLIST)), 'a UTF-8 BOM').toBe(true);
        expect(looksLikeHlsPlaylist(enc.encode(' \r\n\t' + PLAYLIST)), 'leading whitespace').toBe(true);
        expect(looksLikeHlsPlaylist(enc.encode('#extm3u\n#EXT-X-TARGETDURATION:2\n')), 'any case').toBe(true);
        // FFmpeg's probe and GStreamer's id3demux both look past an ID3v2
        // tag before they decide what a stream is.
        expect(looksLikeHlsPlaylist(cat(id3(20), enc.encode(PLAYLIST))), 'behind an ID3 tag').toBe(true);
        expect(looksLikeHlsPlaylist(cat(id3(5, true), new Uint8Array(10), enc.encode(PLAYLIST))), 'behind an ID3 tag with a footer').toBe(true);
        expect(looksLikeHlsPlaylist(cat(id3(3), id3(4), enc.encode(PLAYLIST))), 'behind two ID3 tags').toBe(true);
        // A plain (non-HLS) m3u is not media either, and costs nothing to refuse.
        expect(looksLikeHlsPlaylist(enc.encode('#EXTM3U\n#EXTINF:3,Track\nhttps://x.example/t.mp3\n'))).toBe(true);
    });

    it('positive control: real media and other files are not playlists', () => {
        expect(looksLikeHlsPlaylist(MP3_FRAME), 'an mp3 frame').toBe(false);
        expect(looksLikeHlsPlaylist(cat(id3(30), MP3_FRAME)), 'an mp3 with its tag').toBe(false);
        expect(looksLikeHlsPlaylist(enc.encode('OggS\0\x02')), 'ogg').toBe(false);
        expect(looksLikeHlsPlaylist(cat(new Uint8Array([0, 0, 0, 0x18]), enc.encode('ftypmp42'))), 'mp4').toBe(false);
        expect(looksLikeHlsPlaylist(enc.encode('hello #EXTM3U')), 'the signature anywhere but the start').toBe(false);
        expect(looksLikeHlsPlaylist(enc.encode('#EXTM3')), 'cut short').toBe(false);
        expect(looksLikeHlsPlaylist(new Uint8Array(0))).toBe(false);
        expect(looksLikeHlsPlaylist(id3(4000).subarray(0, 12)), 'a tag longer than the file').toBe(false);
    });
});

let container: HTMLDivElement;
let root: Root;
let play: ReturnType<typeof vi.spyOn>;
let blobTypes: Map<string, string>;
let served: Map<string, Uint8Array>;
let seq = 0;
const origCreate = URL.createObjectURL;

/** Seal `plain` the way the upload side does: nonce(12) || AES-GCM(ct). */
async function seal(id: string, plain: Uint8Array): Promise<string> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plain as BufferSource));
    served.set(id, cat(nonce, ct));
    return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const ref = (id: string, key: string, mime: string) => `sovereign-enc:${id}?k=${key}&m=${encodeURIComponent(mime)}`;
const settle = async () => {
    await act(async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); });
};

beforeEach(() => {
    blobTypes = new Map();
    served = new Map();
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const id = String(input).split('/files/')[1];
        const body = served.get(id);
        return body ? new Response(body.slice()) : new Response('', { status: 404 });
    });
    URL.createObjectURL = ((b: Blob) => {
        const u = `blob:test-${++seq}`;
        blobTypes.set(u, b.type);
        return u;
    }) as typeof URL.createObjectURL;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    expect(play).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
    clearBlobCache();
    URL.createObjectURL = origCreate;
    vi.restoreAllMocks();
});

describe('decryptToBlobUrl', () => {
    it('flags a playlist plaintext, and types its blob as opaque bytes', async () => {
        const key = await seal('d-pl', enc.encode(PLAYLIST));
        const url = await decryptToBlobUrl('d-pl', key, 'audio/mpeg');
        expect(isPlaylistBlobUrl(url)).toBe(true);
        expect(blobTypes.get(url)).toBe('application/octet-stream');
    });

    it('positive control: real audio keeps its type and is not flagged', async () => {
        const key = await seal('d-mp3', cat(id3(30), MP3_FRAME));
        const url = await decryptToBlobUrl('d-mp3', key, 'audio/mpeg');
        expect(isPlaylistBlobUrl(url)).toBe(false);
        expect(blobTypes.get(url)).toBe('audio/mpeg');
    });

    it('a sign-out forgets the flags with the URLs', async () => {
        const key = await seal('d-pl2', enc.encode(PLAYLIST));
        const url = await decryptToBlobUrl('d-pl2', key, 'video/mp4');
        expect(isPlaylistBlobUrl(url)).toBe(true);
        clearBlobCache();
        expect(isPlaylistBlobUrl(url)).toBe(false);
    });
});

describe('every player asks first', () => {
    it.each([
        ['song.mp3', 'audio/mpeg'],
        ['old-song.mp3', 'application/octet-stream'],
        ['clip.mp4', 'video/mp4'],          // the route 0.9.833 already had
        ['track.webm', 'video/webm'],
    ])('a chat message: %s (%s) holding a playlist is the chip, with no player', async (name, mime) => {
        const id = `m-pl-${name}`;
        const key = await seal(id, enc.encode(PLAYLIST));
        await act(async () => { root.render(<MessageContent content={`[${name}](${ref(id, key, mime)})`} members={[]} />); });
        await settle();
        expect(container.querySelector('audio, video'), 'a playlist was handed to a player').toBeNull();
        expect(container.querySelector('button.message-attachment')?.textContent).toContain(name);
    });

    it('positive control: the same chat ref with real audio bytes gets its player', async () => {
        const key = await seal('m-mp3', cat(id3(30), MP3_FRAME));
        await act(async () => { root.render(<MessageContent content={`[song.mp3](${ref('m-mp3', key, 'audio/mpeg')})`} members={[]} />); });
        await settle();
        expect(container.querySelector('.message-audio audio')).not.toBeNull();
    });

    it('a Task attachment: a video or audio holding a playlist is a download', async () => {
        const k1 = await seal('t-pl1', enc.encode(PLAYLIST));
        const k2 = await seal('t-pl2', enc.encode(PLAYLIST));
        const k3 = await seal('t-mp3', cat(id3(30), MP3_FRAME));
        await act(async () => {
            root.render(<TaskAttachments refs={[
                { href: ref('t-pl1', k1, 'video/mp4'), name: 'clip.mp4' },
                { href: ref('t-pl2', k2, 'audio/mpeg'), name: 'song.mp3' },
                { href: ref('t-mp3', k3, 'audio/mpeg'), name: 'real.mp3' },
            ]} canEdit={false} onRemove={() => {}} />);
        });
        await settle();
        const files = Array.from(container.querySelectorAll('button.ta-file')).map(b => b.textContent?.trim());
        expect(files).toEqual(['clip.mp4', 'song.mp3']);
        expect(container.querySelector('video')).toBeNull();
        // Positive control: the real mp3 beside them still plays.
        expect(Array.from(container.querySelectorAll('audio')).map(a => a.getAttribute('aria-label'))).toEqual(['real.mp3']);
    });

    it("a note's gallery: an audio file holding a playlist is the download button", async () => {
        const k1 = await seal('n-pl', enc.encode(PLAYLIST));
        const k2 = await seal('n-mp3', cat(id3(30), MP3_FRAME));
        const opened = JSON.stringify([
            { href: ref('n-pl', k1, 'application/octet-stream'), name: 'song.mp3' },
            { href: ref('n-mp3', k2, 'audio/mpeg'), name: 'real.mp3' },
        ]);
        await act(async () => { root.render(<NoteImages opened={opened} editable={false} />); });
        await settle();
        expect(Array.from(container.querySelectorAll('button.ni-file')).map(b => b.textContent)).toEqual(['song.mp3']);
        expect(Array.from(container.querySelectorAll('audio')).map(a => a.getAttribute('aria-label'))).toEqual(['real.mp3']);
    });
});
