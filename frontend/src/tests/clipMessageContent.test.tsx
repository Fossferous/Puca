/**
 * The `sovereign-clip` scheme is allow-listed in messageParser ONLY because
 * MessageContent dispatches a clip ref to ClipAttachment before any <a> can be
 * emitted. That guard is a single line; this test is what notices if it goes
 * (review #7): delete the `isClipRef` dispatch and the key becomes a navigable
 * href the WebView2 hands to the OS shell handler.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../components/MessageContent';
import { encodeClipRef } from '../api/clips/clipRef';

const href = encodeClipRef({
    key: new Uint8Array(32).fill(1), noncePrefix: new Uint8Array(8).fill(2), clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
    videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: 5000, width: 1920, height: 1080, totalCipherBytes: 1234,
    parts: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'], partDurMs: [0, 5000],
});

describe('MessageContent × clip refs', () => {
    it('a link-form clip ref renders the ClipAttachment plate and NO <a href="sovereign-clip…">', () => {
        const html = renderToStaticMarkup(<MessageContent content={`[Clip 0:05](${href})`} members={[]} />);
        expect(html).toContain('clip-attachment');
        expect(html).toContain('clip-attachment-play');
        expect(html).not.toMatch(/<a [^>]*href="sovereign-clip/);
        expect(html).not.toContain(href.slice(20, 60)); // the packed manifest never appears in markup at all
    });
    it('an image-form clip ref does the same', () => {
        const html = renderToStaticMarkup(<MessageContent content={`![clip](${href})`} members={[]} />);
        expect(html).toContain('clip-attachment');
        expect(html).not.toMatch(/<a [^>]*href="sovereign-clip/);
        expect(html).not.toContain('<img');
    });
    it('(positive control) an ordinary https link still renders as an <a>', () => {
        const html = renderToStaticMarkup(<MessageContent content="[site](https://example.com/x)" members={[]} />);
        expect(html).toMatch(/<a [^>]*href="https:\/\/example.com\/x"/);
    });
    it('a scrubbed ref (Copy Text / Quote / Forward) reads "clip removed" and is not a link', () => {
        const html = renderToStaticMarkup(<MessageContent content="[Clip 0:05](sovereign-clip:v1)" members={[]} />);
        expect(html).toContain('clip removed');
        expect(html).not.toMatch(/<a /);
    });
    it('the badge follows the stamp: approved (n) / solo / mismatch refuses / none', () => {
        const parts = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
        const ok = renderToStaticMarkup(<MessageContent content={`[c](${href})`} members={[]} clipConsent={{ proposal_id: 'p', approver_count: 3, part_file_ids: parts, solo: false }} />);
        expect(ok).toContain('Approved by everyone in the call (3 people)');
        const solo = renderToStaticMarkup(<MessageContent content={`[c](${href})`} members={[]} clipConsent={{ proposal_id: 'p', approver_count: 0, part_file_ids: parts, solo: true }} />);
        expect(solo).toContain('Solo clip');
        const bad = renderToStaticMarkup(<MessageContent content={`[c](${href})`} members={[]} clipConsent={{ proposal_id: 'p', approver_count: 2, part_file_ids: [parts[0]], solo: false }} />);
        expect(bad).toContain('nobody approved');
        expect(bad).toMatch(/clip-attachment-play[^>]*disabled/);
        const none = renderToStaticMarkup(<MessageContent content={`[c](${href})`} members={[]} />);
        expect(none).not.toContain('Approved by');
        expect(none).not.toContain('nobody approved');
    });
});
