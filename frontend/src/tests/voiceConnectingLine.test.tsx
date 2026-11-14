/**
 * The voice panel's line says "Connecting…" (data-testid voice-connecting)
 * until the join is done, and only then "Voice Connected" (voice-connected).
 *
 * THE BUG. On an SFU channel VoicePanel set isInVoice before awaiting
 * sfuManager.connect (on purpose: eviction, the roster and the listeners
 * depend on isInVoiceRef flipping early), and the line rendered from
 * isInVoice alone: "Voice Connected", and the voice-connected hook
 * docs/AUTOMATION.md tells an automation to wait for, while LiveKit was still
 * connecting and no media flowed.
 *
 * VoicePanel cannot be mounted under vitest, so the line is its own component
 * (rendered here) and the wiring is read from VoicePanel's source: the line
 * is told the join is under way by the same isConnecting that is set before
 * the join starts and cleared only in its finally, after the SFU connect.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VoiceConnectionLine } from '../components/VoiceConnectionLine';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function line(joining: boolean, extra: Partial<Parameters<typeof VoiceConnectionLine>[0]> = {}) {
    container ??= document.body.appendChild(document.createElement('div'));
    root ??= createRoot(container);
    await act(async () => {
        root!.render(
            <VoiceConnectionLine joining={joining} isAfkChannel={false} micOffByChoice={false} speakDenied={false} listenOnly={false} channelName="Lounge" {...extra}>
                <span className="voice-e2ee">badge</span>
            </VoiceConnectionLine>,
        );
    });
    return container;
}

describe('the voice panel\'s connection line', () => {
    it('THE BUG: while the join is under way it says Connecting…, and voice-connected is NOT on the page', async () => {
        const c = await line(true);
        expect(c.querySelector('[data-testid="voice-connected"]'), 'an automation would share into a call with no media yet').toBeNull();
        const el = c.querySelector('[data-testid="voice-connecting"]');
        expect(el).not.toBeNull();
        expect(el!.textContent).toContain('Connecting…');
        expect(el!.textContent).not.toMatch(/Voice Connected/);
        expect(el!.getAttribute('aria-busy')).toBe('true');
        expect(el!.textContent, 'the call it is joining is named meanwhile').toContain('Lounge');
    });

    it('once the join is done: Voice Connected, voice-connected, and voice-connecting gone', async () => {
        await line(true);
        const c = await line(false);
        const el = c.querySelector('[data-testid="voice-connected"]');
        expect(el).not.toBeNull();
        expect(el!.querySelector('.voice-connected-label')!.textContent).toBe('Voice Connected');
        expect(c.querySelector('[data-testid="voice-connecting"]')).toBeNull();
        expect(el!.hasAttribute('aria-busy')).toBe(false);
        expect(el!.querySelector('.voice-e2ee'), 'the encryption badge stays beside the words').not.toBeNull();
    });

    it('the states a connected call can be in still read as they did', async () => {
        expect((await line(false, { listenOnly: true })).textContent).toContain('Voice Connected · listen-only');
        expect((await line(false, { speakDenied: true })).textContent).toContain("Voice Connected · can't speak");
        expect((await line(false, { micOffByChoice: true })).textContent).toContain('Voice Connected · no microphone');
        expect((await line(false, { isAfkChannel: true })).textContent).toContain('AFK — mic disabled');
        expect((await line(true, { isAfkChannel: true })).textContent, 'joining an AFK channel is joining too').toContain('Connecting…');
    });
});

describe('VoicePanel tells the line the join is under way until it is done', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'VoicePanel.tsx'), 'utf8');
    const join_ = src.slice(src.indexOf('const joinVoice = useCallback('), src.indexOf('// Handle leaving voice'));

    it('the line is drawn with joining={isConnecting}', () => {
        expect(src).toMatch(/<VoiceConnectionLine\s+joining=\{isConnecting\}/);
    });

    it('isConnecting is set before the join, still set across the SFU connect, and cleared only in the join\'s finally', () => {
        expect(join_.length, 'the join was found').toBeGreaterThan(1000);
        const set = join_.indexOf('setIsConnecting(true)');
        const inVoice = join_.indexOf('setIsInVoice(true)');
        const connect = join_.indexOf('await sfuManager.connect(');
        const fin = join_.indexOf('} finally {');
        const cleared = join_.indexOf('setIsConnecting(false)');
        expect(set).toBeGreaterThan(-1);
        expect(set).toBeLessThan(inVoice);
        expect(inVoice, 'isInVoiceRef still flips before the SFU connect').toBeLessThan(connect);
        expect(connect).toBeLessThan(fin);
        expect(cleared, 'cleared before the SFU connect is done: Voice Connected while LiveKit connects').toBeGreaterThan(fin);
        expect(src.split('setIsConnecting(false)').length - 1, 'cleared anywhere else').toBe(1);
    });
});
