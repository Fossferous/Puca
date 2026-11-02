/**
 * Chat.tsx is too large to mount for each of these, and a pure test of a rule cannot see
 * Chat stop calling it. So the seams the walk (e2e/modes-walk.mjs) cannot provoke are held
 * here: the frame racing a fetch needs a read landing inside a few milliseconds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chat = readFileSync(resolve(__dirname, '../components/Chat.tsx'), 'utf8');

describe('a navigation target opens and never joins', () => {
    const opener = () => {
        const at = chat.indexOf('openChannelRef.current = (');
        return chat.slice(at, chat.indexOf('stays where it is', at));
    };

    it('every way out of the opener asks first', () => {
        const body = opener();
        const clicks = [...body.matchAll(/handleChannelClick\(/g)].length;
        expect(clicks, 'control: this is the code that opens a channel').toBe(2);
        expect([...body.matchAll(/if \(opensFromNav\(\w+\)\) handleChannelClick\(/g)].length).toBe(clicks);
    });

    it('a notification, a toast and a target all come through it', () => {
        expect([...chat.matchAll(/openChannelRef\.current\(/g)].length).toBe(3);
    });

    it('forgets a removal the server says was not a move', () => {
        expect(chat).toContain('sfuCutRef.current = cutAfterRoomLeft(sfuCutRef.current, payload.room_id)');
    });

    it('tells Notes when a mode switches', () => {
        expect(chat).toContain('window.dispatchEvent(new CustomEvent(MODES_CHANGED_EVENT))');
    });
});

describe('the role editor on a backend with no modes', () => {
    const settings = readFileSync(resolve(__dirname, '../components/ServerSettingsModal.tsx'), 'utf8');

    it('is told so by Server Settings, which already knows', () => {
        const editor = settings.slice(settings.indexOf('<RoleSettingsModal'));
        expect(editor.slice(0, editor.indexOf('/>'))).toContain('modesSupported={modesSupported}');
    });
});

describe('Notes counts what it can show', () => {
    const shell = readFileSync(resolve(__dirname, '../notes/components/NotesShell.tsx'), 'utf8');

    it('its labels and its rail leave out what a mode hides', () => {
        expect(shell).toContain('allLabels(unhiddenNotes(cards))');
        expect(shell).toContain('const unhidden = unhiddenNotes(cards);');
    });
});

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
