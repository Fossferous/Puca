/**
 * Which ICE pair is the local network (api/devices/lanPath.ts). The stage
 * steps a session up to 60 fps / 10 Mbps only on this answer, so a path
 * punched across the internet — "direct", but not local — must say no.
 */
import { describe, it, expect } from 'vitest';
import { isLanPair, isPrivateAddress } from '../api/devices/lanPath';

describe('the local network', () => {
    it('private, link-local and loopback addresses are local; public and carrier-grade NAT ones are not', () => {
        for (const a of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.0.146', '169.254.3.4', '127.0.0.1',
            '::1', 'fd12:3456:789a::1', 'fc00::1', 'fe80::1c2b:3cff:fe4d:5e6f', '[fe80::1]', '::ffff:192.168.1.2']) {
            expect(isPrivateAddress(a), a).toBe(true);
        }
        for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.64.0.1', '100.127.255.254',
            '2a02:c7f:1234::1', '2001:db8::1', 'not-an-ip', '', '256.1.1.1']) {
            expect(isPrivateAddress(a), a).toBe(false);
        }
    });

    it('a host-to-host pair with the far end on a private address is the local network', () => {
        expect(isLanPair({ candidateType: 'host', address: '192.168.0.22' }, { candidateType: 'host', address: '192.168.0.146' })).toBe(true);
        // This end hidden behind an mDNS name, or left out of the stats.
        expect(isLanPair({ candidateType: 'host', address: 'a1b2c3.local' }, { candidateType: 'host', address: '192.168.0.146' })).toBe(true);
        expect(isLanPair({ candidateType: 'host' }, { candidateType: 'host', ip: '10.1.2.3' })).toBe(true);
    });

    it('a NAT-traversed pair across the internet is "direct" but NOT the local network', () => {
        expect(isLanPair({ candidateType: 'srflx', address: '81.2.69.160' }, { candidateType: 'srflx', address: '203.0.113.9' })).toBe(false);
        expect(isLanPair({ candidateType: 'host', address: '192.168.0.22' }, { candidateType: 'srflx', address: '203.0.113.9' })).toBe(false);
        expect(isLanPair({ candidateType: 'prflx', address: '192.168.0.22' }, { candidateType: 'host', address: '192.168.0.146' })).toBe(false);
    });

    it('a relay, a public host, or a pair that cannot be read is not the local network', () => {
        expect(isLanPair({ candidateType: 'relay' }, { candidateType: 'host', address: '192.168.0.146' })).toBe(false);
        // Both ends with public IPv6 host addresses: routable straight across the internet.
        expect(isLanPair({ candidateType: 'host', address: '2a02:c7f::1' }, { candidateType: 'host', address: '2a02:c7f::2' })).toBe(false);
        expect(isLanPair({ candidateType: 'host', address: '8.8.4.4' }, { candidateType: 'host', address: '192.168.0.146' })).toBe(false);
        expect(isLanPair({ candidateType: 'host' }, { candidateType: 'host' }), 'no far address: unknown').toBe(false);
        expect(isLanPair(undefined, { candidateType: 'host', address: '192.168.0.146' })).toBe(false);
    });
});
