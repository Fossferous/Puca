/**
 * WebRTC Manager for Púca
 * 
 * Manages peer-to-peer connections for voice/video communication.
 * Refactored into modular components in ./rtc/
 */

export * from './rtc/types';

import { WebRTCManager } from './rtc/manager';

// Export singleton instance
export const webrtcManager = new WebRTCManager();

// Debug hook (mesh twin of __pucaVoiceDiag): per-peer signaling + RTP
// truth, readable from a user's own DevTools at the moment a mesh call
// misbehaves. Run:  await __pucaMeshDiag()  — or, while it feels slow,
// `await __pucaMeshDiag(5000)` for the delay fields measured over a 5 s
// window of real use rather than since the track started.
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__pucaMeshDiag =
        (windowMs?: number) => webrtcManager.meshDiagnostics(windowMs);
}
