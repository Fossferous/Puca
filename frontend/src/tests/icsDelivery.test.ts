/**
 * The .ics / phone-calendar hand-off to Púca Notes' Android plugin
 * (NotesNativePlugin.java). The Java reads shareText's `filename`, `mime`,
 * `text` and `subject` — nothing else — and both methods RESOLVE
 * {ok:false, reason} on failure. A mismatch shares "notes.txt" as text/plain
 * and reports a failed share as "Exported"; these tests pin the contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = {
    info: vi.fn(async (): Promise<{ api?: number; features?: string[] }> => ({ api: 1, features: ['share', 'calendar'] })),
    shareText: vi.fn(async (_o: unknown): Promise<unknown> => ({ ok: true })),
    addToPhoneCalendar: vi.fn(async (_o: unknown): Promise<unknown> => ({ ok: true })),
};
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n === 'NotesNative', getPlatform: () => 'android' },
    registerPlugin: () => plugin,
}));

import { addToPhoneCalendar, canAddToPhoneCalendar, deliverIcs, phoneCalendarArgs } from '../api/icsDelivery';

beforeEach(() => {
    plugin.info.mockReset().mockResolvedValue({ api: 1, features: ['share', 'calendar'] });
    plugin.shareText.mockReset().mockResolvedValue({ ok: true });
    plugin.addToPhoneCalendar.mockReset().mockResolvedValue({ ok: true });
});

describe('deliverIcs through NotesNative.shareText', () => {
    it('sends exactly {filename, mime: text/calendar, text, subject} and reports a share', async () => {
        const r = await deliverIcs('puca-notes-x.ics', 'BEGIN:VCALENDAR');
        expect(r).toEqual({ how: 'shared' });
        expect(plugin.shareText).toHaveBeenCalledTimes(1);
        const arg = plugin.shareText.mock.calls[0][0] as Record<string, unknown>;
        expect(Object.keys(arg).sort()).toEqual(['filename', 'mime', 'subject', 'text']);
        expect(arg).toEqual({ filename: 'puca-notes-x.ics', mime: 'text/calendar', text: 'BEGIN:VCALENDAR', subject: 'puca-notes-x.ics' });
    });

    it('a RESOLVED {ok:false} is a failure with the plugin’s reason, never "shared"', async () => {
        plugin.shareText.mockResolvedValue({ ok: false, reason: 'could not open the share sheet: boom' });
        await expect(deliverIcs('a.ics', 'X')).rejects.toThrow('could not open the share sheet: boom');
        plugin.shareText.mockResolvedValue({ ok: false });
        await expect(deliverIcs('a.ics', 'X')).rejects.toThrow(/share sheet/);
    });

    it('an APK that does not list "share" is not called at all', async () => {
        plugin.info.mockResolvedValue({ api: 1, features: ['calendar'] });
        // No other way out in this mocked shell: whatever it does, it must not call shareText.
        await deliverIcs('a.ics', 'X').catch(() => undefined);
        expect(plugin.shareText).not.toHaveBeenCalled();
    });
});

describe('addToPhoneCalendar', () => {
    it('is offered only when the APK lists "calendar" (a plugin proxy answers typeof === function for anything)', async () => {
        expect(await canAddToPhoneCalendar()).toBe(true);
        plugin.info.mockResolvedValue({ api: 1, features: ['share'] });
        expect(await canAddToPhoneCalendar()).toBe(false);
        plugin.info.mockRejectedValue(new Error('not implemented'));
        expect(await canAddToPhoneCalendar()).toBe(false);
    });

    it('a resolved {ok:false} rejects with the reason; {ok:true} resolves', async () => {
        plugin.addToPhoneCalendar.mockResolvedValue({ ok: false, reason: 'no calendar app on this phone' });
        await expect(addToPhoneCalendar({ title: 't', beginMs: 1 })).rejects.toThrow('no calendar app on this phone');
        plugin.addToPhoneCalendar.mockResolvedValue({ ok: true });
        await expect(addToPhoneCalendar({ title: 't', beginMs: 1 })).resolves.toBeUndefined();
    });
});

describe('phoneCalendarArgs', () => {
    it('an all-day item sends UTC midnight of its floating date, and the day after its last as the end', () => {
        // In Dublin in summer, local midnight of 1 July is 30 June 23:00Z: sending
        // that lands the event on 30 June in the phone's calendar.
        const localMidnight = Date.parse('2026-06-30T23:00:00Z');
        const a = phoneCalendarArgs({ title: 'Holiday', startMs: localMidnight, endMs: localMidnight + 2 * 86_400_000, allDay: true, dayKeys: ['2026-07-01', '2026-07-02'] });
        expect(a).toEqual({ title: 'Holiday', allDay: true, beginMs: Date.UTC(2026, 6, 1), endMs: Date.UTC(2026, 6, 3) });
        expect(a.beginMs).not.toBe(localMidnight);
    });

    it('a timed item keeps its instants (and drops a zero-length end)', () => {
        const s = Date.parse('2026-07-01T08:30:00Z');
        expect(phoneCalendarArgs({ title: 'T', startMs: s, endMs: s + 3_600_000, allDay: false, dayKeys: ['2026-07-01'], location: 'Here' }))
            .toEqual({ title: 'T', allDay: false, beginMs: s, endMs: s + 3_600_000, location: 'Here' });
        expect(phoneCalendarArgs({ title: 'T', startMs: s, endMs: s, allDay: false, dayKeys: ['2026-07-01'] })).toEqual({ title: 'T', allDay: false, beginMs: s });
    });
});
