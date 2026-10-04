/**
 * Audio attachments get a player (the owner, 2026-10-04: ".mp3 files dont
 * have a player" — an encrypted m83-midnight-city.mp3 in a channel rendered
 * only as the download chip, under a video that played inline).
 *
 * `EncryptedAttachment` (components/MessageContent.tsx) renders channels and
 * DMs alike. The same rule — `audioMimeFor`, after `videoMimeFor` — decides
 * the Task strip (TaskAttachments) and a note's gallery (NoteImages), so the
 * three cannot disagree about which file plays.
 *
 * Nothing here ever plays: jsdom has no media pipeline, and `play` is spied
 * on and must never be called — a player is pressed, never started.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { decrypts } = vi.hoisted(() => ({ decrypts: [] as Array<{ id: string; mime: string }> }));
vi.mock('../api/attachments', async (orig) => ({
    ...(await orig<typeof import('../api/attachments')>()),
    decryptToBlobUrl: async (id: string, _key: string, mime: string) => {
        decrypts.push({ id, mime });
        return `blob:decrypted-${id}`;
    },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../components/MessageContent';
import { TaskAttachments } from '../components/TaskAttachments';
import { NoteImages } from '../components/NoteImages';
import { ComposerAttachments } from '../components/ComposerAttachments';
import { FileIcon, MusicIcon } from '../components/Icons';
import { galleryItems } from '../api/noteMedia';
import { pendingAttachment } from '../api/composerAttachments';
import { parkedHref } from '../api/parkedMedia';

let container: HTMLDivElement;
let root: Root;
let play: ReturnType<typeof vi.spyOn>;

const settle = async () => {
    await act(async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); });
};
const ref = (id: string, mime: string) => `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent(mime)}`;

async function renderMessage(content: string) {
    await act(async () => { root.render(<MessageContent content={content} members={[]} />); });
    await settle();
}

beforeEach(() => {
    decrypts.length = 0;
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    // A player is pressed, never started: no path in any of these may call play().
    expect(play).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
});

describe('a chat message with an audio attachment', () => {
    it("the owner's mp3: a player, the file's name over it, and the download chip under it", async () => {
        await renderMessage(`[m83-midnight-city.mp3](${ref('f1', 'audio/mpeg')})`);
        const audio = container.querySelector<HTMLAudioElement>('.message-audio audio');
        expect(audio, 'no <audio> was rendered for the mp3').not.toBeNull();
        expect(audio!.controls).toBe(true);
        expect(audio!.getAttribute('preload')).toBe('metadata');
        expect(audio!.autoplay).toBe(false);
        expect(audio!.getAttribute('src')).toBe('blob:decrypted-f1');
        expect(audio!.getAttribute('aria-label')).toBe('m83-midnight-city.mp3');
        expect(container.querySelector('.message-audio-name')?.textContent).toContain('m83-midnight-city.mp3');
        const chip = container.querySelector('.message-audio button.message-attachment');
        expect(chip?.textContent).toContain('m83-midnight-city.mp3');
        expect(decrypts).toEqual([{ id: 'f1', mime: 'audio/mpeg' }]);
        // Control: it is the audio branch, not the video one.
        expect(container.querySelector('video')).toBeNull();
    });

    it.each([
        // File.type as Edge on Windows reported each one through the composer (2026-10-04).
        ['test-tone.m4a', 'audio/x-m4a'],
        ['test-tone.ogg', 'audio/ogg'],
        ['test-tone.opus', 'audio/ogg'],
        ['test-tone.wav', 'audio/wav'],
        ['test-tone.flac', 'audio/flac'],
        ['test-tone.weba', 'audio/webm'],
        ['test-tone.oga', 'audio/ogg'],
        ['test-tone.aac', 'audio/vnd.dlna.adts'],
        ['voice-1.webm', 'audio/webm;codecs=opus'],
        ['voice.mp4', 'audio/mp4'],
    ])('%s (%s) gets a player', async (name, mime) => {
        await renderMessage(`[${name}](${ref('f2', mime)})`);
        expect(container.querySelector('.message-audio audio'), name).not.toBeNull();
        expect(container.querySelector('video')).toBeNull();
    });

    it('an old ref that says application/octet-stream plays by its NAME, with a media-typed blob', async () => {
        await renderMessage(`[old-song.mp3](${ref('f3', 'application/octet-stream')})`);
        expect(container.querySelector('.message-audio audio')).not.toBeNull();
        expect(decrypts).toEqual([{ id: 'f3', mime: 'audio/mpeg' }]);
    });

    it.each([
        ['memo.amr', 'audio/amr'],               // audio this engine cannot decode
        ['list.m3u', 'audio/x-mpegurl'],         // a playlist: never handed to a player
        ['song.mp3', 'application/pdf'],         // a concrete non-audio type wins over the name
        ['song.mp3', 'text/html'],
        ['report.pdf', 'application/octet-stream'],
    ])('%s (%s) stays a download chip, with no player', async (name, mime) => {
        await renderMessage(`[${name}](${ref('f4', mime)})`);
        expect(container.querySelector('audio')).toBeNull();
        expect(container.querySelector('.message-audio')).toBeNull();
        expect(container.querySelector('button.message-attachment')?.textContent).toContain(name);
    });

    it('a file the player cannot decode falls back to the plain chip', async () => {
        await renderMessage(`[liar.mp3](${ref('f5', 'audio/mpeg')})`);
        const audio = container.querySelector('.message-audio audio')!;
        expect(audio).not.toBeNull();
        await act(async () => { audio.dispatchEvent(new Event('error')); });
        expect(container.querySelector('audio')).toBeNull();
        expect(container.querySelector('.message-audio')).toBeNull();
        expect(container.querySelector('button.message-attachment')?.textContent).toContain('liar.mp3');
    });

    it("pressing the player inside a revealed spoiler does not re-hide it", async () => {
        await renderMessage(`||[twist.mp3](${ref('f6', 'audio/mpeg')})||`);
        const spoiler = container.querySelector('.spoiler')!;
        expect(spoiler.querySelector('.message-audio audio'), 'the spoiler holds the player').not.toBeNull();
        expect(spoiler.classList.contains('revealed')).toBe(false);
        await act(async () => { (spoiler as HTMLElement).click(); });
        expect(spoiler.classList.contains('revealed'), 'control: a tap on the spoiler reveals it').toBe(true);
        // A control click composes out of the UA shadow root and lands on the
        // element; it must not bubble into the spoiler's toggle.
        // Checked after EACH click: two toggles would cancel out.
        await act(async () => { (spoiler.querySelector('.message-audio audio') as HTMLElement).click(); });
        expect(spoiler.classList.contains('revealed'), 'a press on the player re-hid the spoiler').toBe(true);
        await act(async () => { (spoiler.querySelector('.message-audio-name') as HTMLElement).click(); });
        expect(spoiler.classList.contains('revealed'), 'a press on the card re-hid the spoiler').toBe(true);
    });

    it('a .webm the OS called video, with no picture, becomes the audio player', async () => {
        // yt-dlp and friends write audio-only .webm, and Windows says video/webm.
        await renderMessage(`[track.webm](${ref('f7', 'video/webm')})`);
        const video = container.querySelector('.message-video video')!;
        expect(video, 'it starts in the video player').not.toBeNull();
        // jsdom reports videoWidth/videoHeight 0, as a browser does for a
        // file with no video track once its metadata is in.
        await act(async () => { video.dispatchEvent(new Event('loadedmetadata')); });
        expect(container.querySelector('video')).toBeNull();
        const audio = container.querySelector('.message-audio audio');
        expect(audio).not.toBeNull();
        expect(audio!.getAttribute('src')).toBe('blob:decrypted-f7');
        expect(container.querySelector('.message-audio-name')?.textContent).toContain('track.webm');
    });

    it('control: a real video (it has a frame size) stays a video', async () => {
        await renderMessage(`[clip.webm](${ref('f8', 'video/webm')})`);
        const video = container.querySelector<HTMLVideoElement>('.message-video video')!;
        Object.defineProperty(video, 'videoWidth', { value: 640 });
        Object.defineProperty(video, 'videoHeight', { value: 360 });
        await act(async () => { video.dispatchEvent(new Event('loadedmetadata')); });
        expect(container.querySelector('.message-video video')).toBe(video);
        expect(container.querySelector('audio')).toBeNull();
    });
});

describe('a Task attachment', () => {
    it('an old octet-stream .mp3 plays, with a media-typed blob', async () => {
        await act(async () => {
            root.render(<TaskAttachments refs={[{ href: ref('t1', 'application/octet-stream'), name: 'memo.mp3' }]} canEdit={false} onRemove={() => {}} />);
        });
        await settle();
        expect(container.querySelector('audio.ta-audio')).not.toBeNull();
        expect(decrypts).toEqual([{ id: 't1', mime: 'audio/mpeg' }]);
    });

    it('audio it cannot play is a download, and a player that errors becomes one', async () => {
        await act(async () => {
            root.render(<TaskAttachments refs={[
                { href: ref('t2', 'audio/amr'), name: 'memo.amr' },
                { href: ref('t3', 'audio/mpeg'), name: 'liar.mp3' },
            ]} canEdit={false} onRemove={() => {}} />);
        });
        await settle();
        const files = () => Array.from(container.querySelectorAll('button.ta-file')).map(b => b.textContent?.trim());
        expect(files()).toEqual(['memo.amr']);
        const audio = container.querySelector('audio.ta-audio')!;
        expect(audio).not.toBeNull();
        await act(async () => { audio.dispatchEvent(new Event('error')); });
        expect(container.querySelector('audio')).toBeNull();
        expect(files()).toEqual(['memo.amr', 'liar.mp3']);
    });
});

describe("the composer's pending chip", () => {
    it('an audio file shows the music note it will arrive under; any other file the file icon', async () => {
        const chips = [
            pendingAttachment({ name: 'song.mp3', type: 'audio/mpeg' }, null),
            pendingAttachment({ name: 'take.opus', type: '' }, null),   // a picker that reports no type
            pendingAttachment({ name: 'report.pdf', type: 'application/pdf' }, null),
        ];
        await act(async () => {
            root.render(<ComposerAttachments attachments={chips} onRemove={() => {}} onToggleSpoiler={() => {}} onRetry={() => {}} />);
        });
        const drawn = Array.from(container.querySelectorAll('.composer-chip-thumb > svg')).map(s => s.outerHTML);
        const music = renderToStaticMarkup(<MusicIcon />);
        const file = renderToStaticMarkup(<FileIcon />);
        expect(music).not.toBe(file); // control: the two icons are distinguishable
        expect(drawn).toEqual([music, music, file]);
    });
});

describe("a note's gallery", () => {
    const sidecar = (refs: Array<{ href: string; name: string }>) => JSON.stringify(refs);

    it('classifies by the same rule as chat', () => {
        expect(galleryItems(sidecar([
            { href: ref('n1', 'audio/webm;codecs=opus'), name: 'voice-1.webm' },
            { href: ref('n2', 'application/octet-stream'), name: 'song.mp3' },
            { href: ref('n3', 'audio/amr'), name: 'memo.amr' },
            { href: ref('n4', 'application/pdf'), name: 'notes.pdf' },
        ])).map(i => i.kind)).toEqual(['audio', 'audio', 'file', 'file']);
    });

    it('an unlabelled mp3 plays, and a voice note that errors becomes the download button', async () => {
        const opened = sidecar([{ href: ref('n5', 'application/octet-stream'), name: 'song.mp3' }]);
        await act(async () => { root.render(<NoteImages opened={opened} editable={false} />); });
        await settle();
        const audio = container.querySelector('.ni-audio audio');
        expect(audio).not.toBeNull();
        expect(decrypts).toEqual([{ id: 'n5', mime: 'audio/mpeg' }]);
        await act(async () => { audio!.dispatchEvent(new Event('error')); });
        expect(container.querySelector('audio')).toBeNull();
        expect(container.querySelector('button.ni-file')?.textContent).toContain('song.mp3');
    });

    // Added offline, not uploaded yet: the ref is `puca-parked:` and its bytes
    // are only on this device, so there is no server file to decrypt into a
    // player. Before the audio rule it was the on-this-device download when
    // the type said nothing; the name rule sent it to the player, which can
    // only open a server file and drew a broken-file warning instead.
    it.each([
        ['take.opus', 'application/octet-stream'],   // a parked record from before, or a picker with no type
        ['song.mp3', 'application/octet-stream'],
        ['take.opus', 'audio/ogg'],                  // what the upload side records now
        ['voice-1.webm', 'audio/webm;codecs=opus'],  // a voice note recorded offline (broken before this change too)
    ])('a parked %s (%s) is the on-this-device download, not a broken player', async (name, mime) => {
        const opened = sidecar([{ href: parkedHref('pk1', mime), name }]);
        expect(galleryItems(opened).map(i => i.kind), 'control: it is classified as audio').toEqual(['audio']);
        await act(async () => { root.render(<NoteImages opened={opened} editable={false} />); });
        await settle();
        expect(container.querySelector('.ni-broken'), 'a broken-file warning').toBeNull();
        expect(container.querySelector('audio')).toBeNull();
        const btn = container.querySelector('button.ni-file');
        expect(btn?.textContent).toContain(name);
        expect(btn?.textContent).toContain('on this device');
        expect(decrypts).toEqual([]);
    });
});
