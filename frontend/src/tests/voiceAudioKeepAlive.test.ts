import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    keepVoiceAudioAlive,
    installVoiceAudioResume,
    REPAUSE_FIGHT_WINDOW_MS,
    REPAUSE_RETRY_DELAY_MS,
} from '../components/voiceAudioKeepAlive';

/**
 * THE CONTRACT: a remote-voice <audio> element that is still in the DOM with
 * a live stream must never STAY paused — Android pauses playback when the app
 * backgrounds while the mic (no media element) keeps transmitting, which is
 * the "we could still hear him but he couldn't hear us" field report. A
 * deliberate teardown always removes the element or clears srcObject first,
 * so those two states are the only ones the keep-alive may touch.
 */

let play: ReturnType<typeof vi.spyOn>;

function liveAudio(id = 'audio-42'): HTMLAudioElement {
    const a = document.createElement('audio');
    a.id = id;
    // jsdom has no media stack: srcObject is typed but unimplemented storage
    // works, and `paused` is true until play() — which we mock anyway.
    a.srcObject = {} as MediaStream;
    document.body.appendChild(a);
    return a;
}

beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});

afterEach(() => {
    document.querySelectorAll('audio').forEach(a => a.remove());
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('keepVoiceAudioAlive', () => {
    it('re-plays a live element the platform paused', () => {
        const a = liveAudio();
        keepVoiceAudioAlive(a);
        a.dispatchEvent(new Event('pause'));
        expect(play).toHaveBeenCalledTimes(1);
    });

    it('leaves a REMOVED element alone (leave / peer-left teardown)', () => {
        const a = liveAudio();
        keepVoiceAudioAlive(a);
        a.remove();
        a.dispatchEvent(new Event('pause'));
        expect(play).not.toHaveBeenCalled();
    });

    it('leaves an element without a stream alone', () => {
        const a = liveAudio();
        a.srcObject = null;
        keepVoiceAudioAlive(a);
        a.dispatchEvent(new Event('pause'));
        expect(play).not.toHaveBeenCalled();
    });

    it('backs off to one timer when the platform re-pauses immediately, then retries', () => {
        vi.useFakeTimers();
        const a = liveAudio();
        keepVoiceAudioAlive(a);

        a.dispatchEvent(new Event('pause'));            // nudge 1: immediate
        expect(play).toHaveBeenCalledTimes(1);

        a.dispatchEvent(new Event('pause'));            // platform insists
        a.dispatchEvent(new Event('pause'));            // ...twice
        expect(play).toHaveBeenCalledTimes(1);          // no synchronous fight

        vi.advanceTimersByTime(REPAUSE_RETRY_DELAY_MS + 1);
        expect(play).toHaveBeenCalledTimes(2);          // one deferred retry
    });

    it('fights again once the insist window has passed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const a = liveAudio();
        keepVoiceAudioAlive(a);
        a.dispatchEvent(new Event('pause'));
        expect(play).toHaveBeenCalledTimes(1);

        vi.setSystemTime(REPAUSE_FIGHT_WINDOW_MS + 1);
        a.dispatchEvent(new Event('pause'));
        expect(play).toHaveBeenCalledTimes(2);
    });

    it('uninstall stops resuming (element re-used after cleanup)', () => {
        const a = liveAudio();
        const un = keepVoiceAudioAlive(a);
        un();
        a.dispatchEvent(new Event('pause'));
        expect(play).not.toHaveBeenCalled();
    });
});

describe('installVoiceAudioResume', () => {
    const setVisibility = (state: DocumentVisibilityState) => {
        Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    };

    it('resumes paused voice elements on return to foreground', () => {
        const a = liveAudio('audio-7');
        // jsdom elements report paused=true; that is exactly the state under test.
        expect(a.paused).toBe(true);
        const un = installVoiceAudioResume();
        setVisibility('visible');
        expect(play).toHaveBeenCalledTimes(1);
        un();
    });

    it('does nothing while going hidden, and ignores non-voice audio', () => {
        liveAudio('audio-7');
        const other = document.createElement('audio');
        other.id = 'notification-sound';
        other.srcObject = {} as MediaStream;
        document.body.appendChild(other);

        const un = installVoiceAudioResume();
        setVisibility('hidden');
        expect(play).not.toHaveBeenCalled();
        setVisibility('visible');
        expect(play).toHaveBeenCalledTimes(1); // only audio-7
        un();
    });

    it('skips elements whose stream is already torn down', () => {
        const a = liveAudio('audio-7');
        a.srcObject = null;
        const un = installVoiceAudioResume();
        setVisibility('visible');
        expect(play).not.toHaveBeenCalled();
        un();
    });
});
