/**
 * Bundle entry for the peer-to-peer loopback harness.
 *
 * Exposes the REAL transfer engine on `window` so e2e/p2p-loopback.mjs can drive
 * it across two genuine RTCPeerConnections inside one Chromium page. Nothing
 * here is shipped — vite never sees this file; the harness builds it with
 * esbuild on demand.
 */
import {
    sendFile,
    sha256OfBlob,
    TransferReceiver,
    CHUNK_SIZE,
    HIGH_WATER,
    type ByteSink,
} from '../src/api/fileTransfer';

declare global {
    interface Window {
        P2P: {
            sendFile: typeof sendFile;
            sha256OfBlob: typeof sha256OfBlob;
            TransferReceiver: typeof TransferReceiver;
            CHUNK_SIZE: number;
            HIGH_WATER: number;
        };
    }
}

window.P2P = { sendFile, sha256OfBlob, TransferReceiver, CHUNK_SIZE, HIGH_WATER };

export type { ByteSink };
