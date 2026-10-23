/**
 * Is the picture coming over the LOCAL NETWORK itself?
 *
 * The stats' "direct" only means "not through a TURN relay", and that includes
 * a path punched through two NATs across the internet (server-reflexive
 * candidates), where stepping a session up to 60 fps / 10 Mbps is the last
 * thing it needs. The local network is the pair whose BOTH ends are host
 * candidates — each computer's own interface, no NAT in between — with the far
 * end on a private or link-local address. This end's own address is often
 * hidden (an mDNS name, or left out of the stats); a host candidate is one of
 * this computer's interfaces either way, so it is checked only when shown.
 */

/** The fields of an `RTCIceCandidateStats` this reads (`ip` is the old name). */
export interface CandidateLike {
    candidateType?: unknown;
    address?: unknown;
    ip?: unknown;
}

const v4 = (a: string): number[] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.every(n => n <= 255) ? parts : null;
};

/** Private (RFC 1918), link-local, loopback or IPv6 unique-local/link-local.
 *  Not the carrier-grade NAT range (100.64/10): that is the ISP's, not yours. */
export function isPrivateAddress(address: string): boolean {
    const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    const p = v4(mapped ? mapped[1] : a);
    if (p) {
        const [x, y] = p;
        return x === 10
            || (x === 172 && y >= 16 && y <= 31)
            || (x === 192 && y === 168)
            || (x === 169 && y === 254)
            || x === 127;
    }
    if (!a.includes(':')) return false;
    if (a === '::1') return true;
    return /^f[cd][0-9a-f]{0,2}:/.test(a)      // fc00::/7, unique local
        || /^fe[89ab][0-9a-f]?:/.test(a);       // fe80::/10, link-local
}

const addressOf = (c: CandidateLike): string | null => {
    const a = typeof c.address === 'string' ? c.address : typeof c.ip === 'string' ? c.ip : null;
    return a && a.length > 0 ? a : null;
};

/** The selected pair, local and remote candidate: is this the local network? */
export function isLanPair(local: CandidateLike | undefined, remote: CandidateLike | undefined): boolean {
    if (!local || !remote) return false;
    if (local.candidateType !== 'host' || remote.candidateType !== 'host') return false;
    const far = addressOf(remote);
    if (!far || !isPrivateAddress(far)) return false;
    const near = addressOf(local);
    if (near && !near.endsWith('.local') && !isPrivateAddress(near)) return false;
    return true;
}
