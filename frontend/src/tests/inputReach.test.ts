/**
 * The words for "your input is not landing" (api/devices/inputReach.ts), and
 * the one gate both ends pass the program's name through.
 */
import { describe, test, expect } from 'vitest';
import { blockedAppLabel, blockedAppName, inputBlockedMessage } from '../api/devices/inputReach';

describe('blockedAppName', () => {
    test('a short file name passes, trimmed', () => {
        expect(blockedAppName('valheim.exe')).toBe('valheim.exe');
        expect(blockedAppName('  Taskmgr.exe ')).toBe('Taskmgr.exe');
    });

    test('anything else is null — the banner is only ever added by a clean value', () => {
        for (const bad of [null, undefined, 3, {}, '', ' ', 'a/b.exe', 'C:\\x\\y.exe', 'a\u0007b', 'x'.repeat(65)]) {
            expect(blockedAppName(bad), String(bad)).toBeNull();
        }
    });
});

describe('the banner', () => {
    test('names the program, the PC, and what to do', () => {
        const m = inputBlockedMessage('valheim.exe', 'Work Laptop');
        expect(m).toContain('valheim.exe on Work Laptop is running as administrator');
        expect(m).toMatch(/without administrator rights/);
        expect(m).toMatch(/Steam/);
    });

    test('a PC with no name is "that computer"', () => {
        expect(inputBlockedMessage('valheim.exe', null)).toContain('on that computer');
        expect(inputBlockedMessage('valheim.exe', '  ')).toContain('on that computer');
    });

    test('Windows programs whose file names mean nothing are named for a person', () => {
        expect(blockedAppLabel('Taskmgr.exe')).toBe('Task Manager');
        expect(inputBlockedMessage('Taskmgr.exe', 'PC')).toContain('Task Manager on PC');
    });

    test('an administrator prompt is something to answer at the PC, not something to restart', () => {
        const m = inputBlockedMessage('consent.exe', 'PC');
        expect(m).toContain('PC is showing a Windows administrator prompt');
        expect(m).toMatch(/Ctrl\+Alt\+Del/);
        expect(m).not.toMatch(/without administrator rights/);
    });
});
