// Stand-in for api/platform, for the clip modules only: they arm only in the
// desktop app (replayBuffer.isClipCaptureSupported asks isTauri). Their calls
// into the shell (`@tauri-apps/api/core` invoke: the tray indicator,
// log_stream_diag) find no shell here and are best effort by design.
export const isTauri = (): boolean => true;
export const isMobile = (): boolean => false;
export const isAndroidApp = (): boolean => false;
