/**
 * The half of streamStats.ts that has to touch a transport (same split as
 * shareHealthLive.ts): the reducer stays dependency-free and tested without
 * a browser; this finds a stream's senders/receivers on whichever transport
 * carries it.
 */
import { sfuManager } from './sfuManager';
import { webrtcManager } from '../webrtc';
import { StreamStatsSampler, type RtpEndpoint } from './streamStats';

/** A sampler for `stream`. The SFU is asked first: on an SFU channel the
 *  mesh manager has no peers and would answer nothing anyway. */
export function streamStatsSampler(stream: MediaStream): StreamStatsSampler {
    return new StreamStatsSampler(() => {
        const tracks = stream.getTracks();
        let out: RtpEndpoint[] = [];
        try { out = sfuManager.rtpEndpointsFor(tracks); } catch { /* not on an SFU call */ }
        if (out.length === 0) {
            try { out = webrtcManager.rtpEndpointsFor(tracks); } catch { /* no mesh peers */ }
        }
        return out;
    });
}
