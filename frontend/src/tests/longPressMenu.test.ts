/**
 * components/longPressMenu.ts: which phones take no text selection on a
 * message (a long press there is Púca's menu). Android only: an iPhone has
 * no long-press menu and copies by selecting, so marking it would leave it no
 * way to copy a message at all.
 */
import { describe, it, expect } from 'vitest';
import { longPressOpensMenu, markLongPressMenu } from '../components/longPressMenu';

const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BP22.250325.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/133.0.6943.137 Mobile Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

describe('a long press is the message menu: Android only', () => {
    it('the Android app and Chrome on Android', () => {
        expect(longPressOpensMenu(ANDROID_APP)).toBe(true);
        expect(longPressOpensMenu(ANDROID_CHROME)).toBe(true);
    });

    it('not an iPhone, an iPad (which says it is a Mac) or a desktop', () => {
        expect(longPressOpensMenu(IPHONE)).toBe(false);
        expect(longPressOpensMenu(IPAD)).toBe(false);
        expect(longPressOpensMenu(DESKTOP)).toBe(false);
    });

    it('marks the page root only where it applies', () => {
        const android = { dataset: {} as DOMStringMap } as HTMLElement;
        markLongPressMenu(android, ANDROID_APP);
        expect(android.dataset.longPressMenu).toBe('');
        const iphone = { dataset: {} as DOMStringMap } as HTMLElement;
        markLongPressMenu(iphone, IPHONE);
        expect('longPressMenu' in iphone.dataset).toBe(false);
    });
});
