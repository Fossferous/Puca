import { describe, it, expect } from 'vitest';
import { defaultSettings } from '../components/settingsStore';
import { BIND_FIELDS, KEYBIND_TAB_ROWS } from '../components/keybindFields';

describe('clip settings', () => {
    it('defaults exist with sane values', () => {
        expect(defaultSettings.clipBufferSeconds).toBe(300);
        expect(defaultSettings.clipQuality).toBe('1080p30');
        expect(defaultSettings.clipMemoryCapMB).toBe(1024);
        expect(defaultSettings.clipMicGain).toBe(100);
        expect(defaultSettings.clipArmOnJoin).toBe('off');
        expect(defaultSettings.clipArmPromptOnJoin).toBe(false); // legacy key, migrated by loadSettings
        expect(defaultSettings.saveClipBinding).toBeNull();
        // Phase 3: the experimental flag is gone; the server's own switch is the only gate.
        expect('experimentalClips' in defaultSettings).toBe(false);
    });
    it('the save-clip binding is in the collision list AND rendered in the Keybinds tab (one list, one place)', () => {
        expect(BIND_FIELDS.map(([f]) => f)).toContain('saveClipBinding');
        expect(KEYBIND_TAB_ROWS.map(([f]) => f)).toContain('saveClipBinding');
        // every tab row is a real binding field
        for (const [f] of KEYBIND_TAB_ROWS) expect(BIND_FIELDS.map(([x]) => x)).toContain(f);
    });
});
