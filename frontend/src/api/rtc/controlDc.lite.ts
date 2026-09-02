/**
 * The lite stand-in for rtc/controlDc: vite.config.ts aliases it in for
 * VITE_ENABLE_RC=false builds. A lite build has no remote control, so the P2P
 * input lanes have neither a writer nor a reader; the mesh manager, the SFU
 * manager and VoicePanel gate every call behind __RC_ENABLED__ and never reach
 * these, and rc-exclusion-guard fails the build if the real module enters the
 * graph. Same exported shape for the symbols those three import — a real
 * module, never an empty one (an empty module makes the bindings undefined
 * and breaks the importer at load). controlDcLite.test.ts pins the shape.
 */
export const CTL_STATE_LABEL = 'sov-ctl-s';
export const CTL_SFU_TOPIC = 'sov-ctl';
export function registerControlChannel(_peerId: number, _dc: RTCDataChannel): void {}
export function forgetControlChannels(_peerId: number): void {}
export function deliverSfuControlFrame(_peerId: number, _payload: Uint8Array<ArrayBufferLike>): void {}
export function setSfuControlSender(_fn: ((userId: number, frame: Uint8Array) => boolean) | null): void {}
