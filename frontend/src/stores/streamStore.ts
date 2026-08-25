import { create } from 'zustand';

export interface StreamQuality {
    fps: number;
    bitrate: number;
}

interface StreamStore {
    focusedStreamId: number | null;
    focusMode: boolean;
    qualities: Record<string, StreamQuality>;
    pendingQualities: Record<string, StreamQuality>;
    setFocusedStream: (userId: number | null) => void;
    setFocusMode: (on: boolean) => void;
    setStreamQuality: (id: string | number, quality: StreamQuality) => void;
    setPendingQuality: (id: string | number, quality: StreamQuality) => void;
    clearPendingQuality: (id: string | number) => void;
    clearAllStreams: () => void;
}

export const useStreamStore = create<StreamStore>((set) => ({
    focusedStreamId: null,
    focusMode: false,
    qualities: {},
    pendingQualities: {},
    setFocusedStream: (userId) =>
        set((s) => (s.focusedStreamId === userId ? s : { focusedStreamId: userId, focusMode: userId !== null })),
    setFocusMode: (on) => set({ focusMode: on }),
    setStreamQuality: (id, quality) => set((s) => ({ qualities: { ...s.qualities, [String(id)]: quality } })),
    setPendingQuality: (id, quality) => set((s) => ({ pendingQualities: { ...s.pendingQualities, [String(id)]: quality } })),
    clearPendingQuality: (id) => set((s) => {
        const next = { ...s.pendingQualities };
        delete next[String(id)];
        return { pendingQualities: next };
    }),
    clearAllStreams: () => set({ focusedStreamId: null, focusMode: false, qualities: {}, pendingQualities: {} }),
}));
