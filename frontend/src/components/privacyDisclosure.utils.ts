/** Pure helper for PrivacyDisclosure, kept out of the component file so
 *  fast-refresh stays happy and it is unit-testable on its own. */

/** Where the published tree lives when the server does not say. */
export const DEFAULT_REPOSITORY = 'https://github.com/Fossferous/Puca';

/** `<repository>/blob/main/docs/PRIVACY.md` for a forge-shaped repository
 *  URL (GET /source names the operator's — a fork's users land on the fork's
 *  copy); a repository that is not one still gets a link to its root, which
 *  is better than a dead one. */
export function privacyDocUrl(repository: string | null | undefined): string {
    const base = (repository || DEFAULT_REPOSITORY).trim().replace(/\/+$/, '').replace(/\.git$/, '');
    return /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\//.test(base)
        ? `${base}/blob/main/docs/PRIVACY.md`
        : base;
}
