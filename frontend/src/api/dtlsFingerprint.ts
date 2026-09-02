/**
 * DTLS certificate fingerprints, the way SDP carries them:
 *
 *     a=fingerprint:sha-256 AB:CD:...:EF
 *
 * A "peer-to-peer" transfer negotiates through the server: it relays the SDP,
 * so it can answer an offer with a connection of its own and terminate DTLS in
 * the middle — the receiver's hash check then passes against whatever the
 * middle chose. The fix is to authenticate each side's fingerprint in the
 * offer/accept record (fileTransferManager.ts) and, when the remote
 * description arrives, require that it presents EXACTLY that fingerprint. Once
 * the server cannot terminate DTLS, rewriting ICE only lets it choose the
 * path, which it already controls through the ICE config it serves.
 *
 * Canonical form everywhere: "<lower-case algorithm> <UPPER:CASE:HEX>". Both
 * sides canonicalise before authenticating and before comparing, so a
 * differently-cased equivalent is never a mismatch and never a bypass.
 */

const ALG = /^[a-z0-9-]+$/;
const HEX = /^([0-9A-F]{2}:)+[0-9A-F]{2}$/;

/** "<alg> <HEX>" or null when either half is not a fingerprint. */
export function normalizeFingerprint(algorithm: string, value: string): string | null {
    const alg = algorithm.trim().toLowerCase();
    const hex = value.trim().toUpperCase();
    if (!ALG.test(alg) || !HEX.test(hex)) return null;
    return `${alg} ${hex}`;
}

/** Parse an already-joined "<alg> <hex>" string into canonical form. */
export function parseFingerprint(fp: string): string | null {
    const sp = fp.indexOf(' ');
    if (sp <= 0) return null;
    return normalizeFingerprint(fp.slice(0, sp), fp.slice(sp + 1));
}

/** Every a=fingerprint line of an SDP, canonicalised; a malformed one is null
 *  (so it can never equal anything). */
export function sdpFingerprints(sdp: string): (string | null)[] {
    const out: (string | null)[] = [];
    for (const raw of sdp.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith('a=fingerprint:')) continue;
        const rest = line.slice('a=fingerprint:'.length).trim();
        const sp = rest.indexOf(' ');
        out.push(sp > 0 ? normalizeFingerprint(rest.slice(0, sp), rest.slice(sp + 1)) : null);
    }
    return out;
}

/** The m= lines of an SDP (one per media section). */
export function sdpMediaLines(sdp: string): string[] {
    return sdp.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('m='));
}

/**
 * Does this description present exactly `fp`, and nothing but a single data
 * channel? EVERY fingerprint line must equal it (RFC 8122 allows several; a
 * second one under another hash could otherwise be the one selected) and there
 * must be exactly one media section, of type application — a file transfer
 * negotiates nothing else, so anything more is not this transfer's connection.
 */
export function sdpBoundTo(sdp: string, fp: string): boolean {
    const canon = parseFingerprint(fp);
    if (!canon) return false;
    const fps = sdpFingerprints(sdp);
    if (fps.length === 0 || fps.some(f => f !== canon)) return false;
    const m = sdpMediaLines(sdp);
    return m.length === 1 && m[0].startsWith('m=application ');
}

/**
 * The canonical fingerprint of a certificate we generated. `getFingerprints()`
 * where the engine has it; otherwise a throwaway connection that carries the
 * certificate is asked for an offer (never applied, so nothing gathers) and
 * the fingerprint is read from the SDP.
 */
export async function certificateFingerprint(cert: RTCCertificate): Promise<string | null> {
    const direct = (cert as RTCCertificate & { getFingerprints?: () => { algorithm?: string; value?: string }[] }).getFingerprints;
    if (typeof direct === 'function') {
        for (const f of direct.call(cert)) {
            const fp = f.algorithm && f.value ? normalizeFingerprint(f.algorithm, f.value) : null;
            if (fp) return fp;
        }
        return null;
    }
    let pc: RTCPeerConnection | null = null;
    try {
        pc = new RTCPeerConnection({ certificates: [cert] });
        pc.createDataChannel('fp');
        const offer = await pc.createOffer();
        const fps = offer.sdp ? sdpFingerprints(offer.sdp) : [];
        return fps.find((f): f is string => !!f) ?? null;
    } catch {
        return null;
    } finally {
        try { pc?.close(); } catch { /* already closed */ }
    }
}
