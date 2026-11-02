/**
 * Chat.tsx is too large to mount for each of these, and a pure test of a rule cannot see
 * Chat stop calling it. So the seams the walk (e2e/modes-walk.mjs) cannot provoke are held
 * here: the frame racing a fetch needs a read landing inside a few milliseconds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chat = readFileSync(resolve(__dirname, '../components/Chat.tsx'), 'utf8');

describe('Chat and the mode rules', () => {
    it('adopts a frame through the rule that beats a fetch in flight, not by setting the row', () => {
        expect(chat).toContain('adoptModeFrame<Server>(queryClient, keys.servers, f);');
        expect(chat).not.toContain('applyActiveMode(');
    });

    it('names what ended from the frame, and says why from the RoomLeft that follows', () => {
        expect(chat).toContain('roomLeftNotice(msg.payload, endedModeNameRef.current)');
        expect(chat).not.toContain('so this call ended');
    });

    it('sends a notification to the channel, across servers, by the rule for when it has no row', () => {
        expect(chat.match(/openChannelRef\.current\(p\.channel_id, p\.server_id\)/g)).toHaveLength(2);
        expect(chat).toContain('nav: notificationNav(');
        expect(chat).toContain("target.startsWith('channel:')");
    });
});
