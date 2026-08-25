/**
 * Utility Function Tests
 */

import { describe, it, expect } from 'vitest';

describe('File Upload Utilities', () => {
    it('should format file sizes correctly', async () => {
        const { formatFileSize } = await import('../api/uploads');

        expect(formatFileSize(500)).toBe('500 B');
        expect(formatFileSize(1024)).toBe('1.0 KB');
        expect(formatFileSize(1536)).toBe('1.5 KB');
        expect(formatFileSize(1048576)).toBe('1.0 MB');
        expect(formatFileSize(1572864)).toBe('1.5 MB');
        expect(formatFileSize(1073741824)).toBe('1.00 GB');
        expect(formatFileSize(2684354560)).toBe('2.50 GB');
    });

    it('should detect image types correctly', async () => {
        const { isImageType } = await import('../api/uploads');

        expect(isImageType('image/png')).toBe(true);
        expect(isImageType('image/jpeg')).toBe(true);
        expect(isImageType('image/gif')).toBe(true);
        expect(isImageType('image/webp')).toBe(true);
        expect(isImageType('application/pdf')).toBe(false);
        expect(isImageType('text/plain')).toBe(false);
    });
});

describe('Noise Filter Utilities', () => {
    it('should have getRNNoiseState function', async () => {
        const noiseFilter = await import('../api/noiseFilter');

        expect(typeof noiseFilter.getNoiseSuppressionMode).toBe('function');
        expect(typeof noiseFilter.setNoiseSuppressionMode).toBe('function');
        expect(typeof noiseFilter.isNoiseSuppressionEnabled).toBe('function');
    });

    it('should return valid noise suppression modes', async () => {
        const { getNoiseSuppressionMode, setNoiseSuppressionMode } = await import('../api/noiseFilter');

        // Default mode should be one of the valid options
        const mode = getNoiseSuppressionMode();
        expect(['off', 'standard', 'rnnoise', 'deepfilter']).toContain(mode);

        // Set a mode and verify it's saved
        setNoiseSuppressionMode('rnnoise');
        expect(getNoiseSuppressionMode()).toBe('rnnoise');

        // Reset to default
        setNoiseSuppressionMode('standard');
    });
});

describe('Emoji Utilities', () => {
    it('should have common emojis defined', async () => {
        const { QUICK_EMOJIS } = await import('../api/emojis');

        expect(Array.isArray(QUICK_EMOJIS)).toBe(true);
        expect(QUICK_EMOJIS.length).toBeGreaterThan(0);
        expect(QUICK_EMOJIS).toContain('👍');
        expect(QUICK_EMOJIS).toContain('❤️');
    });
});

describe('App version comparison (update prompt)', () => {
    it('detects newer versions and rejects older/equal ones', async () => {
        const { isNewerVersion } = await import('../api/appVersion');

        expect(isNewerVersion('0.5.41', '0.5.40')).toBe(true);
        expect(isNewerVersion('0.6.0', '0.5.40')).toBe(true);
        expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
        expect(isNewerVersion('v0.5.41', '0.5.40')).toBe(true); // tolerates v prefix

        expect(isNewerVersion('0.5.40', '0.5.40')).toBe(false);
        expect(isNewerVersion('0.5.39', '0.5.40')).toBe(false);
        expect(isNewerVersion('0.5.40', '0.5.40.1')).toBe(false); // longer current
        expect(isNewerVersion('0.5.40.1', '0.5.40')).toBe(true);
    });
});
