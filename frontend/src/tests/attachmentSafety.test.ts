import { describe, it, expect } from 'vitest';
import { safeBlobType, videoMimeFor, audioMimeFor } from '../api/attachments';

/**
 * THE ATTACK THIS CLOSES.
 *
 * An attachment ref carries its MIME in the `m=` parameter, chosen by whoever
 * SENT it. The decrypted bytes become a `blob:` URL, and a `blob:` document
 * inherits this app's origin — so if such a URL is ever navigated to (middle
 * click and "Open link in new tab" both ignore an anchor's `download`
 * attribute), a `text/html` attachment runs script in-origin, with access to
 * the stored JWT and the E2EE key material.
 *
 * Two independent defences, either of which is sufficient:
 *   1. no blob URL is exposed as a link at all — downloads are buttons;
 *   2. the blob is only given a document-capable type when we actually render
 *      it inline, which is what this tests.
 */
describe('safeBlobType', () => {
    it('keeps the real type for media we render inline', () => {
        expect(safeBlobType('image/png')).toBe('image/png');
        expect(safeBlobType('image/jpeg')).toBe('image/jpeg');
        expect(safeBlobType('video/mp4')).toBe('video/mp4');
        expect(safeBlobType('audio/ogg')).toBe('audio/ogg');
    });

    it('neutralises HTML, which is the account-takeover case', () => {
        expect(safeBlobType('text/html')).toBe('application/octet-stream');
        expect(safeBlobType('application/xhtml+xml')).toBe('application/octet-stream');
    });

    /**
     * SVG is an image, and inside `<img>` it cannot run script — but the SAME
     * blob URL would be a scriptable document if opened directly. It must not
     * keep its real type.
     */
    it('neutralises SVG despite it being an image type', () => {
        expect(safeBlobType('image/svg+xml')).toBe('application/octet-stream');
        expect(safeBlobType('IMAGE/SVG+XML')).toBe('application/octet-stream');
    });

    it('is not fooled by case or by parameters', () => {
        expect(safeBlobType('TEXT/HTML')).toBe('application/octet-stream');
        expect(safeBlobType('text/html; charset=utf-8')).toBe('application/octet-stream');
        expect(safeBlobType('image/png; qs=0.9')).toBe('image/png');
        expect(safeBlobType('  image/png  ')).toBe('image/png');
    });

    it('defaults to binary for anything unrecognised or absent', () => {
        expect(safeBlobType('')).toBe('application/octet-stream');
        expect(safeBlobType('application/pdf')).toBe('application/octet-stream');
        expect(safeBlobType('application/javascript')).toBe('application/octet-stream');
        expect(safeBlobType('nonsense')).toBe('application/octet-stream');
    });

    it('does not let a document type hide behind an image prefix', () => {
        // "image/..." is not a licence to be scriptable; only the known
        // renderable families pass, and svg is excluded by name above.
        expect(safeBlobType('image/svg+xml; charset=utf-8')).toBe('application/octet-stream');
    });

    /**
     * Audio refs now get an inline player, so the audio family is a type a
     * sender can steer a blob into on purpose. A structured suffix (`+xml`,
     * `+json`) is how a document type wears a media prefix, in every family;
     * no format we play is spelled with one.
     */
    it('neutralises every structured-suffix type, in every media family', () => {
        for (const m of ['audio/x+xml', 'audio/mpeg+xml', 'video/mp4+xml', 'image/png+xml', 'audio/ld+json', 'AUDIO/X+XML; charset=utf-8']) {
            expect(safeBlobType(m), m).toBe('application/octet-stream');
        }
    });

    // Hygiene only: the TYPE does not stop a player fetching a playlist's URLs
    // (Chromium reads the bytes) — attachmentPlaylistGuard.test.tsx is the defence.
    it('neutralises audio playlist types', () => {
        for (const m of ['audio/mpegurl', 'audio/x-mpegurl', 'audio/x-scpls', 'Audio/X-MpegURL']) {
            expect(safeBlobType(m), m).toBe('application/octet-stream');
        }
    });

    it('needs a plain token after the slash', () => {
        for (const m of ['audio/', 'audio/ mpeg', 'audio/"mpeg"', 'audio/mp<eg', 'audio', 'audiox/mpeg']) {
            expect(safeBlobType(m), m).toBe('application/octet-stream');
        }
    });

    it('positive control: the audio types the players are handed keep their type', () => {
        for (const m of ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/vnd.wave', 'audio/flac', 'audio/webm']) {
            expect(safeBlobType(m), m).toBe(m);
        }
        expect(safeBlobType('audio/webm;codecs=opus')).toBe('audio/webm');
        expect(safeBlobType('video/x-matroska')).toBe('video/x-matroska');
    });
});

/**
 * The .mkv field report: File.type is the browser registry's guess and is
 * routinely EMPTY for Matroska, so real videos were stored (and rendered)
 * as application/octet-stream download chips. The extension fallback may
 * only fire when the recorded MIME says nothing — a concrete non-video
 * type must win over a video-looking name.
 */
describe('videoMimeFor', () => {
    it('a real video MIME wins regardless of the name', () => {
        expect(videoMimeFor('whatever.txt', 'video/mp4')).toBe('video/mp4');
        expect(videoMimeFor('clip.mkv', 'video/webm; codecs=vp9')).toBe('video/webm');
    });

    it('falls back to the extension when the MIME says nothing', () => {
        expect(videoMimeFor('2026-06-02 23-25-17.mkv', 'application/octet-stream')).toBe('video/x-matroska');
        expect(videoMimeFor('clip.MOV', '')).toBe('video/quicktime');
        expect(videoMimeFor('a.b.c.mp4', 'application/octet-stream')).toBe('video/mp4');
    });

    it('respects a concrete non-video type — that file is not a video', () => {
        expect(videoMimeFor('report.mkv', 'application/pdf')).toBeNull();
        expect(videoMimeFor('photo.mp4.png', 'image/png')).toBeNull();
    });

    it('is null for non-video names with no MIME, and for unplayable containers', () => {
        expect(videoMimeFor('notes.txt', '')).toBeNull();
        expect(videoMimeFor('archive.zip', 'application/octet-stream')).toBeNull();
        expect(videoMimeFor('old.avi', 'application/octet-stream')).toBeNull();
        expect(videoMimeFor('noextension', '')).toBeNull();
    });

    it('never grants a document-capable type (the safeBlobType invariant holds downstream)', () => {
        // Everything videoMimeFor can return must survive safeBlobType intact —
        // i.e. be a video/* family type, never text/html wearing a video name.
        for (const name of ['a.mp4', 'a.m4v', 'a.webm', 'a.mkv', 'a.mov', 'a.ogv']) {
            const m = videoMimeFor(name, '');
            expect(m).not.toBeNull();
            expect(safeBlobType(m!)).toBe(m);
        }
    });
});

/**
 * The owner's report (2026-10-04): ".mp3 files dont have a player" — an
 * encrypted m83-midnight-city.mp3 rendered only as the download chip. The
 * renderer now asks audioMimeFor, after videoMimeFor, which audio refs get an
 * <audio> and what type their blob carries.
 */
describe('audioMimeFor', () => {
    it('what the upload side records, per format (Edge on Windows, measured)', () => {
        // File.type as the composer saw it in a real browser, 2026-10-04.
        expect(audioMimeFor('test-tone.mp3', 'audio/mpeg')).toBe('audio/mpeg');
        expect(audioMimeFor('test-tone.m4a', 'audio/x-m4a')).toBe('audio/mp4'); // Windows' alias, canonicalised
        expect(audioMimeFor('test-tone.ogg', 'audio/ogg')).toBe('audio/ogg');
        expect(audioMimeFor('test-tone.opus', 'audio/ogg')).toBe('audio/ogg');
        expect(audioMimeFor('test-tone.wav', 'audio/wav')).toBe('audio/wav');
        expect(audioMimeFor('test-tone.flac', 'audio/flac')).toBe('audio/flac');
        expect(audioMimeFor('test-tone.weba', 'audio/webm')).toBe('audio/webm');
        // Windows' registry type for .aac — not a name any player is handed;
        // the extension turns it into the real one.
        expect(audioMimeFor('test-tone.aac', 'audio/vnd.dlna.adts')).toBe('audio/aac');
    });

    // An engine that picks its decoder from the DECLARED type (Firefox, the
    // WebKitGTK desktop shell) may not list a platform's alias, and would then
    // fall back to the chip for a file it can play under the standard name.
    // Chromium sniffs the bytes and does not care, so this costs nothing there.
    it('hands the player ONE canonical type per format, never the platform alias', () => {
        const cases: Array<[string, string]> = [
            ['audio/x-m4a', 'audio/mp4'], ['audio/m4a', 'audio/mp4'],
            ['audio/mp3', 'audio/mpeg'], ['audio/mpeg3', 'audio/mpeg'], ['audio/x-mpeg', 'audio/mpeg'], ['audio/x-mp3', 'audio/mpeg'],
            ['audio/x-aac', 'audio/aac'], ['audio/aacp', 'audio/aac'],
            ['audio/opus', 'audio/ogg'],
            ['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav'], ['audio/vnd.wave', 'audio/wav'],
            ['audio/x-flac', 'audio/flac'],
        ];
        for (const [alias, canonical] of cases) {
            expect(audioMimeFor('x', alias), alias).toBe(canonical);
            expect(audioMimeFor('x', `${alias.toUpperCase()}; q=1`), alias).toBe(canonical);
        }
        // Control: the standard names are their own canonical type.
        for (const m of ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/webm']) {
            expect(audioMimeFor('x', m), m).toBe(m);
        }
    });

    it('drops parameters (a Púca Notes recording is audio/webm;codecs=opus)', () => {
        expect(audioMimeFor('voice-1.webm', 'audio/webm;codecs=opus')).toBe('audio/webm');
        expect(audioMimeFor('x.mp3', ' AUDIO/MPEG ; q=1')).toBe('audio/mpeg');
    });

    it('falls back to the extension when the MIME says nothing (old refs, empty File.type)', () => {
        expect(audioMimeFor('m83-midnight-city.mp3', 'application/octet-stream')).toBe('audio/mpeg');
        expect(audioMimeFor('a.M4A', '')).toBe('audio/mp4');
        expect(audioMimeFor('a.aac', '')).toBe('audio/aac');
        expect(audioMimeFor('a.oga', '')).toBe('audio/ogg');
        expect(audioMimeFor('a.opus', '')).toBe('audio/ogg');
        expect(audioMimeFor('a.flac', 'application/octet-stream')).toBe('audio/flac');
        expect(audioMimeFor('a.weba', '')).toBe('audio/webm');
        expect(audioMimeFor('a.b.c.wav', '')).toBe('audio/wav');
    });

    it('an audio type it does not know falls back to the extension, never passes through', () => {
        expect(audioMimeFor('song.mp3', 'audio/x-mpeg-3')).toBe('audio/mpeg');
        // A playlist MIME wearing an mp3 name gets the mp3 type, not its own.
        expect(audioMimeFor('song.mp3', 'audio/x-mpegurl')).toBe('audio/mpeg');
        expect(audioMimeFor('list.m3u', 'audio/x-mpegurl')).toBeNull();
        expect(audioMimeFor('memo.amr', 'audio/amr')).toBeNull();
        expect(audioMimeFor('tune.mid', 'audio/midi')).toBeNull();
    });

    it('respects a concrete non-audio type — that file is not audio', () => {
        expect(audioMimeFor('song.mp3', 'application/pdf')).toBeNull();
        expect(audioMimeFor('song.mp3', 'text/html')).toBeNull();
        expect(audioMimeFor('song.mp3', 'image/png')).toBeNull();
    });

    it("treats application/ogg (RFC 5334's generic Ogg) as unlabelled: the extension decides", () => {
        expect(audioMimeFor('take.ogg', 'application/ogg')).toBe('audio/ogg');
        expect(audioMimeFor('take.opus', 'APPLICATION/OGG')).toBe('audio/ogg');
        // ...and only the extension: an Ogg-labelled file with no audio name gets no player.
        expect(audioMimeFor('stream.bin', 'application/ogg')).toBeNull();
    });

    it('leaves .webm and video to the video player (videoMimeFor is asked first)', () => {
        expect(audioMimeFor('clip.webm', '')).toBeNull();
        expect(videoMimeFor('clip.webm', '')).toBe('video/webm');
        // ...but an explicit audio/webm is audio, and the video side agrees.
        expect(videoMimeFor('voice.webm', 'audio/webm')).toBeNull();
        expect(audioMimeFor('voice.webm', 'audio/webm')).toBe('audio/webm');
        expect(audioMimeFor('clip.mp4', 'video/mp4')).toBeNull();
    });

    it('is null for non-audio names with no MIME, and for unplayable containers', () => {
        expect(audioMimeFor('notes.txt', '')).toBeNull();
        expect(audioMimeFor('noextension', 'application/octet-stream')).toBeNull();
        expect(audioMimeFor('voice.amr', '')).toBeNull();
        expect(audioMimeFor('voice.3gp', '')).toBeNull();
        expect(audioMimeFor('song.wma', '')).toBeNull();
    });

    it('never returns a type safeBlobType would change (the blob is plain audio)', () => {
        const names = ['a.mp3', 'a.m4a', 'a.aac', 'a.ogg', 'a.oga', 'a.opus', 'a.wav', 'a.flac', 'a.weba'];
        const mimes = ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg', 'audio/x-mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a',
            'audio/aac', 'audio/x-aac', 'audio/aacp', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/wave',
            'audio/vnd.wave', 'audio/flac', 'audio/x-flac', 'audio/webm'];
        for (const n of names) {
            const m = audioMimeFor(n, '');
            expect(m, n).not.toBeNull();
            expect(safeBlobType(m!), n).toBe(m);
        }
        for (const mime of mimes) {
            const m = audioMimeFor('x', mime);
            expect(m, mime).not.toBeNull();
            expect(safeBlobType(m!), mime).toBe(m);
        }
    });
});
