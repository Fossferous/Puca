/**
 * Audio Hub over My Devices: the wire contract's pure half (audioHub.ts).
 *
 * The session-layer gates are driven through the real handlers in
 * deviceSessionAuth.test.ts (host) and deviceAudioHubController.test.ts
 * (controller); the Rust half's HTTP is tested against a mock Audio Hub in
 * src-tauri/src/audio_hub.rs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    AUDIO_HUB_OPS,
    buildAudioHubResult,
    isAudioHubOp,
    isAudioHubRid,
    isToPhone,
    newAudioHubRid,
    parseAudioHubResult,
    NEEDS_UPDATE_MESSAGE,
    NOT_RUNNING_MESSAGE,
    TOKEN_REFUSED_MESSAGE,
} from '../api/devices/audioHub';

const STATUS_BODY = {
    name: 'PC',
    airpods: { on_pc: true, handed_to_phone: false, line: 'AirPods: L 64% · R 66% · Case —' },
    xm6: { on_pc: null, available: true, line: 'XM6: connected' },
    devices: 'Out: Speakers · Mic: AirPods',
};

describe('the allow-list', () => {
    it('is exactly the five calls, nothing more', () => {
        expect([...AUDIO_HUB_OPS]).toEqual(['status', 'airpods-phone', 'airpods-pc', 'xm6-phone', 'xm6-pc']);
    });

    it('refuses anything else, including paths and near misses', () => {
        for (const bad of [
            'pair', '/api/pair', '/api/airpods/phone', 'airpods/phone', 'airpods_phone', 'STATUS',
            'status ', ' status', 'hello', '', null, undefined, 1, {}, ['status'], 'xm6', '../status',
        ]) {
            expect(isAudioHubOp(bad), String(bad)).toBe(false);
        }
        for (const op of AUDIO_HUB_OPS) expect(isAudioHubOp(op)).toBe(true);
    });

    it('is spelled the same in the Rust enum that re-checks it on the PC', () => {
        // Cross-language pin: the host's Tauri command deserialises the op
        // into AudioHubOp (kebab-case). Its own test spells every wire value;
        // a rename on either side fails here or there.
        const rust = readFileSync(resolve(__dirname, '../../src-tauri/src/audio_hub.rs'), 'utf8');
        const test = rust.slice(rust.indexOf('fn ops_deserialize_from_the_controller_spelling'));
        expect(test.length, 'positive control: the Rust test exists').toBeGreaterThan(100);
        for (const op of AUDIO_HUB_OPS) expect(test, op).toContain(`("${op}", AudioHubOp::`);
    });

    it('only the two "to phone" calls open Bluetooth settings', () => {
        expect(AUDIO_HUB_OPS.filter(isToPhone)).toEqual(['airpods-phone', 'xm6-phone']);
    });
});

describe('request ids', () => {
    it('are fresh, well-formed and accepted', () => {
        const a = newAudioHubRid();
        const b = newAudioHubRid();
        expect(a).not.toBe(b);
        expect(isAudioHubRid(a)).toBe(true);
    });

    it('refuse anything that is not a short opaque token', () => {
        for (const bad of ['', 'short', 'a'.repeat(65), 'has space 12345', '<script>12345', 7, null]) {
            expect(isAudioHubRid(bad), String(bad)).toBe(false);
        }
    });
});

describe('the host builds its answer', () => {
    it('says "cannot" when this host has no Audio Hub command', () => {
        expect(buildAudioHubResult('rid-12345678', 'status', null)).toEqual({
            kind: 'audio-hub-result', rid: 'rid-12345678', op: 'status', running: false, unsupported: true,
        });
    });

    it('passes Audio Hub\'s status and JSON through', () => {
        const r = buildAudioHubResult('rid-12345678', 'airpods-pc', {
            running: true, status: 409, body: { ok: false, error: 'no AirPods chosen in Audio Hub yet' },
        });
        expect(r).toEqual({
            kind: 'audio-hub-result', rid: 'rid-12345678', op: 'airpods-pc', running: true, status: 409,
            body: { ok: false, error: 'no AirPods chosen in Audio Hub yet' },
        });
    });

    it('drops an oversized body instead of sealing it', () => {
        const r = buildAudioHubResult('rid-12345678', 'status', {
            running: true, status: 200, body: { line: 'x'.repeat(20_000) },
        });
        expect(r.body).toBeUndefined();
        expect(r.error).toMatch(/too large/);
    });
});

describe('the controller reads the answer', () => {
    it('a status becomes the two headset lines', () => {
        const o = parseAudioHubResult('status', { running: true, status: 200, body: STATUS_BODY });
        expect(o).toEqual({
            kind: 'status',
            status: {
                name: 'PC',
                airpods: { line: 'AirPods: L 64% · R 66% · Case —', onPc: true, handedToPhone: false },
                xm6: { line: 'XM6: connected', onPc: null, available: true },
                devices: 'Out: Speakers · Mic: AirPods',
            },
        });
    });

    it('not running is its own state, whatever else the frame says', () => {
        expect(parseAudioHubResult('status', { running: false, error: "Audio Hub isn't running" }))
            .toEqual({ kind: 'not-running', message: NOT_RUNNING_MESSAGE });
        expect(parseAudioHubResult('airpods-phone', { running: false }))
            .toEqual({ kind: 'not-running', message: NOT_RUNNING_MESSAGE });
    });

    it('a host that cannot reach Audio Hub says to update it', () => {
        expect(parseAudioHubResult('status', { running: false, unsupported: true }))
            .toEqual({ kind: 'unsupported', message: NEEDS_UPDATE_MESSAGE });
    });

    it('a successful hand-over carries Audio Hub\'s message', () => {
        expect(parseAudioHubResult('airpods-phone', {
            running: true, status: 200, body: { ok: true, message: 'The PC let go of the AirPods - connect them on the phone.' },
        })).toEqual({
            kind: 'action', ok: true, httpStatus: 200, error: null,
            message: 'The PC let go of the AirPods - connect them on the phone.',
        });
    });

    it('409 / 503 pass through with Audio Hub\'s own words when it gives them', () => {
        for (const [status, error] of [
            [409, 'no AirPods chosen in Audio Hub yet'], [503, 'FlooCast is not running on the PC'],
        ] as const) {
            const o = parseAudioHubResult('xm6-pc', { running: true, status, body: { ok: false, error } });
            expect(o).toEqual({ kind: 'action', ok: false, httpStatus: status, message: null, error });
        }
    });

    it('401 is always said in Púca\'s words: Audio Hub\'s "not paired" is meant for its own phone app', () => {
        const a = parseAudioHubResult('airpods-phone', { running: true, status: 401, body: { ok: false, error: 'not paired' } });
        expect(a.kind === 'action' && a.error).toBe(TOKEN_REFUSED_MESSAGE);
        const s = parseAudioHubResult('status', { running: true, status: 401, body: { ok: false, error: 'not paired' } });
        expect(s).toEqual({ kind: 'error', message: TOKEN_REFUSED_MESSAGE });
        expect(TOKEN_REFUSED_MESSAGE).not.toContain('paired');
        expect(TOKEN_REFUSED_MESSAGE).toMatch(/same Windows user/);
    });

    it('and with a sentence of ours when it does not', () => {
        const o = parseAudioHubResult('xm6-pc', { running: true, status: 503, body: { ok: false } });
        expect(o.kind === 'action' && o.error).toMatch(/isn't running/);
        const s = parseAudioHubResult('status', { running: true, status: 401, body: { ok: false } });
        expect(s.kind).toBe('error');
    });

    it('a 200 without ok:true is not a success', () => {
        const o = parseAudioHubResult('airpods-pc', { running: true, status: 200, body: { ok: 'yes' } });
        expect(o.kind === 'action' && o.ok).toBe(false);
    });

    it('a status of the wrong shape is reported, not rendered', () => {
        const o = parseAudioHubResult('status', { running: true, status: 200, body: { airpods: 'nope' } });
        expect(o.kind).toBe('error');
    });

    it('a BLANK line is a missing line: the headset is still named', () => {
        // Audio Hub sends "" for the AirPods until its worker reports, and for
        // the XM6 when FlooCast is not installed (status.rs).
        const o = parseAudioHubResult('status', {
            running: true, status: 200,
            body: { ...STATUS_BODY, airpods: { line: '', on_pc: false }, xm6: { line: '   ', on_pc: null, available: false }, devices: '' },
        });
        expect(o.kind).toBe('status');
        if (o.kind !== 'status') return;
        expect(o.status.airpods.line).toBe('AirPods');
        expect(o.status.xm6.line).toBe('XM6');
        expect(o.status.xm6.available).toBe(false);
        expect(o.status.devices).toBeNull();
    });

    it('a blank message or error falls back to words of ours', () => {
        const ok = parseAudioHubResult('xm6-pc', { running: true, status: 200, body: { ok: true, message: '' } });
        expect(ok.kind === 'action' && ok.message).toBeNull();
        const bad = parseAudioHubResult('xm6-pc', { running: true, status: 503, body: { ok: false, error: ' ' } });
        expect(bad.kind === 'action' && bad.error).toMatch(/isn't running/);
    });

    it('clips what the peer sent and keeps only strings', () => {
        const o = parseAudioHubResult('status', {
            running: true, status: 200,
            body: { ...STATUS_BODY, airpods: { line: 'L'.repeat(5000), on_pc: 'true' }, devices: { evil: 1 } },
        });
        expect(o.kind).toBe('status');
        if (o.kind !== 'status') return;
        expect(o.status.airpods.line.length).toBeLessThanOrEqual(300);
        expect(o.status.airpods.onPc).toBeNull();
        expect(o.status.devices).toBeNull();
    });
});
