/**
 * ApiError carries the server's MESSAGE, not its wire shape.
 *
 * Handlers answer errors as plain text or as `{"message": "..."}`; every
 * caller that shows `err.message` (SettingsModal's e-mail hint, Login) was
 * printing the braces. Positive control: the first test fails against the
 * old client, which passed the raw body straight through.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiClient, ApiError, errorMessageFromBody, statusOf } from '../api/client';

afterEach(() => vi.unstubAllGlobals());

describe('errorMessageFromBody', () => {
    it('unwraps a JSON message', () => {
        expect(errorMessageFromBody('{"message":"Email service not configured"}', 503)).toBe('Email service not configured');
        expect(errorMessageFromBody('{"error":"Invalid report type"}', 400)).toBe('Invalid report type');
    });
    it('passes plain text through, and never returns an empty string', () => {
        expect(errorMessageFromBody('Already friends', 409)).toBe('Already friends');
        expect(errorMessageFromBody('', 502)).toBe('Request failed with status 502');
        expect(errorMessageFromBody('{not json', 500)).toBe('{not json');
        expect(errorMessageFromBody('{"message":""}', 500)).toBe('{"message":""}');
    });
});

describe('the client', () => {
    it('throws an ApiError whose .message is the unwrapped text and whose .status is flat', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Email service not configured"}', { status: 503 })));
        let caught: unknown;
        try { await apiClient.post('/auth/send-verification', { email: 'x@example.org' }); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).message).toBe('Email service not configured');
        expect((caught as ApiError).message).not.toContain('{');
        expect(statusOf(caught)).toBe(503);
    });

    it('statusOf is undefined for anything that is not a server refusal', () => {
        expect(statusOf(new TypeError('Failed to fetch'))).toBeUndefined();
        expect(statusOf(new Error('x'))).toBeUndefined();
        expect(statusOf({ response: { status: 409 } })).toBeUndefined();   // the axios shape is NOT ours
        expect(statusOf(new ApiError('Already friends', 409))).toBe(409);
    });
});
