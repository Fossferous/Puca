// @vitest-environment jsdom
/**
 * A press on a setting's words toggles its checkbox (settingsModal.utils'
 * toggleSettingFromRow, wired on SettingsModal's .settings-body).
 *
 * The rows are a <label> naming nothing, a hint and a bare 20px checkbox, so
 * on a phone (where the row stacks into a column) the box alone was the
 * target. The helper must toggle exactly once for a press on the words, and
 * never where the browser already acts or where the row is ambiguous - each
 * of those would be a double toggle or a press changing the wrong setting.
 * e2e/mobile-ui-sweep-walk.mjs ("settings") taps the real rows on the built
 * bundle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { toggleSettingFromRow } from '../components/settingsModal.utils';

function row(html: string): HTMLElement {
    const host = document.createElement('div');
    host.className = 'settings-body';
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}
afterEach(() => { document.body.innerHTML = ''; });

const ONE = `<div class="settings-option"><div class="option-info"><label>Compact Mode</label><span class="option-hint">Reduce spacing</span></div><input type="checkbox"></div>`;

describe('toggleSettingFromRow', () => {
    it('a press on the name toggles the row\'s checkbox, once', () => {
        const host = row(ONE);
        const box = host.querySelector('input') as HTMLInputElement;
        let changes = 0;
        box.addEventListener('change', () => changes++);
        expect(toggleSettingFromRow(host.querySelector('label'))).toBe(true);
        expect(box.checked).toBe(true);
        expect(changes).toBe(1);
        expect(toggleSettingFromRow(host.querySelector('.option-hint'))).toBe(true);
        expect(box.checked).toBe(false);
        expect(changes).toBe(2);
    });

    it('a press on the row\'s padding toggles it too', () => {
        const host = row(ONE);
        expect(toggleSettingFromRow(host.querySelector('.settings-option'))).toBe(true);
        expect((host.querySelector('input') as HTMLInputElement).checked).toBe(true);
    });

    it('a press on the checkbox itself is the browser\'s: no second toggle', () => {
        const host = row(ONE);
        expect(toggleSettingFromRow(host.querySelector('input'))).toBe(false);
        expect((host.querySelector('input') as HTMLInputElement).checked).toBe(false);
    });

    it('a label already tied to its box is the browser\'s', () => {
        const host = row(`<div class="settings-option"><label for="x">Tied</label><input id="x" type="checkbox"></div>`);
        expect(toggleSettingFromRow(host.querySelector('label'))).toBe(false);
        const wrapping = row(`<div class="settings-option"><label><span class="w">Wrapped</span><input type="checkbox"></label></div>`);
        expect(toggleSettingFromRow(wrapping.querySelector('.w'))).toBe(false);
    });

    it('a row with more than one control is left alone', () => {
        const host = row(`<div class="settings-option"><label>Two</label><input type="checkbox"><button>Test</button></div>`);
        expect(toggleSettingFromRow(host.querySelector('label'))).toBe(false);
        expect((host.querySelector('input') as HTMLInputElement).checked).toBe(false);
    });

    it('a row whose one control is not a checkbox is left alone', () => {
        for (const control of ['<select><option>a</option></select>', '<input type="range">', '<input type="text">']) {
            const host = row(`<div class="settings-option"><label>Other</label>${control}</div>`);
            expect(toggleSettingFromRow(host.querySelector('label'))).toBe(false);
        }
    });

    it('a disabled checkbox stays as it is', () => {
        const host = row(`<div class="settings-option"><label>Off</label><input type="checkbox" disabled></div>`);
        expect(toggleSettingFromRow(host.querySelector('label'))).toBe(false);
        expect((host.querySelector('input') as HTMLInputElement).checked).toBe(false);
    });

    it('a press that ended selecting the row\'s words is copying, not choosing: nothing toggles', () => {
        const host = row(ONE);
        const hint = host.querySelector('.option-hint') as HTMLElement;
        const box = host.querySelector('input') as HTMLInputElement;
        const range = document.createRange();
        range.setStart(hint.firstChild as Text, 2);
        range.setEnd(hint.firstChild as Text, 9);
        const sel = document.getSelection() as Selection;
        sel.removeAllRanges();
        sel.addRange(range);
        expect(toggleSettingFromRow(hint)).toBe(false);
        expect(box.checked).toBe(false);
        // CONTROL: the same press once the selection is gone does toggle.
        sel.removeAllRanges();
        expect(toggleSettingFromRow(hint)).toBe(true);
        expect(box.checked).toBe(true);
    });

    it('a selection somewhere else on the page does not stop a press on this row', () => {
        const host = row(`<p class="far">Words elsewhere on the page</p>${ONE}`);
        const far = host.querySelector('.far') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(far);
        const sel = document.getSelection() as Selection;
        sel.removeAllRanges();
        sel.addRange(range);
        expect(toggleSettingFromRow(host.querySelector('label'))).toBe(true);
        sel.removeAllRanges();
    });

    it('a press outside every row, or on nothing, does nothing', () => {
        const host = row(`<p class="loose">Not a row</p>${ONE}`);
        expect(toggleSettingFromRow(host.querySelector('.loose'))).toBe(false);
        expect(toggleSettingFromRow(null)).toBe(false);
        expect((host.querySelector('input') as HTMLInputElement).checked).toBe(false);
    });
});
