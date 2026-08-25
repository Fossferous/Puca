/**
 * Windows virtual-key codes for MOUSE buttons, and the DOM button mapping.
 *
 * Key bindings store a Windows VK code (KeyboardEvent.keyCode under
 * WebView2/Chromium). Mouse buttons have their own VK range 1..6 which no
 * keyboard key ever produces (the lowest real keyboard codes are 3/8/9), so
 * mouse bindings ride the existing KeyBinding shape and the native
 * global-hotkey wire format with NO schema change.
 */

export const VK_LBUTTON = 1;
export const VK_RBUTTON = 2;
export const VK_MBUTTON = 4;
export const VK_XBUTTON1 = 5; // "Mouse 4" / back
export const VK_XBUTTON2 = 6; // "Mouse 5" / forward

/** DOM MouseEvent.button → Windows VK. */
export const BUTTON_TO_VK: Record<number, number> = {
    0: VK_LBUTTON,
    1: VK_MBUTTON,
    2: VK_RBUTTON,
    3: VK_XBUTTON1,
    4: VK_XBUTTON2,
};

export function isMouseVk(keyCode: number): boolean {
    return keyCode === VK_LBUTTON || keyCode === VK_RBUTTON || keyCode === VK_MBUTTON
        || keyCode === VK_XBUTTON1 || keyCode === VK_XBUTTON2;
}

export function mouseVkLabel(vk: number): string {
    switch (vk) {
        case VK_LBUTTON: return 'Mouse 1 (Left)';
        case VK_RBUTTON: return 'Mouse 2 (Right)';
        case VK_MBUTTON: return 'Mouse 3 (Middle)';
        case VK_XBUTTON1: return 'Mouse 4';
        case VK_XBUTTON2: return 'Mouse 5';
        default: return `Mouse (${vk})`;
    }
}
