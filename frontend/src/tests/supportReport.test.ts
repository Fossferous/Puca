import { describe, it, expect } from 'vitest';
import {
    ownerChoices, reportFileName, reportMessage, reportText, sendSupportReport, type SendDeps,
} from '../api/supportReport';
import type { Server } from '../api/servers';

const srv = (id: string, name: string, owner_id: number): Server =>
    ({ id, name, owner_id, created_at: '2026-01-01T00:00:00Z' });

describe('ownerChoices', () => {
    const servers = [srv('a', 'Zulu', 7), srv('b', 'Alpha', 9), srv('c', 'Mike', 7), srv('d', 'Bravo', 3)];

    it('puts the preferred server\'s owner first, then by server name, one entry per owner', () => {
        const c = ownerChoices(servers, 3, 'c');
        expect(c.map(x => [x.ownerId, x.serverName])).toEqual([[7, 'Mike'], [9, 'Alpha'], [3, 'Bravo']]);
    });

    it('without a preference sorts by name, and names an owner after their first server', () => {
        const c = ownerChoices(servers, 1, null);
        expect(c.map(x => [x.ownerId, x.serverName])).toEqual([[9, 'Alpha'], [3, 'Bravo'], [7, 'Mike']]);
    });

    it('marks the person\'s own servers rather than hiding them', () => {
        const c = ownerChoices(servers, 9, 'b');
        expect(c[0]).toEqual({ ownerId: 9, serverId: 'b', serverName: 'Alpha', isSelf: true });
        expect(c.filter(x => x.isSelf)).toHaveLength(1);
    });

    it('no servers, no choices', () => {
        expect(ownerChoices([], 1, 'x')).toEqual([]);
    });
});

describe('report text', () => {
    it('names the file by version and local time', () => {
        expect(reportFileName('0.9.828', new Date(2026, 8, 29, 22, 4))).toBe('puca-report-0.9.828-20260929-2204.txt');
        expect(reportFileName('0.9.8 (builtin)/x', new Date(2026, 0, 2, 3, 4))).toBe('puca-report-0.9.8__builtin__x-20260102-0304.txt');
        expect(reportFileName('', new Date(2026, 0, 2, 3, 4))).toBe('puca-report-unknown-20260102-0304.txt');
    });

    it('the message carries the note on one line, capped, then the file', () => {
        expect(reportMessage('1.0', '', '[f](x)')).toBe('Diagnostics report (Púca 1.0)\n[f](x)');
        expect(reportMessage('1.0', '  stream\n\nfroze  ', '[f](x)')).toBe('Diagnostics report (Púca 1.0)\n"stream froze"\n[f](x)');
        const long = reportMessage('1.0', 'y'.repeat(900), '[f](x)');
        expect(long.split('\n')[1]).toHaveLength(502);
    });

    it('the file holds the diagnostics, then the log, or says there is none', () => {
        const t = reportText('DIAG\n', 'LOG LINE');
        expect(t.indexOf('DIAG')).toBeLessThan(t.indexOf('LOG LINE'));
        expect(t).toContain('app log');
        expect(reportText('DIAG', null)).toContain('keeps no app log file');
    });
});

/** jsdom's File has no text(). */
function readText(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsText(f);
    });
}

function fakeDeps(over: Partial<SendDeps> = {}) {
    const calls: string[] = [];
    let uploaded: File | null = null;
    let sealed: [string, number] | null = null;
    let posted: [string, string] | null = null;
    const deps: SendDeps = {
        version: async () => '0.9.828',
        diagnostics: async () => 'DIAG-REPORT',
        readLog: async () => 'THE-LOG',
        upload: async f => { calls.push('upload'); uploaded = f; return '[r.txt](sovereign-enc:1?k=K)'; },
        openConversation: async id => { calls.push(`open:${id}`); return { id: 'conv-1' }; },
        encrypt: async (text, id) => { calls.push('encrypt'); sealed = [text, id]; return `SEALED(${text})`; },
        post: async (cid, wire) => { calls.push('post'); posted = [cid, wire]; return {}; },
        now: () => new Date(2026, 8, 29, 22, 42),
        ...over,
    };
    return { deps, calls, get uploaded() { return uploaded; }, get sealed() { return sealed; }, get posted() { return posted; } };
}

describe('sendSupportReport', () => {
    it('uploads the report, then DMs the owner a sealed message pointing at it', async () => {
        const f = fakeDeps();
        const size = await sendSupportReport(42, 'froze at 9pm', f.deps);
        expect(f.calls).toEqual(['upload', 'open:42', 'encrypt', 'post']);
        const file = f.uploaded!;
        expect(file.name).toBe('puca-report-0.9.828-20260929-2242.txt');
        expect(file.type).toBe('text/plain');
        const text = await readText(file);
        expect(text).toContain('DIAG-REPORT');
        expect(text).toContain('THE-LOG');
        expect(size).toBe(file.size);
        expect(f.sealed).toEqual(['Diagnostics report (Púca 0.9.828)\n"froze at 9pm"\n[r.txt](sovereign-enc:1?k=K)', 42]);
        // What is posted is the SEALED text, to the owner's conversation.
        expect(f.posted).toEqual(['conv-1', `SEALED(${f.sealed![0]})`]);
    });

    it('a failed upload sends nothing', async () => {
        const f = fakeDeps({ upload: async () => { throw new Error('too big'); } });
        await expect(sendSupportReport(42, '', f.deps)).rejects.toThrow('too big');
        expect(f.posted).toBeNull();
        expect(f.calls).not.toContain('post');
    });

    it('a failed encryption posts nothing (never plaintext)', async () => {
        const f = fakeDeps({ encrypt: async () => { throw new Error('no key'); } });
        await expect(sendSupportReport(42, '', f.deps)).rejects.toThrow('no key');
        expect(f.posted).toBeNull();
    });

    it('a failed measurement or version still sends, saying what failed', async () => {
        const f = fakeDeps({
            diagnostics: async () => { throw new Error('stats hung'); },
            version: async () => { throw new Error('x'); },
            readLog: async () => null,
        });
        await sendSupportReport(1, '', f.deps);
        const text = await readText(f.uploaded!);
        expect(text).toContain('diagnostics unavailable: stats hung');
        expect(text).toContain('keeps no app log file');
        expect(f.uploaded!.name).toMatch(/^puca-report-unknown-/);
    });
});
