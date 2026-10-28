// @vitest-environment jsdom
/**
 * Every watched stream that stops being watched leaves ONE line in puca.log /
 * Send diagnostics saying whose and why, and stopping your own share says how
 * many other streams are still watched (voiceState: deselectStream's reason,
 * dropOwnStream, clearAllStreams). Reported 2026-10-27: "when closing my
 * stream, it still closes the streams im watching" - and nothing in either
 * log could say why the watched one closed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const lines: string[] = [];
vi.mock('../api/rtc/rtcEventLog', () => ({ logRtcEvent: (line: string) => { lines.push(line); } }));

import { clearAllStreams, deselectStream, dropOwnStream, globalSelectedStreams, type UnwatchReason } from '../components/voiceState';

const ME = 1, FRIEND = 2, OTHER = 3;

beforeEach(() => {
    globalSelectedStreams.clear();
    lines.length = 0;
});

describe('the stream-watch log', () => {
    it.each<[UnwatchReason, string]>([
        ['closed', 'closed by the viewer'],
        ['back-to-chat', 'Back to Chat'],
        ['stop-watching-all', 'stop watching, all streams'],
        ['sharer-stopped', 'the sharer stopped sharing'],
        ['sharer-left', 'the sharer left the call'],
        ['sharer-disconnected', 'the sharer disconnected'],
    ])('%s: one line naming the user and the reason', (reason, why) => {
        globalSelectedStreams.add(FRIEND);
        deselectStream(FRIEND, reason);
        // The same stop arriving on a second path is not a second line.
        deselectStream(FRIEND, reason);
        expect(lines).toEqual([`[stream-watch] user ${FRIEND}: no longer watched (${why})`]);
    });

    it('a stream that was not being watched leaves no line', () => {
        deselectStream(FRIEND, 'sharer-stopped');
        expect(lines).toEqual([]);
    });

    it('stopping your own share says how many other streams are still watched, and names nobody', () => {
        globalSelectedStreams.add(ME);
        globalSelectedStreams.add(FRIEND);
        expect(dropOwnStream(ME)).toBe(1);
        expect(lines).toEqual(['[stream-watch] own share stopped: 1 other stream still watched']);
        lines.length = 0;
        globalSelectedStreams.add(OTHER);
        dropOwnStream(ME);
        expect(lines).toEqual(['[stream-watch] own share stopped: 2 other streams still watched']);
        lines.length = 0;
        globalSelectedStreams.clear();
        dropOwnStream(ME);
        expect(lines).toEqual(['[stream-watch] own share stopped: 0 other streams still watched']);
    });

    it('leaving the call: one line per stream that was watched', () => {
        globalSelectedStreams.add(FRIEND);
        globalSelectedStreams.add(OTHER);
        clearAllStreams();
        expect(lines.sort()).toEqual([
            `[stream-watch] user ${FRIEND}: no longer watched (we left the call)`,
            `[stream-watch] user ${OTHER}: no longer watched (we left the call)`,
        ]);
    });
});
