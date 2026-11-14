/**
 * Switching voice channel while talking left your own speaking ring lit in
 * the next channel (until you spoke again; forever when muted or in an AFK
 * channel, where no detector lights or puts out your ring) and every watched
 * stream ducked under it (StreamStage ducks while anybody is speaking).
 *
 * THE BUG. A channel switch remounts VoicePanel without leaveVoice. Its
 * teardown stopped every voice-activity detector, but only leaveVoice ever
 * cleared the speaking set, so whoever was speaking at that moment stayed in
 * it with nothing left to take them out.
 *
 * VoicePanel cannot be mounted under vitest: the teardown is one function
 * (voiceState.stopSpeakingDetectors), tested here, and both ways out of a
 * call are read from VoicePanel's source to go through it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { globalSpeakingUsers, setUserSpeaking, stopSpeakingDetectors, subscribeToSpeaking } from '../components/voiceState';

const ME = 5;
const THEM = 7;

describe('stopSpeakingDetectors', () => {
    it('THE BUG: the detectors stopped, nobody is left speaking, and the readers are told', () => {
        const stopped: number[] = [];
        const cleanups = new Map<number, () => void>([
            [ME, () => stopped.push(ME)],
            [THEM, () => stopped.push(THEM)],
            [-1, () => stopped.push(-1)], // the silent-capture sentinel
        ]);
        setUserSpeaking(ME, true); // talking at the moment of the switch
        setUserSpeaking(THEM, true);
        let told = 0;
        const off = subscribeToSpeaking(() => { told++; });
        try {
            stopSpeakingDetectors(cleanups);
        } finally {
            off();
        }
        expect(stopped.sort()).toEqual([-1, ME, THEM].sort());
        expect(cleanups.size).toBe(0);
        expect([...globalSpeakingUsers], 'a ring left lit with no detector to put it out').toEqual([]);
        expect(told, 'the rings and the ducking re-read the store only when told').toBeGreaterThan(0);
    });

    it('CONTROL: nobody speaking, nothing to tell', () => {
        let told = 0;
        const off = subscribeToSpeaking(() => { told++; });
        stopSpeakingDetectors(new Map());
        off();
        expect(told).toBe(0);
    });
});

describe('VoicePanel ends both ways out of a call there', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'VoicePanel.tsx'), 'utf8');

    it('the channel-switch teardown (a remount, without leaveVoice)', () => {
        const at = src.indexOf('// A channel switch (incl. VoiceMoved) remounts the panel without');
        expect(at, 'the teardown was found').toBeGreaterThan(-1);
        const teardown = src.slice(at, src.indexOf('}, [roomId]);', at));
        expect(teardown).toMatch(/stopSpeakingDetectors\(vadCleanups\)/);
        expect(teardown, 'detectors stopped some other way, leaving the ring').not.toMatch(/vadCleanups\.forEach/);
    });

    it('leaveVoice', () => {
        expect(src).toMatch(/stopSpeakingDetectors\(voiceDetectorCleanups\.current\)/);
        expect(src, 'every detector stopped some other way').not.toMatch(/voiceDetectorCleanups\.current\.forEach/);
    });
});
