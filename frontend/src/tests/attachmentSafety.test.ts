import { describe, it, expect } from 'vitest';
import { safeBlobType, videoMimeFor } from '../api/attachments';

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
