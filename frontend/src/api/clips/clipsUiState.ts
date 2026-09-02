/**
 * React-side glue for the replay-buffer state bus. Lives outside the component
 * files so those export only components (react-refresh).
 */
import { useEffect, useState } from 'react';
import { subscribeReplay, getReplayState, type ReplayState } from './replayBuffer';

/** Server policy for the VOICE channel's server (not the viewed one) —
 *  computed in Chat.tsx, threaded through VoicePanel to the clip controls. */
export interface ClipPolicy {
    /** clipsAvailable(server): the server carries the fields AND has clips on. */
    available: boolean;
    /** undefined ⇒ pre-Clips server (buttons hidden). */
    serverClipsEnabled: boolean | undefined;
    /** The viewer owns that server — see clipsGate's `viewerIsOwner`. */
    viewerIsOwner: boolean;
    serverId: string | null;
    /** clip_max_seconds (server default 120 when absent). */
    maxSeconds: number;
    /** clip_channel_id — the one target allowed, or null = clipper picks. */
    pinnedChannelId: number | null;
    /** The viewed channel when it belongs to the voice server — the default target. */
    defaultTargetChannelId: number | null;
    /** The voice channel's effective permission bits (CREATE_CLIPS gate). */
    voiceChannelPerms: number | null;
}

/** A policy for "no server info" — what a caller without a voice server passes. */
export const NO_CLIP_POLICY: ClipPolicy = {
    available: false, serverClipsEnabled: undefined, viewerIsOwner: false, serverId: null, maxSeconds: 120,
    pinnedChannelId: null, defaultTargetChannelId: null, voiceChannelPerms: null,
};

export function useReplayState(): ReplayState {
    const [s, setS] = useState<ReplayState>(getReplayState());
    useEffect(() => subscribeReplay(setS), []);
    return s;
}
