/**
 * The voice panel's connection line: which call, and whether this device is
 * in it yet.
 *
 * On an SFU channel the panel is in the call (the room joined, the roster and
 * listeners wired: VoicePanel's isInVoiceRef flips early, on purpose) a while
 * before its media is: sfuManager.connect is still waiting for LiveKit to say
 * Connected and for the microphone to publish. The line said "Voice
 * Connected" all that time, and so did `data-testid="voice-connected"`, which
 * docs/AUTOMATION.md promises means this device is in the call: an automation
 * that pressed Share on it shared into a call that had no media yet. Until
 * the join is done the line says "Connecting…" and carries
 * `voice-connecting` instead.
 */
import type { ReactNode } from 'react';

import { MoonIcon, SignalIcon } from './Icons';

export function VoiceConnectionLine({
    joining,
    isAfkChannel,
    micOffByChoice,
    speakDenied,
    listenOnly,
    channelName,
    children,
}: {
    /** The join is still under way (VoicePanel's isConnecting, cleared when the join is done). */
    joining: boolean;
    isAfkChannel: boolean;
    micOffByChoice: boolean;
    speakDenied: boolean;
    listenOnly: boolean;
    channelName: string;
    /** Beside the words: the call's encryption badge. */
    children?: ReactNode;
}) {
    const label = joining ? 'Connecting…'
        : isAfkChannel ? 'AFK — mic disabled'
        : micOffByChoice ? 'Voice Connected · no microphone'
        : speakDenied ? "Voice Connected · can't speak"
        : listenOnly ? 'Voice Connected · listen-only'
        : 'Voice Connected';
    return (
        <div
            className={`voice-connection-info${joining ? ' voice-connecting' : ''}`}
            // Automation contract (docs/AUTOMATION.md).
            data-testid={joining ? 'voice-connecting' : 'voice-connected'}
            aria-busy={joining || undefined}
        >
            <div className="voice-status-row">
                <span className="voice-connected-icon">{isAfkChannel ? <MoonIcon /> : <SignalIcon />}</span>
                <div className="voice-connection-text">
                    <span className="voice-connected-label" role="status">{label}</span>
                    <span className="voice-channel-name">{channelName}</span>
                </div>
                {children}
            </div>
        </div>
    );
}
