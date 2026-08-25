/**
 * UserProfileSettings must survive being opened.
 *
 * It is mounted PERMANENTLY by Chat with `isOpen={showUserSettings}`, which
 * starts false — so its first render takes the `if (!isOpen) return null;`
 * path, and clicking "Edit Profile" is an UPDATE, not a mount. Any hook called
 * below that early return therefore appears only on the second render, and
 * React throws #310 ("Rendered more hooks than during the previous render").
 * The root ErrorBoundary turns that into the whole app being replaced by the
 * crash screen, losing any live call.
 *
 * That shipped as far as a built, signed installer in v0.7.7: adding the
 * authenticated-avatar hook put a useState+useEffect below the early return.
 * tsc, vitest and `npm run build` ALL passed it — only the react-hooks lint
 * rule catches it, and lint is not in the gate list. Hence this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/profile', () => ({
    getProfile: async () => ({
        id: 1, username: 'someone', display_name: null,
        avatar_url: null, allow_dms_from_server_members: true, show_online_status: true,
    }),
    updateProfile: async () => {},
    updateAvatar: async () => {},
}));
vi.mock('../api/uploads', () => ({
    uploadFile: async () => ({ id: 'f1' }),
    getFileUrl: (id: string) => 'http://x/files/' + id,
    discardUpload: () => {},
    isAudioType: (m: string) => m.startsWith('audio/'),
    MAX_SOUND_BYTES: 1024 * 1024,
    formatFileSize: (n: number) => `${n} B`,
}));
vi.mock('../api/authedMedia', () => ({
    fetchFileUrl: async () => null,
    cachedFileUrl: () => null,
    clearFileCache: () => {},
}));

import { UserProfileSettings } from '../components/UserProfileSettings';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('UserProfileSettings hook order', () => {
    it('opens without throwing after first rendering closed', () => {
        // Closed first — exactly how Chat mounts it.
        act(() => {
            root.render(<UserProfileSettings isOpen={false} onClose={() => {}} />);
        });
        expect(container.innerHTML).toBe('');

        // Then opened. A hook below the early return throws here.
        expect(() => {
            act(() => {
                root.render(<UserProfileSettings isOpen={true} onClose={() => {}} />);
            });
        }).not.toThrow();

        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
