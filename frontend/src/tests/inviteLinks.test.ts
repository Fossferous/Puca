/**
 * Invite links (api/pendingInvite.ts + api/publicConfig.ts).
 *
 * The desktop app copied `${window.location.origin}/invite/<code>`, which in
 * a Tauri webview is http://tauri.localhost — a link nobody could open. The
 * link is now built from the web app's PUBLIC address (GET /config), and the
 * parser accepts the old broken links, bare codes and the new links alike.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    inviteLink,
    parseInviteCode,
    stashPendingInvite,
    peekPendingInvite,
    consumePendingInvite,
} from '../api/pendingInvite';
import { parsePublicConfig, fetchPublicConfig, __resetPublicConfigForTest } from '../api/publicConfig';

describe('inviteLink', () => {
    it('builds from the configured public URL, never from window.location', () => {
        // Positive control for the whole fix: the webview origin is NOT in the link.
        expect(window.location.origin).toContain('localhost');
        const link = inviteLink('aBc123Xy', 'https://app.example.org');
        expect(link).toBe('https://app.example.org/invite/aBc123Xy');
        expect(link).not.toContain('localhost');
    });

    it('tolerates a trailing slash on the base', () => {
        expect(inviteLink('x1y2z3', 'https://app.example.org/')).toBe('https://app.example.org/invite/x1y2z3');
    });

    it('is null when the operator has no public URL — the bare code is what gets shared', () => {
        expect(inviteLink('x1y2z3', null)).toBeNull();
    });
});

describe('parseInviteCode', () => {
    it('reads the code out of a link on ANY host, including the pre-0.9.2 tauri.localhost ones', () => {
        expect(parseInviteCode('https://app.example.org/invite/aBc123Xy')).toBe('aBc123Xy');
        expect(parseInviteCode('http://tauri.localhost/invite/aBc123Xy')).toBe('aBc123Xy');
        expect(parseInviteCode('https://localhost/invite/aBc123Xy/')).toBe('aBc123Xy');
        expect(parseInviteCode('  https://app.example.org/invite/aBc123Xy?utm=1#x ')).toBe('aBc123Xy');
    });

    it('accepts a bare code', () => {
        expect(parseInviteCode('aBc123Xy')).toBe('aBc123Xy');
        expect(parseInviteCode('  aBc123Xy  ')).toBe('aBc123Xy');
    });

    it('rejects things that are not codes', () => {
        expect(parseInviteCode('')).toBeNull();
        expect(parseInviteCode('   ')).toBeNull();
        expect(parseInviteCode('abc')).toBeNull();                 // too short
        expect(parseInviteCode('has spaces in it')).toBeNull();
        expect(parseInviteCode('https://app.example.org/')).toBeNull();
        expect(parseInviteCode('<script>')).toBeNull();
    });
});

describe('pending invite stash', () => {
    beforeEach(() => sessionStorage.clear());

    it('survives until consumed, then is gone', () => {
        expect(peekPendingInvite()).toBeNull();
        stashPendingInvite('aBc123Xy');
        expect(peekPendingInvite()).toBe('aBc123Xy');   // peek does not consume (Login reads it)
        expect(consumePendingInvite()).toBe('aBc123Xy');
        expect(consumePendingInvite()).toBeNull();
    });
});

describe('GET /config parsing', () => {
    it('normalises a good answer and refuses non-http URLs', () => {
        expect(parsePublicConfig({ app_url: 'https://app.example.org/', registration_invite_required: true }))
            .toEqual({ appUrl: 'https://app.example.org', registrationInviteRequired: true, srpVersion: null });
        expect(parsePublicConfig({ app_url: 'app.example.org', registration_invite_required: false }))
            .toEqual({ appUrl: null, registrationInviteRequired: false, srpVersion: null });
        expect(parsePublicConfig({ app_url: null, registration_invite_required: false }))
            .toEqual({ appUrl: null, registrationInviteRequired: false, srpVersion: null });
    });

    it('is "unknown" (null gate) for garbage, so the sign-up form fails closed', () => {
        expect(parsePublicConfig('<html>')).toEqual({ appUrl: null, registrationInviteRequired: null, srpVersion: null });
        expect(parsePublicConfig({})).toEqual({ appUrl: null, registrationInviteRequired: null, srpVersion: null });
        expect(parsePublicConfig({ registration_invite_required: 'yes' }).registrationInviteRequired).toBeNull();
        // The verifier-version announcement (0.9.3): an integer, else unknown.
        expect(parsePublicConfig({ srp_version: 2 }).srpVersion).toBe(2);
        expect(parsePublicConfig({ srp_version: '2' }).srpVersion).toBeNull();
    });

    it('fetches /config once and caches; a 404 from an old server is "unknown", not a throw', async () => {
        __resetPublicConfigForTest();
        const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        const a = await fetchPublicConfig();
        expect(a).toEqual({ appUrl: null, registrationInviteRequired: null, srpVersion: null });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/config$/);

        // A failed probe is not cached forever: the next caller re-asks…
        fetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ app_url: 'https://app.example.org', registration_invite_required: false }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        const b = await fetchPublicConfig();
        expect(b.appUrl).toBe('https://app.example.org');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // …and a good answer IS cached.
        await fetchPublicConfig();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.unstubAllGlobals();
        __resetPublicConfigForTest();
    });
});
