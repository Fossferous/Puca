/**
 * Chat.tsx is too large to mount for each of these, and a pure test of a rule cannot see
 * Chat stop calling it. So the seams the walk (e2e/modes-walk.mjs) cannot provoke are held
 * here: the frame racing a fetch needs a read landing inside a few milliseconds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chat = readFileSync(resolve(__dirname, '../components/Chat.tsx'), 'utf8');

describe('text in the chat that sets its own colour holds over a picture', () => {
    const css = readFileSync(resolve(__dirname, '../components/Chat.css'), 'utf8').replace(/\r\n/g, '\n');
    const rule = (selector: string) => {
        const at = css.indexOf(`\n${selector} {`);
        expect(at, `control: ${selector} is in the stylesheet`).toBeGreaterThan(-1);
        return css.slice(at, css.indexOf('}', at));
    };

    it('what is written in the brand colour on the picture takes the colour made for it', () => {
        for (const selector of [
            '.message-author', '.message-link', '.collection-channel-header .channel-name', '.task-checkbox:hover',
            '.task-checkbox.completed', '.message-reply-ref .reply-icon', '.message-reply-ref .reply-author',
        ]) {
            expect(rule(selector), selector).toContain('color: var(--mode-brand-text, var(--brand-primary))');
        }
    });

    it('and any other brand-coloured text is on a surface of its own, or has to say so here', () => {
        const rest = [...css.matchAll(/\n([^\n{}]+) \{[^}]*\n\s*color: var\(--brand-primary\);/g)].map(m => m[1]).sort();
        expect(rest).toEqual([
            '.reply-preview-banner .reply-icon',
            '.reply-preview-banner .replying-to strong',
            '.search-result-item strong',
            '.typing-dots',
        ]);
    });

    it('@everyone reads as a warning on a surface that leans away from it', () => {
        expect(rule('.mention.everyone')).toContain('background: var(--mode-mention-bg,');
        expect(rule('.mention.everyone')).toContain('color: var(--text-warning)');
    });

    it('a file chip, a reply and the not-encrypted tag', () => {
        expect(rule('.message-attachment')).toContain('background: var(--mode-chip-bg,');
        expect(rule('[data-theme="light"] .message-attachment')).toContain('background: var(--mode-chip-bg,');
        expect(css).toContain('\nbutton.message-attachment:hover { background: var(--mode-chip-bg,');
        expect(css).toContain('[data-theme="light"] button.message-attachment:hover { background: var(--mode-chip-bg,');
        expect(rule('.message-reply-ref')).toContain('background: var(--mode-reply-bg,');
        expect(rule('.message-reply-ref:hover')).toContain('background: var(--mode-reply-hover-bg,');
        expect(rule('[data-theme="light"] .not-encrypted-tag')).toContain('color: var(--mode-warning-text,');
        expect(rule('[data-theme="light"] .not-encrypted-tag.unexpected')).toContain('color: var(--mode-danger-text,');
    });
});

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

    it('and the note of a cut expects the answer to this device leaving', () => {
        expect(chat).toContain('sfuCutRef.current = { channelId: currentVoiceChannel.id, at: Date.now(), leaveUnanswered: true }');
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
