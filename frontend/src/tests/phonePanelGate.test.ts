/**
 * The voice panel's phone layout has ONE gate (utils/phonePanel.ts). These pin
 * that the JS gate and both stylesheets literally share it, and that the
 * docked mini-player's hidden state collapses its row instead of leaving a
 * blank band — both were review findings on the mobile stream revamp merge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PHONE_PANEL_QUERY, phonePanelQuery } from '../utils/phonePanel';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

describe('phone-panel gate', () => {
    it('VoicePanel.css and mobile.css open their collapse/reservation blocks on the shared query', () => {
        expect(src('components/VoicePanel.css')).toContain(`@media ${PHONE_PANEL_QUERY} {`);
        expect(src('mobile.css')).toContain(`@media ${PHONE_PANEL_QUERY} {`);
    });

    it('VoicePanel reads the gate from the shared module and no longer widens it with the native-shell check', () => {
        const vp = src('components/VoicePanel.tsx');
        expect(vp).toContain("from '../utils/phonePanel'");
        expect(vp).not.toMatch(/isNativeMobile\(\)\s*\|\|/);
    });

    it('returns null where matchMedia does not exist instead of throwing', () => {
        const saved = window.matchMedia;
        // @ts-expect-error — simulating a runtime without matchMedia
        window.matchMedia = undefined;
        try {
            expect(phonePanelQuery()).toBeNull();
        } finally {
            window.matchMedia = saved;
        }
    });
});

describe('docked mini-player hidden state', () => {
    it('is a class that collapses the row, not an inline visibility that keeps it', () => {
        const tsx = src('components/StreamPip.tsx');
        expect(tsx).toContain("docked && hidden ? ' is-hidden' : ''");
        expect(tsx).not.toMatch(/docked\s*\?\s*\(hidden\s*\?\s*\{\s*visibility/);
        const css = src('components/StreamPip.css');
        const rule = css.slice(css.indexOf('.stream-pip.docked.is-hidden {'));
        expect(rule.length).toBeGreaterThan(0);
        const block = rule.slice(0, rule.indexOf('}'));
        expect(block).toMatch(/height:\s*0/);
        expect(block).toMatch(/min-height:\s*0/);
        expect(block).not.toMatch(/display:\s*none/); // a display:none <video> can pause playback
    });
});
